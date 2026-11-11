'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AlertManager } = require('../alert-manager');
const { resumirSaude } = require('../health');
const { persistirHorasFechadas, persistirTodasHoras } = require('../hourly-store');

test('queda só vence depois do atraso configurado', () => {
  const alerts = new AlertManager({ downDelayMin: 5 });
  alerts.registrarQueda('10.0.0.1', { name: 'Switch' }, 'sem resposta', 1000);
  assert.equal(alerts.vencidas(1000 + 4 * 60000).length, 0);
  assert.equal(alerts.vencidas(1000 + 5 * 60000).length, 1);
  alerts.marcarNotificada('10.0.0.1');
  assert.equal(alerts.vencidas(1000 + 6 * 60000).length, 0);
});

test('recuperação antes do atraso cancela o alerta e não envia retorno isolado', () => {
  const alerts = new AlertManager({ downDelayMin: 5 });
  alerts.registrarQueda('10.0.0.2', { name: 'AP' }, 'sem resposta', 1000);
  assert.equal(alerts.registrarRecuperacao('10.0.0.2'), false);
  assert.equal(alerts.vencidas(1000 + 10 * 60000).length, 0);
});

test('recuperação informa se a queda já havia sido notificada', () => {
  const alerts = new AlertManager({ downDelayMin: 1 });
  alerts.registrarQueda('10.0.0.3', { name: 'Servidor' }, 'sem resposta', 1000);
  assert.equal(alerts.vencidas(61000).length, 1);
  alerts.marcarNotificada('10.0.0.3');
  assert.equal(alerts.registrarRecuperacao('10.0.0.3'), true);
  assert.equal(alerts.registrarRecuperacao('10.0.0.3'), false);
});

test('detecta oscilação após o limite de quedas na janela', () => {
  const alerts = new AlertManager({
    downDelayMin: 5, flapThreshold: 3, flapWindowMin: 60, flapCooldownMin: 120,
  });
  const device = { name: 'AP' };
  assert.equal(alerts.registrarQueda('10.0.0.4', device, 'queda', 1000).oscilando, false);
  alerts.registrarRecuperacao('10.0.0.4');
  assert.equal(alerts.registrarQueda('10.0.0.4', device, 'queda', 10 * 60000).oscilando, false);
  alerts.registrarRecuperacao('10.0.0.4');
  const result = alerts.registrarQueda('10.0.0.4', device, 'queda', 20 * 60000);
  assert.equal(result.oscilando, true);
  assert.equal(result.quedasNaJanela, 3);
});

test('saúde geral considera serviço TCP, dependências e instabilidade', () => {
  const devices = [
    { status: 'online' },
    { status: 'online', porta: 8088, portaOk: false },
    { status: 'instavel' },
    { status: 'dependente' },
    { status: 'offline' },
  ];
  assert.deepEqual(resumirSaude(devices, true), {
    nivel: 'critical', total: 5, online: 2, offline: 1,
    dependentes: 1, instaveis: 1, desconhecidos: 0, servicos: 1,
  });
  assert.equal(resumirSaude([{ status: 'online' }], false).nivel, 'unknown');
  assert.equal(resumirSaude([{ status: 'desconhecido' }]).nivel, 'unknown');
  assert.equal(resumirSaude([{ status: 'online', porta: 80, portaOk: false }]).nivel, 'critical');
});

test('grava horas encerradas e mantém a hora corrente em memória', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'netwatch-hours-'));
  const file = path.join(dir, 'hours.jsonl');
  const hours = new Map([
    ['a|2026-11-11T09', { ip: '10.0.0.1', h: '2026-11-11T09', env: 3 }],
    ['a|2026-11-11T10', { ip: '10.0.0.1', h: '2026-11-11T10', env: 6 }],
  ]);
  const archive = [];
  try {
    assert.equal(persistirHorasFechadas(hours, archive, file, '2026-11-11T10'), 1);
    assert.equal(hours.size, 1);
    assert.equal(archive.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8').trim()).h, '2026-11-11T09');
    assert.equal(persistirTodasHoras(hours, file), 1);
    assert.equal(hours.size, 0);
    assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('não descarta horas da memória se a gravação falhar', () => {
  const hours = new Map([['a|old', { ip: '10.0.0.1', h: 'old' }]]);
  assert.throws(() => persistirHorasFechadas(hours, [], '/diretorio-inexistente/hours.jsonl', 'now'));
  assert.equal(hours.size, 1);
});
