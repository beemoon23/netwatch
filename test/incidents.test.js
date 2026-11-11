'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { IncidentStore } = require('../incidents');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'netwatch-incidents-'));
  return { dir, file: path.join(dir, 'incidents.jsonl') };
}

test('persiste abertura e recupera incidente após reinicialização', () => {
  const { dir, file } = fixture();
  try {
    let now = 1_000_000;
    new IncidentStore(file, { now: () => now }).open({
      device: 'Switch A', ip: '10.0.0.1', sector: 'Infra', inicio: now,
      causa: 'Sem resposta', causaTipo: 'indisponibilidade', confianca: 'baixa'
    });
    now += 120_000;
    const [incident] = new IncidentStore(file, { now: () => now }).list();
    assert.equal(incident.status, 'open');
    assert.equal(incident.device, 'Switch A');
    assert.equal(incident.minutos, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('não duplica incidente aberto e atualiza causa provável', () => {
  const { dir, file } = fixture();
  try {
    const store = new IncidentStore(file, { now: () => 10_000 });
    const first = store.open({ device: 'AP', ip: '10.0.0.2', causa: 'Sem resposta' });
    const second = store.open({ device: 'AP', ip: '10.0.0.2',
      causa: 'Switch upstream indisponível', causaTipo: 'dependencia', confianca: 'alta' });
    assert.equal(first.id, second.id);
    assert.equal(store.list().length, 1);
    assert.equal(store.list()[0].causaTipo, 'dependencia');
    assert.equal(store.list()[0].tipo, 'queda');
    assert.equal(new IncidentStore(file).list()[0].causa, 'Switch upstream indisponível');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('registra encerramento e calcula duração', () => {
  const { dir, file } = fixture();
  try {
    let now = 50_000;
    const store = new IncidentStore(file, { now: () => now });
    store.open({ device: 'Servidor', ip: '10.0.0.3', inicio: now });
    now += 300_000;
    store.resolve('10.0.0.3', now, 'Servidor voltou a responder');
    const [incident] = new IncidentStore(file, { now: () => now }).list();
    assert.equal(incident.status, 'resolved');
    assert.equal(incident.fim, now);
    assert.equal(incident.minutos, 5);
    assert.equal(incident.motivoResolucao, 'Servidor voltou a responder');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ignora linhas JSON inválidas sem perder registros válidos', () => {
  const { dir, file } = fixture();
  try {
    new IncidentStore(file).open({ device: 'AP', ip: '10.0.0.4' });
    fs.appendFileSync(file, 'linha quebrada\n');
    assert.equal(new IncidentStore(file).list().length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('importa eventos antigos uma única vez e preserva quedas abertas', () => {
  const { dir, file } = fixture();
  try {
    const legacy = path.join(dir, 'events.jsonl');
    const events = [
      { level: 'offline', at: 1000, device: 'AP', ip: '10.0.0.5', sector: 'Lazer' },
      { level: 'online', at: 121000, device: 'AP', ip: '10.0.0.5', sector: 'Lazer' },
      { level: 'offline', at: 200000, device: 'Switch', ip: '10.0.0.6', sector: 'Infra' }
    ];
    fs.writeFileSync(legacy, events.map(JSON.stringify).join('\n') + '\n');
    const store = new IncidentStore(file);
    assert.equal(store.migrateLegacy(legacy), true);
    const items = store.list();
    assert.equal(items.length, 2);
    assert.equal(items.find(item => item.ip === '10.0.0.5').status, 'resolved');
    assert.equal(items.find(item => item.ip === '10.0.0.6').status, 'open');
    assert.equal(items.find(item => item.ip === '10.0.0.6').causaTipo, 'legado');
    const restored = new IncidentStore(file);
    assert.equal(restored.migrateLegacy(legacy), false);
    assert.equal(restored.list().length, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
