#!/usr/bin/env node
'use strict';
/**
 * link-monitor.js — monitor de qual link de internet está ativo (principal/backup).
 * Compara o IP público atual com os dois IPs conhecidos e avisa no Telegram
 * quando detecta uma troca. Sem dependências, mesmo padrão do netwatch.js.
 *
 *   node link-monitor.js
 */

const fs = require('fs');
const path = require('path');

// IPs conhecidos dos dois links (ajuste aqui se mudar o provedor/IP)
const LINKS = {
  '187.195.161.210': 'PRINCIPAL',
  '45.172.202.38': 'BACKUP',
};

// Serviços usados para descobrir o IP público atual — tenta em ordem,
// caso um esteja fora do ar
const IP_CHECK_SERVICES = [
  'https://api.ipify.org?format=json',
  'https://ifconfig.me/all.json',
  'https://checkip.amazonaws.com',
];

const INTERVAL_SEC = Number(process.env.LINK_MONITOR_INTERVAL_SEC || 60);

// Telegram: mesmo bot/token do netwatch.js, mesmo grupo
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '';
const TELEGRAM_CHAT = process.env.TELEGRAM_CHAT || '';

const STATE_FILE = path.resolve(process.env.LINK_MONITOR_STATE || './link-monitor-state.json');
const EVT_FILE = path.resolve(process.env.LINK_MONITOR_EVENTS || './link-monitor-events.jsonl');

const ICONE = { queda: '🔴', volta: '🟢', desconhecido: '⚠️' };

// o Markdown do Telegram quebra com esses caracteres soltos — mesma função do netwatch.js
const escaparMd = (t) => String(t).replace(/([_*\[\]`])/g, '\\$1');

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString('pt-BR')}] ${msg}`);
}

function lerEstado() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null; // primeira execução
  }
}

function salvarEstado(estado) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(estado, null, 2));
  } catch (e) {
    log(`ERRO ao salvar state file: ${e.message}`);
  }
}

function registrarEvento(evento) {
  try {
    fs.appendFileSync(EVT_FILE, JSON.stringify(evento) + '\n');
  } catch (e) {
    log(`ERRO ao gravar evento: ${e.message}`);
  }
}

async function getPublicIp() {
  for (const url of IP_CHECK_SERVICES) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!resp.ok) continue;
      const texto = (await resp.text()).trim();
      if (texto.startsWith('{')) {
        const dados = JSON.parse(texto);
        if (dados.ip) return dados.ip.trim();
      } else if (texto) {
        return texto;
      }
    } catch (e) {
      log(`falha ao consultar ${url}: ${e.message}`);
    }
  }
  return null;
}

async function avisarTelegram(nivel, mensagem) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) return;

  const texto =
    `${ICONE[nivel] || '•'} *${escaparMd('Link de internet')}*\n` +
    `${escaparMd(mensagem)}\n\n` +
    `_${new Date().toLocaleString('pt-BR')}_`;

  try {
    const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT, text: texto, parse_mode: 'Markdown' }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) log(`telegram respondeu ${r.status}: ${(await r.text()).slice(0, 200)}`);
    else log('alerta enviado no telegram.');
  } catch (e) {
    log(`não consegui avisar no telegram: ${e.message}`);
  }
}

async function checar() {
  const ipAtual = await getPublicIp();

  if (!ipAtual) {
    log('não foi possível descobrir o IP público atual (todos os serviços falharam).');
    return;
  }

  const linkAtual = LINKS[ipAtual] || `desconhecido (${ipAtual})`;
  const anterior = lerEstado();

  log(`IP público atual: ${ipAtual} -> link: ${linkAtual}`);

  // primeira execução: só registra, sem alertar (evita alerta falso no start)
  if (!anterior) {
    log('primeira checagem — registrando estado inicial sem alertar.');
    salvarEstado({ ip: ipAtual, link: linkAtual, desde: Date.now() });
    return;
  }

  if (ipAtual === anterior.ip) return; // nada mudou

  let nivel = 'desconhecido';
  if (linkAtual === 'PRINCIPAL') nivel = 'volta';
  else if (linkAtual === 'BACKUP') nivel = 'queda';

  const mensagem = nivel === 'volta'
    ? `voltou pro principal (${ipAtual}) depois de estar em ${anterior.link} (${anterior.ip})`
    : nivel === 'queda'
      ? `principal caiu — backup assumiu (${ipAtual}), estava em ${anterior.link} (${anterior.ip})`
      : `mudou de ${anterior.link} (${anterior.ip}) para ${linkAtual}, IP não reconhecido`;

  log(`mudança detectada: ${anterior.link} -> ${linkAtual}`);
  await avisarTelegram(nivel, mensagem);

  registrarEvento({
    at: Date.now(),
    de: anterior.link, deIp: anterior.ip,
    para: linkAtual, paraIp: ipAtual,
  });

  salvarEstado({ ip: ipAtual, link: linkAtual, desde: Date.now() });
}

async function main() {
  log(`link-monitor iniciado (intervalo: ${INTERVAL_SEC}s)`);
  if (TELEGRAM_TOKEN && TELEGRAM_CHAT) log('telegram ativo');
  else log('telegram desligado (defina TELEGRAM_TOKEN e TELEGRAM_CHAT)');

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await checar();
    } catch (e) {
      log(`erro inesperado na checagem: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, INTERVAL_SEC * 1000));
  }
}

main();
