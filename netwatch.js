#!/usr/bin/env node
'use strict';
/**
 * netwatch.js — monitor de APs e Switches por ICMP. Sem API, sem 2FA, sem nuvem.
 * Node 18+, macOS. Servidor preso em 127.0.0.1.
 *
 *   node netwatch.js     # lê devices.json -> http://localhost:8787
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const CFG_FILE = path.resolve(process.env.NETWATCH_CFG || './devices.json');
const EVT_FILE = path.resolve(process.env.NETWATCH_EVENTS || './netwatch-events.jsonl');
const HORA_FILE = path.resolve(process.env.NETWATCH_HORAS || './netwatch-horas.jsonl');
const PORT = Number(process.env.PORT || 8787);
// 127.0.0.1 = só esta máquina. 0.0.0.0 = qualquer um da rede interna alcança.
const BIND = process.env.NETWATCH_BIND || '127.0.0.1';
// Senha opcional. Sem NETWATCH_PASS definido, o painel roda aberto como antes.
const USUARIO = process.env.NETWATCH_USER || 'vale';
const SENHA = process.env.NETWATCH_PASS || '';

if (!fs.existsSync(CFG_FILE)) {
  console.error(`Não achei ${CFG_FILE}.`);
  process.exit(1);
}
const CFG = Object.assign({
  intervalSec: 60,        // uma rodada leva ~45s com 73 aparelhos; não baixe muito
  failThreshold: 3,       // rodadas seguidas sem resposta antes de alertar
  rebootWindowMin: 5,     // voltou dentro disso = reinício
  historySize: 60,
  concurrency: 10,        // pings simultâneos — mais que isso vira rajada
  janelaInstavel: 20,     // rodadas analisadas para julgar instabilidade
  perdaInstavel: 20,      // % de perda na janela que caracteriza link instável
  perdaEstavel: 5,        // % abaixo do qual o link é considerado recuperado
  avisarInstavelMin: 60,  // não repetir o aviso de instabilidade antes disso
  anchorIp: null,         // gateway; null = detecta sozinho
}, JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')));

// ---------------------------------------------------------------- ping

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// O ping mora em lugares diferentes e o -W muda de unidade entre os sistemas.
const PING = ['/usr/bin/ping', '/bin/ping', '/sbin/ping'].find((p) => fs.existsSync(p)) || 'ping';
const LINUX = process.platform === 'linux';
// macOS espera milissegundos no -W; Linux espera segundos.
const ESPERA = LINUX ? '2' : '1000';

// 3 pacotes: só conta falha se os três se perderem.
function ping(ip) {
  return new Promise((resolve) => {
    execFile(PING, ['-c', '3', '-W', ESPERA, '-n', ip], { timeout: 12000 }, (_e, out = '') => {
      // macOS diz "3 packets received"; Linux diz "3 received". Aceita os dois.
      const recv = /(\d+)\s+(?:packets\s+)?received/.exec(out);
      const avg = /=\s*[\d.]+\/([\d.]+)\//.exec(out);
      const got = recv ? Number(recv[1]) : 0;
      resolve({ ok: got > 0, ms: avg ? Math.round(Number(avg[1]) * 10) / 10 : null, recv: got });
    });
  });
}

// Servidor pode pingar e estar com o serviço morto. A porta é quem diz a verdade.
function checarPorta(ip, porta, timeout = 3000) {
  return new Promise((resolve) => {
    const net = require('net');
    const s = new net.Socket();
    let pronto = false;
    const fim = (ok) => { if (pronto) return; pronto = true; s.destroy(); resolve(ok); };
    s.setTimeout(timeout);
    s.once('connect', () => fim(true));
    s.once('timeout', () => fim(false));
    s.once('error', () => fim(false));
    s.connect(porta, ip);
  });
}

// Fila: no máximo N pings ao mesmo tempo, com jitter pra não sincronizar.
async function fila(itens, n, fn) {
  const it = itens[Symbol.iterator]();
  await Promise.all(Array.from({ length: n }, async () => {
    for (const item of it) {
      await sleep(Math.random() * 250);
      await fn(item);
    }
  }));
}

function detectarGateway() {
  return new Promise((resolve) => {
    if (CFG.anchorIp) return resolve(CFG.anchorIp);
    if (LINUX) {
      execFile('ip', ['route', 'show', 'default'], (_e, out = '') => {
        const m = /default via ([\d.]+)/.exec(out);
        resolve(m ? m[1] : null);
      });
      return;
    }
    execFile('/sbin/route', ['-n', 'get', 'default'], (_e, out = '') => {
      const m = /gateway:\s*([\d.]+)/.exec(out);
      resolve(m ? m[1] : null);
    });
  });
}

// ---------------------------------------------------------------- estado

const state = new Map();
let events = [];
let lastRun = null;
let anchorIp = null;
let anchorOk = true;
const silencio = new Map();   // setor -> timestamp em que o silêncio expira
const horas = new Map();      // "ip|horaISO" -> consolidado da hora corrente
let arquivo = [];             // consolidados de horas passadas, lidos do disco

const chaveHora = (t) => new Date(t).toISOString().slice(0, 13);

function acumular(d, r) {
  const k = d.ip + '|' + chaveHora(Date.now());
  const a = horas.get(k) || { ip: d.ip, h: chaveHora(Date.now()), env: 0, perd: 0, ms: 0, n: 0, quedas: 0 };
  a.env += 3;
  a.perd += 3 - r.recv;
  if (r.ms != null) { a.ms += r.ms; a.n++; }
  horas.set(k, a);
}

function contarQueda(d) {
  const k = d.ip + '|' + chaveHora(Date.now());
  const a = horas.get(k);
  if (a) a.quedas++;
}

// Fecha as horas que já passaram e grava no disco.
function fecharHoras() {
  const atual = chaveHora(Date.now());
  const prontas = [...horas.entries()].filter(([, a]) => a.h !== atual);
  if (!prontas.length) return;
  const linhas = prontas.map(([, a]) => JSON.stringify(a)).join('\n') + '\n';
  fs.appendFile(HORA_FILE, linhas, () => {});
  prontas.forEach(([k, a]) => { arquivo.push(a); horas.delete(k); });
}

// Disponibilidade de uma janela de horas: disco + hora corrente.
function disponibilidade(janela = 24) {
  const corte = chaveHora(Date.now() - janela * 3600e3);
  const soma = {};
  for (const a of [...arquivo, ...horas.values()]) {
    if (a.h < corte) continue;
    const s = soma[a.ip] || (soma[a.ip] = { env: 0, perd: 0, ms: 0, n: 0, quedas: 0 });
    s.env += a.env; s.perd += a.perd; s.ms += a.ms; s.n += a.n; s.quedas += a.quedas;
  }
  const saida = {};
  for (const [ip, s] of Object.entries(soma)) {
    if (!s.env) continue;
    saida[ip] = {
      pct: Math.round((1 - s.perd / s.env) * 1000) / 10,
      ms: s.n ? Math.round((s.ms / s.n) * 10) / 10 : null,
      quedas: s.quedas,
      horas: Math.round(s.env / 3 / (60 / (CFG.intervalSec / 60)) * 10) / 10,
    };
  }
  return saida;
}

// Um incidente é uma queda com seu retorno. É o que vira linha de relatório.
function incidentes() {
  const abertos = {}, lista = [];
  for (const ev of [...events].reverse()) {          // dos mais antigos para os novos
    if (ev.level === 'offline') {
      abertos[ev.ip] = { device: ev.device, ip: ev.ip, sector: ev.sector, inicio: ev.at };
    } else if ((ev.level === 'online' || ev.level === 'reboot') && abertos[ev.ip]) {
      const a = abertos[ev.ip];
      lista.push({ ...a, fim: ev.at, minutos: Math.max(1, Math.round((ev.at - a.inicio) / 60000)),
                   tipo: ev.level === 'reboot' ? 'reinício' : 'queda' });
      delete abertos[ev.ip];
    }
  }
  for (const d of state.values()) {
    if ((d.status === 'offline' || d.status === 'dependente') && d.downSince) {
      lista.push({ device: d.name, ip: d.ip, sector: d.sector || '—', inicio: d.downSince,
                   fim: null, minutos: Math.max(1, Math.round((Date.now() - d.downSince) / 60000)),
                   tipo: d.status === 'dependente' ? 'dependência' : 'queda' });
    }
  }
  return lista.sort((a, b) => (b.fim === null) - (a.fim === null) || b.inicio - a.inicio);
}

const perdaJanela = (d) => {
  const j = d.history.slice(-CFG.janelaInstavel);
  if (j.length < Math.min(8, CFG.janelaInstavel)) return 0;
  return (j.filter((v) => v === null).length / j.length) * 100;
};

const silenciado = (setor) => (silencio.get(setor) || 0) > Date.now();

for (const d of CFG.devices) {
  state.set(d.ip, Object.assign({
    status: 'desconhecido', fails: 0, ms: null, since: null,
    downSince: null, sent: 0, lost: 0, history: [],
  }, d));
}

// Consolidados por hora sobrevivem a restart; guardamos 7 dias.
try {
  const corte = chaveHora(Date.now() - 7 * 24 * 3600e3);
  arquivo = fs.readFileSync(HORA_FILE, 'utf8').trim().split('\n').filter(Boolean)
    .map(JSON.parse).filter((a) => a.h >= corte);
} catch { /* primeira execução */ }

// Histórico sobrevive a restart do Node.
try {
  events = fs.readFileSync(EVT_FILE, 'utf8').trim().split('\n').filter(Boolean)
    .slice(-300).map(JSON.parse).reverse();
} catch { /* primeira execução */ }

function registrar(level, dev, message) {
  const setor = dev.sector || '—';
  const mudo = silenciado(setor);
  const ev = { at: Date.now(), level, device: dev.name, ip: dev.ip, sector: setor, message, mudo };
  events.unshift(ev);
  events.length = Math.min(events.length, 300);
  fs.appendFile(EVT_FILE, JSON.stringify(ev) + '\n', () => {});
  console.log(`[${new Date(ev.at).toLocaleTimeString('pt-BR')}] ${level.toUpperCase()} ${dev.name} — ${message}${mudo ? ' (silenciado)' : ''}`);

  // Em manutenção o evento fica registrado, mas não interrompe ninguém.
  if (mudo) return;
  // Notificação nativa só existe no macOS; no Linux o registro fica no journal.
  if (!LINUX) {
    const esc = (s) => String(s).replace(/["\\]/g, '');
    execFile('osascript', ['-e',
      `display notification "${esc(message)}" with title "Rede" subtitle "${esc(dev.name)}" sound name "Submarine"`,
    ], () => {});
  }
}

const minutos = (ms) => Math.max(1, Math.round(ms / 60000));

async function rodada() {
  // Âncora: se o gateway não responde, quem está sem rede é este Mac.
  if (anchorIp) {
    const a = await ping(anchorIp);
    if (!a.ok) {
      if (anchorOk) registrar('monitor', { name: 'Monitor', ip: anchorIp },
        'gateway não respondeu — rodada ignorada para não gerar alarme falso');
      anchorOk = false;
      lastRun = Date.now();
      return;
    }
    if (!anchorOk) registrar('monitor', { name: 'Monitor', ip: anchorIp }, 'rede do monitor normalizada');
    anchorOk = true;
  }

  // Fase 1 — mede todo mundo antes de julgar qualquer coisa.
  await fila([...state.values()], CFG.concurrency, async (d) => {
    const r = await ping(d.ip);
    d.sent += 3;
    d.lost += 3 - r.recv;
    d.ms = r.ok ? r.ms : null;
    d.history.push(r.ok ? (r.ms ?? 0) : null);
    if (d.history.length > CFG.historySize) d.history.shift();
    d.fails = r.ok ? 0 : d.fails + 1;
    d.okAgora = r.ok;
    acumular(d, r);

    if (d.porta) {
      const viva = await checarPorta(d.ip, d.porta);
      if (d.portaOk === true && !viva) {
        d.portaFalhas = (d.portaFalhas || 0) + 1;
        if (d.portaFalhas >= 2) {
          d.portaOk = false;
          registrar('servico', d, `${d.servico || 'serviço'} não respondeu na porta ${d.porta} — a máquina está no ar`);
        }
      } else if (viva) {
        if (d.portaOk === false) registrar('online', d, `${d.servico || 'serviço'} voltou na porta ${d.porta}`);
        d.portaOk = true;
        d.portaFalhas = 0;
      } else if (d.portaOk === undefined) {
        d.portaOk = viva;
        if (!viva) registrar('servico', d, `${d.servico || 'serviço'} não respondeu na porta ${d.porta}`);
      }
    }
  });

  // Fase 2 — decide. Pais primeiro: um filho só é julgado depois do switch dele.
  const agora = Date.now();
  const caiu = (d) => d.fails >= CFG.failThreshold;
  const ordem = [...state.values()].sort((a, b) => (a.parent ? 1 : 0) - (b.parent ? 1 : 0));

  for (const d of ordem) {
    if (d.okAgora) {
      const perda = perdaJanela(d);

      if (d.status === 'online' || d.status === 'instavel' || d.status === 'desconhecido') {
        // Link que responde mas perde pacotes demais: ninguém vê, e é o que mais incomoda hóspede.
        if (perda >= CFG.perdaInstavel) {
          if (d.status !== 'instavel') { d.status = 'instavel'; d.since = agora; d.avisado = 0; }
          if (agora - (d.avisado || 0) > CFG.avisarInstavelMin * 60000) {
            d.avisado = agora;
            registrar('instavel', d, `perdendo ${Math.round(perda)}% dos pacotes — responde, mas o link está ruim`);
          }
        } else if (d.status === 'instavel' && perda <= CFG.perdaEstavel) {
          d.status = 'online'; d.since = agora; d.avisado = 0;
          registrar('online', d, 'link normalizado');
        } else if (d.status !== 'instavel') {
          d.status = 'online'; d.since = d.since || agora;
        }
        continue;
      }
      if (d.status === 'offline') {
        const fora = d.downSince ? agora - d.downSince : 0;
        const reinicio = fora <= CFG.rebootWindowMin * 60000;
        registrar(reinicio ? 'reboot' : 'online', d,
          `voltou depois de ${minutos(fora)} min fora${reinicio ? ' — provável reinício' : ''}`);
      }
      d.status = 'online';
      d.since = agora;
      d.downSince = null;
      continue;
    }

    if (!caiu(d) || d.status === 'offline' || d.status === 'dependente') continue;

    // O switch pai também está fora? Então a causa é ele, não este aparelho.
    const pai = d.parent ? state.get(d.parent) : null;
    if (pai && (pai.status === 'offline' || pai.status === 'dependente')) {
      d.status = 'dependente';
      d.downSince = agora;
      d.since = agora;
      continue;
    }

    d.status = 'offline';
    d.downSince = agora;
    d.since = agora;
    contarQueda(d);
    const filhos = [...state.values()].filter((f) => f.parent === d.ip && !f.okAgora).length;
    registrar('offline', d, filhos
      ? `${d.fails} rodadas sem resposta — ${filhos} aparelhos abaixo dele também pararam`
      : `${d.fails} rodadas sem resposta (${d.fails * 3} pacotes)`);
  }

  lastRun = Date.now();
}

// ---------------------------------------------------------------- dashboard

const PAGE = `<!doctype html><html lang="pt-BR"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Vale Encantado — estado da rede</title>
<style>
  :root{
    --fundo:#04181a; --painel:#0a262a; --casca:#0e3035; --linha:#164047;
    --texto:#e4f4f2; --suave:#6f9ea1;
    --teal:#16b0bd; --folha:#8cc63f; --laranja:#f7941d; --ceu:#29abe2;
    --brasa:#ef4a3c; --jacaranda:#a98cf0;
    --script:"Snell Roundhand","Apple Chancery","Brush Script MT",cursive;
    --titulo:"Avenir Next",Avenir,"Segoe UI",sans-serif;
    --mono:ui-monospace,"SF Mono",Menlo,monospace;
  }
  *{box-sizing:border-box}
  body{margin:0;background:
      radial-gradient(1100px 520px at 82% -8%, rgba(22,176,189,.16), transparent 62%),
      radial-gradient(760px 400px at 4% 4%, rgba(140,198,63,.10), transparent 60%),
      var(--fundo);
    color:var(--texto);font:14px/1.55 var(--mono);padding-bottom:70px;
    -webkit-font-smoothing:antialiased}
  .env{padding:0 26px}

  /* ---------- topo ---------- */
  .topo{display:flex;justify-content:space-between;align-items:center;gap:24px;
        flex-wrap:wrap;padding:20px 0 18px}
  .marca{display:flex;align-items:center;gap:20px}
  .marca img{width:104px;height:104px;flex:none;object-fit:contain;
    background:#fff;border-radius:16px;padding:9px;
    box-shadow:0 6px 22px rgba(0,0,0,.32)}
  .marca svg.mk{width:96px;height:96px;flex:none}
  .marca .nm{font:italic 400 46px/.95 var(--script);color:#fff;letter-spacing:.01em}
  .marca .sb{font:600 11px/1 var(--titulo);letter-spacing:.44em;color:var(--teal);
             text-transform:uppercase;margin-top:11px}

  /* faixa fina no topo: dá pra ver o estado de longe, sem ler nada */
  .pulso{position:fixed;top:0;left:0;right:0;height:4px;z-index:60;background:var(--folha);
    transition:background .4s}
  .pulso.mal{background:var(--brasa);animation:respira 1.8s ease-in-out infinite}
  .pulso.aten{background:var(--laranja)}
  @keyframes respira{50%{opacity:.35}}
  @media (prefers-reduced-motion:reduce){.pulso.mal{animation:none}}
  .agora{text-align:right;font-size:12px;color:var(--suave)}
  .agora .hh{font:600 30px/1 var(--titulo);color:var(--texto);letter-spacing:.02em;
             font-variant-numeric:tabular-nums}

  /* ---------- herói ---------- */
  .heroi{display:grid;grid-template-columns:1fr auto;gap:26px;align-items:center;
    background:linear-gradient(120deg, rgba(10,38,42,.96), rgba(14,48,53,.72));
    border:1px solid var(--linha);border-radius:14px;padding:26px 30px;margin-bottom:16px;
    position:relative;overflow:hidden}
  .heroi::after{content:"";position:absolute;right:-90px;top:-90px;width:280px;height:280px;
    border-radius:50%;background:radial-gradient(circle,rgba(22,176,189,.20),transparent 68%)}
  .estado{font:600 clamp(34px,5.4vw,62px)/1 var(--titulo);letter-spacing:-.02em;margin:0}
  .estado.bem{color:var(--folha)} .estado.mal{color:var(--brasa)}
  .legenda{color:var(--suave);font-size:13px;margin-top:12px;max-width:62ch;line-height:1.6}
  .legenda b{color:var(--texto);font-weight:600}
  .petalas{display:flex;gap:12px;position:relative;z-index:1}
  .pet{background:none;border:0;padding:0;cursor:pointer;text-align:center;font:inherit}
  .pet:focus-visible{outline:2px solid var(--teal);outline-offset:4px;border-radius:8px}
  .pet svg{display:block;width:62px;height:62px;margin:0 auto}
  .pet .rt{font:600 9.5px/1.3 var(--titulo);letter-spacing:.16em;text-transform:uppercase;
           color:var(--suave);margin-top:7px}
  .pet[data-on=true] .rt{color:var(--texto)}
  .pet .vl{font:600 13px/1 var(--titulo);color:var(--texto);margin-top:3px;
           font-variant-numeric:tabular-nums}

  /* ---------- abas ---------- */
  nav{display:flex;gap:8px;flex-wrap:wrap;margin:18px 0 16px}
  nav button{background:transparent;border:1px solid var(--linha);color:var(--suave);
    border-radius:999px;padding:7px 17px;font:600 11px/1 var(--titulo);letter-spacing:.1em;
    text-transform:uppercase;cursor:pointer;transition:.15s}
  nav button:hover{color:var(--texto);border-color:var(--teal)}
  nav button[aria-pressed=true]{background:var(--teal);border-color:var(--teal);color:#03191b}
  nav button:focus-visible{outline:2px solid var(--teal);outline-offset:2px}
  nav .ct{color:var(--brasa)}
  nav button[aria-pressed=true] .ct{color:#03191b}

  .busca{display:flex;gap:10px;align-items:center;margin:0 0 16px;flex-wrap:wrap}
  .busca input{flex:1;min-width:200px;background:var(--painel);border:1px solid var(--linha);
    color:var(--texto);border-radius:999px;padding:10px 18px;font:inherit;font-size:12.5px}
  .busca input::placeholder{color:var(--suave)}
  .busca input:focus{outline:none;border-color:var(--teal)}
  .baixar{background:var(--casca);border:1px solid var(--linha);color:var(--texto);
    border-radius:999px;padding:10px 18px;font:600 11px/1 var(--titulo);letter-spacing:.1em;
    text-transform:uppercase;cursor:pointer;text-decoration:none;display:inline-block}
  .baixar:hover{border-color:var(--teal);color:var(--teal)}
  .baixar[aria-pressed=true]{background:var(--teal);border-color:var(--teal);color:#03191b}
  .inc{display:grid;grid-template-columns:1fr auto;gap:2px 10px;font-size:11.5px;padding:7px 0;
       border-bottom:1px solid #12333a}
  .inc:last-child{border:0}
  .inc .q{grid-column:1/-1;color:var(--suave);font-size:10px}
  .inc b{font-variant-numeric:tabular-nums;font-weight:600;color:var(--suave)}
  .inc.aberto b{color:var(--brasa)}
  .inc.reinicio b{color:var(--laranja)}

  h2.sec{font:600 11px/1 var(--titulo);letter-spacing:.28em;text-transform:uppercase;
    color:var(--suave);margin:26px 0 14px;display:flex;align-items:center;gap:14px}
  h2.sec::after{content:"";flex:1;height:1px;background:var(--linha)}

  /* ---------- constelações ---------- */
  .const{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(238px,1fr))}
  .hub{background:var(--painel);border:1px solid var(--linha);border-radius:12px;padding:10px 10px 14px}
  .hub svg{display:block;width:100%;height:auto}
  .hub .hn{text-align:center;font-size:11px;color:var(--texto);font-weight:600;margin-top:6px;
           line-height:1.3}
  .hub .hq{text-align:center;font-size:10px;color:var(--suave);letter-spacing:.08em;
           text-transform:uppercase;margin-top:3px}
  .hub.solto{background:linear-gradient(160deg,var(--painel),#0c2a2d)}
  .legc{display:flex;gap:16px;flex-wrap:wrap;font-size:10.5px;color:var(--suave);
        margin:-4px 0 14px}
  .legc span{display:flex;align-items:center;gap:6px}
  .legc i{width:9px;height:9px;border-radius:50%;display:inline-block}

  /* primeiros segundos: ainda não há medição */
  .card.desconhecido .nome{opacity:.75}
  .medindo{color:var(--suave);font-size:11.5px;padding:14px 0}

  /* ---------- mapa de calor ---------- */
  .calor{background:var(--painel);border:1px solid var(--linha);border-radius:12px;padding:16px 18px}
  .calor .cab{display:flex;justify-content:space-between;align-items:center;gap:16px;
    flex-wrap:wrap;margin-bottom:14px}
  .escala{display:flex;align-items:center;gap:7px;font-size:10.5px;color:var(--suave)}
  .escala i{width:16px;height:10px;border-radius:2px;display:inline-block}
  .linhas{display:grid;grid-template-columns:minmax(120px,190px) 1fr;gap:3px 12px;align-items:center}
  .rot{font-size:10.5px;color:var(--suave);white-space:nowrap;overflow:hidden;
       text-overflow:ellipsis;text-align:right}
  .rot.ruim{color:var(--brasa);font-weight:600}
  .faixa-c{display:flex;gap:1.5px;height:13px}
  .cel{flex:1;border-radius:1.5px;min-width:2px;background:#0d2a2e}
  .tempo{grid-column:2;display:flex;justify-content:space-between;font-size:10px;
         color:var(--suave);margin-top:6px}

  /* ---------- 7 dias ---------- */
  .sete{background:var(--painel);border:1px solid var(--linha);border-radius:12px;padding:16px 18px}
  .sete .linhas{display:grid;grid-template-columns:minmax(120px,190px) 1fr;gap:3px 12px;align-items:center}
  .sete .faixa-c{height:12px;gap:1px}
  .dias{grid-column:2;display:flex;justify-content:space-between;font-size:10px;
        color:var(--suave);margin-top:7px}

  /* ---------- modo TV ---------- */
  body.tv{padding:0;overflow:hidden}
  body.tv .env{padding:26px 34px}
  body.tv .cols,body.tv .calor,body.tv .sete,body.tv nav,body.tv .busca,
  body.tv h2.sec:not(#tconst){display:none}
  body.tv #tconst{font-size:14px;letter-spacing:.3em;margin:30px 0 18px}
  body.tv .marca .nm{font-size:66px}
  body.tv .marca img{width:150px;height:150px;border-radius:22px;padding:13px}
  body.tv .marca svg.mk{width:140px;height:140px}
  body.tv .agora .hh{font-size:46px}
  body.tv .estado{font-size:clamp(48px,7.4vw,104px)}
  body.tv .legenda{font-size:19px;max-width:none}
  body.tv .heroi{padding:38px 42px;border-radius:20px}
  body.tv .pet svg{width:92px;height:92px}
  body.tv .pet .rt{font-size:12px}
  body.tv .const{grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:18px}
  body.tv .hub .hn{font-size:14px}
  body.tv .hub .hq{font-size:11.5px}
  .tvsel{position:fixed;bottom:20px;right:24px;font:600 12px/1 var(--titulo);letter-spacing:.2em;
    text-transform:uppercase;color:var(--suave);background:var(--painel);border:1px solid var(--linha);
    border-radius:999px;padding:11px 20px;display:none}
  body.tv .tvsel{display:block}

  /* ---------- cards ---------- */
  .cols{display:grid;gap:16px;grid-template-columns:1fr 288px;align-items:start}
  @media (max-width:980px){.cols{grid-template-columns:1fr}
    .heroi{grid-template-columns:1fr}.petalas{flex-wrap:wrap;justify-content:center}}
  .grid{display:grid;gap:10px;grid-template-columns:repeat(auto-fill,minmax(248px,1fr))}
  .card{background:var(--painel);border:1px solid var(--linha);border-radius:10px;
        padding:14px 16px 12px;position:relative;overflow:hidden}
  .card::before{content:"";position:absolute;inset:0 auto 0 0;width:3px;background:var(--folha)}
  .card.offline::before{background:var(--brasa)}
  .card.dependente::before{background:var(--jacaranda)}
  .card.instavel::before{background:var(--laranja)}
  .card.desconhecido::before{background:var(--suave)}
  .card.mudo{opacity:.48}
  .nome{display:flex;justify-content:space-between;gap:9px;align-items:flex-start;
        font:600 13px/1.35 var(--titulo)}
  .nome .esq{display:flex;gap:9px;align-items:flex-start;min-width:0}
  .ico{width:15px;height:15px;flex:none;margin-top:2px;opacity:.75}
  .online .ico{color:var(--folha)} .offline .ico{color:var(--brasa)}
  .instavel .ico{color:var(--laranja)} .dependente .ico{color:var(--jacaranda)}
  .desconhecido .ico{color:var(--suave)}

  .tipos{display:flex;gap:20px;flex-wrap:wrap;margin-top:16px}
  .tipos div{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--suave)}
  .tipos b{font:600 20px/1 var(--titulo);color:var(--texto);font-variant-numeric:tabular-nums}
  .tipos svg{width:16px;height:16px;opacity:.6}

  .compacto .card{padding:9px 12px}
  .compacto .card svg:not(.ico){display:none}
  .compacto .card .via,.compacto .card .selo{display:none}
  .compacto .card dl{grid-template-columns:1fr auto auto;gap:0 14px;margin-top:6px}
  .compacto .card dt{display:none}
  .compacto .card dd{text-align:left;color:var(--suave);font-size:11px}
  .compacto .grid{grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:6px}
  .compacto .nome{font-size:12px}
  .pt{width:8px;height:8px;border-radius:50%;flex:none;margin-top:5px;background:var(--folha);
      box-shadow:0 0 9px rgba(140,198,63,.55)}
  .offline .pt{background:var(--brasa);box-shadow:0 0 12px rgba(239,74,60,.7);animation:bate 1.5s infinite}
  .dependente .pt{background:var(--jacaranda);box-shadow:none}
  .instavel .pt{background:var(--laranja);box-shadow:0 0 10px rgba(247,148,29,.65)}
  .desconhecido .pt{background:var(--suave);box-shadow:none}
  @keyframes bate{50%{opacity:.2}}
  @media (prefers-reduced-motion:reduce){.pt{animation:none!important}}
  .selo{display:inline-block;margin-top:8px;font:600 9.5px/1 var(--titulo);letter-spacing:.12em;
        text-transform:uppercase;padding:4px 8px;border-radius:999px}
  .selo.dep{color:var(--jacaranda);border:1px solid #3d3663}
  .selo.man{color:var(--laranja);border:1px solid #55401b}
  .selo.ins{color:var(--laranja);border:1px solid #55401b}
  .selo.svc{color:var(--brasa);border:1px solid #5c2820}
  .abrir{display:inline-block;margin-top:9px;font-size:10.5px;color:var(--teal);
    text-decoration:none;border-bottom:1px solid transparent}
  .abrir:hover{border-bottom-color:var(--teal)}
  .ev.servico{border-left-color:var(--brasa)}
  .det .box .v small{font-size:11px;font-weight:400;color:var(--suave);display:block;margin-top:2px}
  dl{display:grid;grid-template-columns:auto 1fr;gap:2px 12px;margin:11px 0 0;font-size:11.5px}
  dt{color:var(--suave)} dd{margin:0;text-align:right;font-variant-numeric:tabular-nums}
  .via{margin-top:9px;font-size:10.5px;color:var(--suave)}
  .card svg{display:block;width:100%;height:24px;margin-top:9px}

  /* ---------- detalhe ---------- */
  .card{cursor:pointer;transition:border-color .15s,transform .15s}
  .card:hover{border-color:#2a5c63;transform:translateY(-1px)}
  .veu{position:fixed;inset:0;background:rgba(2,12,14,.72);backdrop-filter:blur(3px);
    display:none;align-items:center;justify-content:center;padding:24px;z-index:50}
  .veu[data-on=true]{display:flex}
  .det{background:var(--painel);border:1px solid var(--linha);border-radius:16px;
    max-width:660px;width:100%;max-height:88vh;overflow:auto;padding:26px 30px}
  .det h3{font:600 21px/1.25 var(--titulo);margin:0 0 4px}
  .det .ipn{color:var(--suave);font-size:12.5px}
  .det .fecha{float:right;background:none;border:1px solid var(--linha);color:var(--suave);
    border-radius:999px;width:32px;height:32px;font:inherit;font-size:15px;cursor:pointer;line-height:1}
  .det .fecha:hover{color:var(--texto);border-color:var(--teal)}
  .det .grade{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px;
    margin:20px 0 6px}
  .det .box{background:var(--casca);border-radius:9px;padding:12px 14px}
  .det .box .k{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--suave)}
  .det .box .v{font:600 19px/1.2 var(--titulo);margin-top:5px;font-variant-numeric:tabular-nums}
  .det h4{font:600 10px/1 var(--titulo);letter-spacing:.24em;text-transform:uppercase;
    color:var(--suave);margin:24px 0 11px}
  .det .cad{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:12.5px}
  .det .cad span{background:var(--casca);border-radius:7px;padding:6px 11px}
  .det .cad em{font-style:normal;color:var(--suave)}
  .det .faixa-c{display:flex;gap:1px;height:16px}
  .det .cel{flex:1;border-radius:1.5px;min-width:1px;background:#0d2a2e}
  .det .dias{display:flex;justify-content:space-between;font-size:10px;color:var(--suave);margin-top:6px}

  /* ---------- lateral ---------- */
  aside section{background:var(--painel);border:1px solid var(--linha);border-radius:10px;
    padding:14px 16px;margin-bottom:12px}
  aside h2{font:600 10px/1 var(--titulo);letter-spacing:.26em;text-transform:uppercase;
    color:var(--suave);margin:0 0 13px}
  .lat{display:flex;justify-content:space-between;gap:10px;font-size:11.5px;padding:5px 0;
       border-bottom:1px solid #12333a}
  .lat:last-child{border:0}
  .lat i{font-style:normal;color:var(--laranja);font-variant-numeric:tabular-nums}
  .dp{display:grid;grid-template-columns:1fr auto;gap:2px 10px;font-size:11.5px;padding:6px 0;
      border-bottom:1px solid #12333a}
  .dp:last-child{border:0}
  .dp .q{grid-column:1/-1;color:var(--suave);font-size:10px}
  .dp b{font-variant-numeric:tabular-nums;font-weight:600}
  .dp b.ruim{color:var(--brasa)} .dp b.meio{color:var(--laranja)} .dp b.bom{color:var(--folha)}
  .man{display:flex;gap:6px}
  .man button{flex:1;background:var(--casca);border:1px solid var(--linha);color:var(--texto);
    border-radius:7px;padding:9px 4px;font:600 11px/1 var(--titulo);cursor:pointer}
  .man button:hover{border-color:var(--laranja);color:var(--laranja)}
  .man button:focus-visible{outline:2px solid var(--laranja);outline-offset:2px}
  .manon{color:var(--laranja);font-size:11.5px;margin-bottom:11px;line-height:1.45}
  .ev{padding:9px 0 9px 12px;border-left:2px solid var(--linha);margin-bottom:8px;font-size:11.5px}
  .ev.offline{border-left-color:var(--brasa)}
  .ev.reboot{border-left-color:var(--laranja)}
  .ev.instavel{border-left-color:var(--laranja)}
  .ev.online{border-left-color:var(--folha)}
  .ev.monitor{border-left-color:var(--ceu)}
  .ev b{display:block;font-weight:600}
  .ev .q{color:var(--suave);font-size:10.5px;margin-top:3px}
  .vazio{color:var(--suave);font-size:11.5px;line-height:1.55}

  /* ---------- telas pequenas ---------- */
  @media (max-width:640px){
    .env{padding:0 14px}
    .marca .nm{font-size:32px} .marca{gap:13px}
    .marca img{width:68px;height:68px;border-radius:12px;padding:6px}
    .marca svg.mk{width:62px;height:62px}
    .agora{text-align:left} .agora .hh{font-size:24px}
    .topo{padding:16px 0 12px}
    .heroi{padding:20px;grid-template-columns:1fr}
    .estado{font-size:30px} .legenda{font-size:12.5px}
    .petalas{flex-wrap:wrap;justify-content:flex-start} .pet svg{width:52px;height:52px}
    .grid{grid-template-columns:1fr} .const{grid-template-columns:1fr 1fr}
    .linhas{grid-template-columns:76px 1fr;gap:2px 7px} .rot{font-size:9px}
    .calor,.sete{padding:12px 10px}
    .escala{display:none}
    .det{padding:20px 18px;border-radius:12px} .veu{padding:10px}
  }
</style>

<div class="pulso" id="pulso"></div>
<div class="env">
  <div class="topo">
    <div class="marca">
      <img id="logo" src="/logo" alt="" onerror="this.replaceWith(petala())">
      <div><div class="nm">Vale Encantado</div><div class="sb">Eco Park &amp; Hotel</div></div>
    </div>
    <div class="agora"><div class="hh" id="hh">--:--</div><span id="rodada">—</span></div>
  </div>

  <div class="heroi">
    <div><h1 class="estado" id="estado">…</h1><div class="legenda" id="legenda"></div></div>
    <div class="petalas" id="petalas"></div>
  </div>

  <nav id="abas"></nav>
  <div class="busca">
    <input id="q" type="search" placeholder="Buscar por nome ou IP — ex: quarto 117, camping, 27.78.96">
    <button class="baixar" id="denso" aria-pressed="false">Modo compacto</button>
    <a class="baixar" href="/relatorio.csv">Baixar relatório</a>
  </div>

  <h2 class="sec" id="tconst">Constelações — como os aparelhos se penduram uns nos outros</h2>
  <div class="legc">
    <span><i style="background:var(--folha)"></i>no ar</span>
    <span><i style="background:var(--laranja)"></i>link instável</span>
    <span><i style="background:var(--jacaranda)"></i>parado por queda do switch</span>
    <span><i style="background:var(--brasa)"></i>fora do ar</span>
    <span><i style="background:var(--suave)"></i>ainda medindo</span>
  </div>
  <div class="const" id="const"></div>

  <h2 class="sec">Mapa de calor — cada coluna é uma rodada de ping</h2>
  <div class="calor">
    <div class="cab">
      <div id="calorq" class="vazio"></div>
      <div class="escala">
        <span>rápido</span>
        <i style="background:#2b8f57"></i><i style="background:#8cc63f"></i>
        <i style="background:#e8d34a"></i><i style="background:#f7941d"></i>
        <span>lento</span>
        <i style="background:var(--brasa);margin-left:10px"></i><span>sem resposta</span>
      </div>
    </div>
    <div class="linhas" id="calor"></div>
  </div>

  <h2 class="sec">Últimos 7 dias — disponibilidade hora a hora</h2>
  <div class="sete">
    <div class="cab" style="display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:14px">
      <div id="seteq" class="vazio"></div>
      <div class="escala"><span>0%</span>
        <i style="background:var(--brasa)"></i><i style="background:#f7941d"></i>
        <i style="background:#e8d34a"></i><i style="background:#8cc63f"></i><i style="background:#2b8f57"></i>
        <span>100%</span>
        <i style="background:#0d2a2e;margin-left:10px"></i><span>sem dado</span>
      </div>
    </div>
    <div class="linhas" id="sete"></div>
  </div>

  <h2 class="sec">Aparelhos</h2>
  <div class="cols">
    <div class="grid" id="grid"></div>
    <aside>
      <section><h2>Manutenção</h2><div id="man"></div></section>
      <section><h2>Incidentes</h2><div id="inc"></div></section>
      <section><h2>Disponibilidade 24 h</h2><div id="disp"></div></section>
      <section><h2>Maior latência</h2><div id="lat"></div></section>
      <section><h2>Histórico</h2><div id="log"></div></section>
    </aside>
  </div>
</div>
<div class="tvsel" id="tvsel"></div>
<div class="veu" id="veu" data-on="false"><div class="det" id="det"></div></div>

<script>
let setor = 'Todos', dados = null, longo = null, busca = '', detalhe = null;
const TV = new URLSearchParams(location.search).has('tv');
if (TV) document.body.classList.add('tv');
const CORES = ['var(--teal)','var(--folha)','var(--laranja)','var(--ceu)','#5ed6a8','#d6c65e'];
const hora = t => new Date(t).toLocaleString('pt-BR');
const relogio = t => new Date(t).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
const desde = t => { if(!t) return '—';
  const m = Math.floor((Date.now()-t)/60000);
  return m<60 ? m+'m' : m<1440 ? Math.floor(m/60)+'h '+(m%60)+'m' : Math.floor(m/1440)+'d'; };
const esc = s => String(s).replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
const sec = d => d.sector || 'Sem setor';
const cor = st => st==='offline' ? 'var(--brasa)' : st==='dependente' ? 'var(--jacaranda)'
              : st==='instavel' ? 'var(--laranja)' : st==='online' ? 'var(--folha)' : 'var(--suave)';

// marca de pétalas, usada quando não existe logo.png na pasta
function petala(){
  const g = document.createElementNS('http://www.w3.org/2000/svg','svg');
  g.setAttribute('class','mk'); g.setAttribute('viewBox','0 0 100 100');
  g.innerHTML = CORES.slice(0,5).map((c,i)=>{
    const a = i*72-90;
    return '<ellipse cx="50" cy="26" rx="12" ry="23" fill="'+c+'" opacity=".92" transform="rotate('+a+' 50 50)"/>';
  }).join('')+'<circle cx="50" cy="50" r="8" fill="#04181a"/>';
  return g;
}

function anel(pct, cor1, n){
  const r=26, c=2*Math.PI*r, on=c*pct;
  return '<svg viewBox="0 0 62 62"><circle cx="31" cy="31" r="'+r+'" fill="none" stroke="#123238" stroke-width="6"/>'+
    '<circle cx="31" cy="31" r="'+r+'" fill="none" stroke="'+cor1+'" stroke-width="6" stroke-linecap="round" '+
    'stroke-dasharray="'+on.toFixed(1)+' '+c.toFixed(1)+'" transform="rotate(-90 31 31)"/>'+
    '<text x="31" y="36" text-anchor="middle" font-size="15" font-weight="700" fill="'+cor1+'" '+
    'font-family="Avenir Next,sans-serif">'+n+'</text></svg>';
}

function serra(h){
  if(!h.length) return '';
  const vals=h.filter(v=>v!==null), max=Math.max(8,...vals), w=100/Math.max(h.length-1,1);
  const pts=h.map((v,i)=> v===null?null:[i*w, 22-(v/max)*19]);
  let d='',ab=false;
  for(const p of pts){ if(!p){ab=false;continue;} d+=(ab?'L':'M')+p[0].toFixed(1)+' '+p[1].toFixed(1)+' '; ab=true; }
  const bur=pts.map((p,i)=>p?null:i).filter(i=>i!==null).map(i=>
    '<rect x="'+(i*w-w/2).toFixed(1)+'" y="0" width="'+w.toFixed(1)+'" height="24" fill="var(--brasa)" opacity=".3"/>').join('');
  return '<svg viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">'+bur+
    '<path d="'+d+'" fill="none" stroke="var(--folha)" stroke-width="1.1" vector-effect="non-scaling-stroke" opacity=".85"/></svg>';
}

function constelacao(hub, filhos){
  const n=filhos.length, R=64, cx=100, cy=100;
  const raios=filhos.map((f,i)=>{
    const a=(i/n)*2*Math.PI-Math.PI/2, x=cx+R*Math.cos(a), y=cy+R*Math.sin(a);
    return {f,x,y};
  });
  return '<svg viewBox="0 0 200 200" role="img" aria-label="'+esc(hub.name)+'">'+
    raios.map(p=>'<line x1="'+cx+'" y1="'+cy+'" x2="'+p.x.toFixed(1)+'" y2="'+p.y.toFixed(1)+
      '" stroke="'+(p.f.status==='online'?'#1b4c52':'var(--brasa)')+'" stroke-width="1.4"/>').join('')+
    (hub.status!=='online' ? '<circle cx="100" cy="100" r="30" fill="'+cor(hub.status)+'" opacity=".18"/>' : '')+
    '<circle cx="100" cy="100" r="19" fill="var(--casca)" stroke="'+cor(hub.status)+'" stroke-width="2.5"/>'+
    '<text x="100" y="105" text-anchor="middle" font-size="15" fill="'+cor(hub.status)+
      '" font-family="Avenir Next,sans-serif" font-weight="700">'+n+'</text>'+
    raios.map(p=>'<circle cx="'+p.x.toFixed(1)+'" cy="'+p.y.toFixed(1)+'" r="8" fill="'+cor(p.f.status)+
      '" opacity="'+(p.f.status==='online'?'.9':'1')+'"><title>'+esc(p.f.name)+'</title></circle>').join('')+
    '</svg>';
}

// escala de calor: verde-folha para rápido, âmbar para lento, brasa para pacote perdido
function calorDe(v){
  if (v === null || v === undefined) return 'var(--brasa)';
  if (v <= 2)  return '#2b8f57';
  if (v <= 5)  return '#8cc63f';
  if (v <= 10) return '#e8d34a';
  if (v <= 20) return '#f7941d';
  return '#ef7a3c';
}

// Painel de detalhe: tudo o que se sabe de um aparelho, num lugar só.
function pintarDetalhe(){
  const veu = document.getElementById('veu');
  if (!detalhe || !dados) { veu.dataset.on = 'false'; return; }
  const d = dados.devices.find(x=>x.ip===detalhe);
  if (!d) { veu.dataset.on='false'; detalhe=null; return; }
  veu.dataset.on = 'true';

  const nomes = Object.fromEntries(dados.devices.map(x=>[x.ip,x.name]));
  const disp = dados.disp[d.ip];
  const filhos = dados.devices.filter(x=>x.parent===d.ip);
  const meus = dados.incidentes.filter(i=>i.ip===d.ip);
  const v = longo && longo.dados[d.ip];
  const perda = d.sent ? Math.round(d.lost/d.sent*100) : 0;
  const rotulo = { online:'no ar', offline:'fora do ar', instavel:'link instável',
                   dependente:'parado por queda do switch', desconhecido:'ainda medindo' }[d.status];
  const dur = m => m<60 ? m+' min' : Math.floor(m/60)+'h '+(m%60)+'min';

  // cadeia até o topo: AP -> switch -> switch principal
  const cadeia = []; let p = d.parent;
  while (p && nomes[p] && cadeia.length < 4) {
    cadeia.push(nomes[p]);
    p = (dados.devices.find(x=>x.ip===p)||{}).parent;
  }

  document.getElementById('det').innerHTML =
    '<button class="fecha" id="fecha" aria-label="Fechar">&times;</button>'+
    '<h3>'+icone(d.type).replace('class="ico"','class="ico" style="width:19px;height:19px"')+
      ' '+esc(d.name)+'</h3>'+
    '<div class="ipn">'+esc(d.type||'aparelho')+' · '+d.ip+' · '+esc(sec(d))+
      ' · <span style="color:'+cor(d.status)+'">'+rotulo+'</span></div>'+
    '<div class="grade">'+
      '<div class="box"><div class="k">latência</div><div class="v">'+(d.ms!=null?d.ms+' ms':'—')+'</div></div>'+
      '<div class="box"><div class="k">perda na sessão</div><div class="v">'+perda+'%</div></div>'+
      '<div class="box"><div class="k">24 h</div><div class="v">'+(disp?disp.pct+'%':'—')+'</div></div>'+
      '<div class="box"><div class="k">'+(d.status==='online'?'estável há':'assim há')+'</div><div class="v">'+desde(d.since)+'</div></div>'+
      (d.porta ? '<div class="box"><div class="k">'+esc(d.servico||'serviço')+'</div><div class="v" style="color:'+
        (d.portaOk===false?'var(--brasa)':'var(--folha)')+'">'+(d.portaOk===false?'fora':'no ar')+
        '<small>porta '+d.porta+'</small></div></div>' : '')+
    '</div>'+
    (d.porta ? '<a class="abrir" href="http'+(d.porta===443?'s':'')+'://'+d.ip+
      (d.porta===80||d.porta===443?'':':'+d.porta)+'" target="_blank" rel="noopener">Abrir '+
      esc(d.servico||'serviço')+' &rarr;</a>' : '')+
    (cadeia.length||filhos.length
      ? '<h4>Caminho na rede</h4><div class="cad">'+
        '<span>'+esc(d.name)+'</span>'+
        cadeia.map(n=>'<em>&rarr;</em><span>'+esc(n)+'</span>').join('')+
        (filhos.length?'<em style="width:100%">'+filhos.length+' aparelhos dependem deste:</em>'+
          filhos.map(f=>'<span style="color:'+cor(f.status)+'">'+esc(f.name)+'</span>').join(''):'')+
        '</div>' : '')+
    (v && v.some(x=>x!==null)
      ? '<h4>Últimos 7 dias</h4><div class="faixa-c">'+
        v.map(p=>'<i class="cel" style="background:'+corDisp(p)+'" title="'+
          (p===null?'sem dado':p+'%')+'"></i>').join('')+'</div>'+
        '<div class="dias"><span>7 dias atrás</span><span>agora</span></div>' : '')+
    '<h4>Incidentes deste aparelho</h4>'+
    (meus.length
      ? meus.slice(0,6).map(i=>'<div class="inc'+(i.fim?'':' aberto')+'"><span>'+i.tipo+'</span>'+
          '<b>'+dur(i.minutos)+'</b><span class="q">'+
          new Date(i.inicio).toLocaleString('pt-BR')+(i.fim?'':' · em curso')+'</span></div>').join('')
      : '<p class="vazio">Nenhuma queda registrada.</p>');

  document.getElementById('fecha').onclick = fecharDetalhe;
}
function fecharDetalhe(){ detalhe=null; pintarDetalhe(); }

function relogioTopo(s){
  document.getElementById('hh').textContent = relogio(Date.now());
  document.getElementById('rodada').textContent =
    s.lastRun ? 'rodada às '+new Date(s.lastRun).toLocaleTimeString('pt-BR') : 'aguardando';
}

// glifos por tipo: dá pra varrer o painel sem ler nome
const GLIFO = {
  ap:'<path d="M8 13.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"/><path d="M4.6 8.1a4.8 4.8 0 0 1 6.8 0M2 5.5a8.5 8.5 0 0 1 12 0" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  switch:'<rect x="1.5" y="5" width="13" height="6.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M4 8h.01M6.5 8h.01M9 8h.01M11.5 8h.01" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  servidor:'<rect x="2" y="2" width="12" height="5" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="2" y="9" width="12" height="5" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M4.4 4.5h.01M4.4 11.5h.01" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  central:'<path d="M3.5 2.5h2.2l1.1 2.8-1.4 1a8 8 0 0 0 4.3 4.3l1-1.4 2.8 1.1v2.2a1 1 0 0 1-1.1 1C6.6 13 3 9.4 2.5 3.6a1 1 0 0 1 1-1.1z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>',
};
function tipoDe(t){
  const x = (t||'').toLowerCase();
  if (x.includes('switch')) return 'switch';
  if (x.includes('servidor')) return 'servidor';
  if (x.includes('central')) return 'central';
  return 'ap';
}
const icone = (t) => '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true">'+GLIFO[tipoDe(t)]+'</svg>';
const PLURAL = { ap:['ponto de acesso','pontos de acesso'], switch:['switch','switches'],
                 servidor:['servidor','servidores'], central:['central','centrais'] };

// escala da disponibilidade horária
function corDisp(p){
  if (p === null || p === undefined) return '#0d2a2e';
  if (p >= 99) return '#2b8f57';
  if (p >= 95) return '#8cc63f';
  if (p >= 85) return '#e8d34a';
  if (p >= 50) return '#f7941d';
  return 'var(--brasa)';
}

// a aba do navegador vira indicador: dá pra saber o estado sem abrir
function marcarAba(off, ins){
  const p = document.getElementById('pulso');
  p.className = 'pulso' + (off ? ' mal' : ins ? ' aten' : '');
  const c = off ? '#ef4a3c' : ins ? '#f7941d' : '#8cc63f';
  document.title = (off ? '● ' + off + ' fora do ar' : ins ? '● ' + ins + ' instável' : '● tudo no ar')
    + ' · Vale Encantado';
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
    + '<circle cx="16" cy="16" r="13" fill="' + c + '"/></svg>';
  let l = document.querySelector('link[rel=icon]');
  if (!l) { l = document.createElement('link'); l.rel = 'icon'; document.head.appendChild(l); }
  l.href = 'data:image/svg+xml,' + encodeURIComponent(svg);
}

function pintarLongo(lista, nomes){
  if (!longo) return;
  const dados = longo.dados, N = longo.horas;
  const comDado = lista.filter(d=>dados[d.ip] && dados[d.ip].some(v=>v!==null));
  document.getElementById('seteq').innerHTML = comDado.length
    ? '<b style="color:var(--texto)">'+comDado.length+'</b> aparelhos com histórico gravado · '+
      'cada quadradinho é uma hora · o arquivo guarda 7 dias'
    : 'Ainda sem histórico gravado. A primeira hora fecha no virar do relógio.';
  document.getElementById('sete').innerHTML = comDado.map(d=>{
    const v = dados[d.ip];
    const ruim = v.some(x=>x!==null && x<95);
    return '<div class="rot'+(ruim?' ruim':'')+'" title="'+esc(d.name)+'">'+esc(d.name)+'</div>'+
      '<div class="faixa-c">'+v.map((p,i)=>'<i class="cel" style="background:'+corDisp(p)+
        '" title="'+(p===null?'sem dado':p+'% de resposta')+'"></i>').join('')+'</div>';
  }).join('') + (comDado.length
    ? '<div class="dias"><span>7 dias atrás</span><span>3 dias</span><span>ontem</span><span>agora</span></div>'
    : '');
}

let assinatura = '';
// Aparelhos sem uplink conhecido não cabem numa constelação — viram constelação própria.
function nebulosa(nome, itens){
  const col = 7, lin = Math.ceil(itens.length/col);
  const larg = 200, pad = 22, passo = (larg-pad*2)/(col-1);
  const alt = Math.max(90, 46 + lin*20);
  return '<svg viewBox="0 0 200 '+alt+'" role="img" aria-label="'+esc(nome)+'">'+
    '<text x="100" y="22" text-anchor="middle" font-size="13" fill="var(--suave)" '+
      'font-family="Avenir Next,sans-serif" font-weight="600">'+itens.length+'</text>'+
    itens.map((d,i)=>{
      const x = pad + (i%col)*passo, y = 42 + Math.floor(i/col)*20;
      return '<circle cx="'+x.toFixed(1)+'" cy="'+y+'" r="6.5" fill="'+cor(d.status)+
        '" opacity="'+(d.status==='online'?'.82':'1')+'"><title>'+esc(d.name)+'</title></circle>';
    }).join('')+'</svg>';
}

function pintar(forcar){
  const s=dados, todos=s.devices;
  // Redesenhar a cada 5 s apagava tooltip, seleção de texto e foco. Agora só quando muda.
  const nova = [s.lastRun, setor, busca, s.events.length, JSON.stringify(s.silencio),
                longo && longo.desde, detalhe].join('|');
  if (!forcar && nova === assinatura) { relogioTopo(s); return; }
  assinatura = nova;
  const setores=[...new Set(todos.map(sec))];
  const off=todos.filter(d=>d.status==='offline');
  const dep=todos.filter(d=>d.status==='dependente');
  const ins=todos.filter(d=>d.status==='instavel');
  const nomes=Object.fromEntries(todos.map(d=>[d.ip,d.name]));

  relogioTopo(s);

  const e=document.getElementById('estado');
  e.className='estado '+(off.length?'mal':'bem');
  e.textContent = !s.anchorOk ? 'MONITOR SEM REDE'
    : off.length ? off.length+(off.length>1?' APARELHOS FORA DO AR':' APARELHO FORA DO AR')
    : 'VALE NO AR';
  document.getElementById('legenda').innerHTML = !s.anchorOk
    ? 'O gateway <b>'+s.anchorIp+'</b> parou de responder. Os alertas estão suspensos até a conexão do monitor voltar — nenhum aparelho foi julgado nesta rodada.'
    : off.length
      ? '<b>'+off.map(d=>esc(d.name)).join('</b>, <b>')+'</b>'+
        (dep.length?' · mais <b>'+dep.length+'</b> aparelhos parados por dependerem de um switch caído.':'.')
      : (ins.length
          ? '<b>'+todos.length+'</b> aparelhos respondendo, mas <b style="color:var(--laranja)">'+
            ins.map(d=>esc(d.name)).join('</b>, <b style="color:var(--laranja)">')+
            '</b> '+(ins.length>1?'estão perdendo':'está perdendo')+' pacotes demais — link instável.'
          : (()=>{ 
              const c={}; todos.forEach(d=>{const k=tipoDe(d.type); c[k]=(c[k]||0)+1;});
              return '<div class="tipos">'+Object.entries(c).map(([k,n])=>
                '<div>'+icone(k)+'<b>'+n+'</b> '+PLURAL[k][n>1?1:0]+'</div>').join('')+'</div>'+
                '<div style="margin-top:14px">Em '+setores.length+' setores. Um alerta só aparece '+
                'depois de 3 rodadas sem resposta, com o gateway confirmado no ar.</div>';
            })());

  document.getElementById('petalas').innerHTML = setores.map((x,i)=>{
    const g=todos.filter(d=>sec(d)===x), ok=g.filter(d=>d.status==='online').length;
    const ruim=g.filter(d=>d.status!=='online').length;
    return '<button class="pet" data-s="'+esc(x)+'" data-on="'+(x===setor)+'">'+
      anel(ok/g.length, ruim?'var(--brasa)':CORES[i%CORES.length], ok+'/'+g.length)+
      '<div class="rt">'+esc(x)+'</div></button>';
  }).join('');

  document.getElementById('abas').innerHTML = ['Todos',...setores].map(x=>{
    const n = x==='Todos' ? off.length : todos.filter(d=>sec(d)===x && d.status==='offline').length;
    return '<button aria-pressed="'+(x===setor)+'" data-s="'+esc(x)+'">'+esc(x)+
      (n?' <span class="ct">'+n+'</span>':'')+'</button>';
  }).join('');

  let lista = setor==='Todos' ? todos : todos.filter(d=>sec(d)===setor);
  if (busca) {
    const q = busca.toLowerCase();
    lista = lista.filter(d=>d.name.toLowerCase().includes(q) || d.ip.includes(q));
  }

  const ehHub = h => todos.some(f=>f.parent===h.ip);
  const noSetor = x => setor==='Todos' || sec(x)===setor;
  const hubs = todos.filter(h=>ehHub(h) && noSetor(h));
  const soltos = todos.filter(d=>!d.parent && !ehHub(d) && noSetor(d));
  const porSetor = {};
  soltos.forEach(d=>{ (porSetor[sec(d)] || (porSetor[sec(d)]=[])).push(d); });

  const cartoes = hubs.map(h=>{
    const filhos=todos.filter(f=>f.parent===h.ip);
    const ruins=filhos.filter(f=>f.status!=='online').length;
    return '<div class="hub">'+constelacao(h,filhos)+'<div class="hn">'+esc(h.name)+'</div>'+
      '<div class="hq">'+(ruins?ruins+' com problema':'todos no ar')+'</div></div>';
  }).concat(Object.entries(porSetor).map(([nome,itens])=>{
    const ruins = itens.filter(d=>d.status!=='online').length;
    return '<div class="hub solto">'+nebulosa(nome,itens)+
      '<div class="hn">'+esc(nome)+' · sem uplink mapeado</div>'+
      '<div class="hq">'+(ruins?ruins+' com problema':'todos no ar')+'</div></div>';
  }));

  document.getElementById('tconst').style.display = cartoes.length?'':'none';
  document.getElementById('const').innerHTML = cartoes.join('');

  const ate=s.silencio[setor], calado=ate&&ate>Date.now();
  document.getElementById('man').innerHTML = setor==='Todos'
    ? '<p class="vazio">Escolha um setor para silenciar os alertas durante uma intervenção.</p>'
    : (calado
        ? '<div class="manon">'+esc(setor)+' em manutenção até '+relogio(ate)+'</div>'+
          '<div class="man"><button data-min="0">Reativar alertas</button></div>'
        : '<div class="man"><button data-min="30">30 min</button><button data-min="120">2 h</button>'+
          '<button data-min="480">8 h</button></div>');

  document.getElementById('grid').innerHTML = lista.map(d=>{
    const perda=d.sent?Math.round(d.lost/d.sent*100):0;
    const emMan=s.silencio[sec(d)]>Date.now();
    return '<div class="card '+d.status+(emMan?' mudo':'')+'" data-ip="'+d.ip+
      '" role="button" tabindex="0">'+
      '<div class="nome"><span class="esq">'+icone(d.type)+'<span>'+esc(d.name)+
        '</span></span><span class="pt"></span></div>'+
      (d.status==='dependente'?'<span class="selo dep">queda do switch acima</span>':'')+
      (d.status==='instavel'?'<span class="selo ins">link instável</span>':'')+
      (d.porta&&d.portaOk===false?'<span class="selo svc">'+esc(d.servico||'serviço')+' fora</span>':'')+
      (emMan?'<span class="selo man">em manutenção</span>':'')+
      '<dl><dt>'+esc(d.type||'aparelho')+'</dt><dd>'+d.ip+'</dd>'+
      '<dt>latência</dt><dd>'+(d.ms!=null?d.ms+' ms':'—')+'</dd>'+
      '<dt>'+(d.status==='online'?'estável há':'assim há')+'</dt><dd>'+desde(d.since)+'</dd>'+
      '<dt>perda</dt><dd>'+perda+'%</dd></dl>'+
      (d.porta&&d.portaOk!==false
        ? '<div class="via">'+esc(d.servico||'serviço')+' respondendo na porta '+d.porta+'</div>' : '')+
      (d.parent&&nomes[d.parent]?'<div class="via">via '+esc(nomes[d.parent])+'</div>':'')+
      serra(d.history)+'</div>';
  }).join('') || '<p class="vazio">Nenhum aparelho neste setor.</p>';

  const maxh = Math.max(1, ...lista.map(d=>d.history.length));
  document.getElementById('calorq').innerHTML = lista.length
    ? '<b style="color:var(--texto)">'+lista.length+'</b> aparelhos · últimas <b style="color:var(--texto)">'+
      maxh+'</b> rodadas · listra vermelha no meio de uma linha verde é link instável'
    : '';
  document.getElementById('calor').innerHTML = lista.map(d=>{
    const ruim = d.history.some(v=>v===null);
    const vazias = maxh - d.history.length;
    return '<div class="rot'+(ruim?' ruim':'')+'" title="'+esc(d.name)+'">'+esc(d.name)+'</div>'+
      '<div class="faixa-c">'+
      Array.from({length:vazias},()=>'<i class="cel"></i>').join('')+
      d.history.map((v,i)=>'<i class="cel" style="background:'+calorDe(v)+'" title="'+
        (v===null?'sem resposta':v+' ms')+'"></i>').join('')+
      '</div>';
  }).join('') + (lista.length
      ? '<div class="tempo"><span>mais antigo</span><span>agora</span></div>' : '');

  const dur = m => m<60 ? m+' min' : Math.floor(m/60)+'h '+(m%60)+'min';
  document.getElementById('inc').innerHTML = s.incidentes.length
    ? s.incidentes.slice(0,8).map(i=>
        '<div class="inc'+(i.fim?(i.tipo==='reinício'?' reinicio':''):' aberto')+'">'+
        '<span>'+esc(i.device)+'</span><b>'+dur(i.minutos)+'</b>'+
        '<span class="q">'+(i.fim
          ? i.tipo+' · '+new Date(i.inicio).toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',
              hour:'2-digit',minute:'2-digit'})
          : 'em curso desde '+relogio(i.inicio)+(i.tipo==='dependência'?' · por queda do switch':''))+
        '</span></div>').join('')
    : '<p class="vazio">Nenhuma queda registrada desde que o histórico começou.</p>';

  const dp = Object.entries(s.disp).map(([ip,v])=>({...v, nome:nomes[ip]||ip}))
    .filter(v=>v.pct<100 || v.quedas)
    .sort((a,b)=>a.pct-b.pct).slice(0,6);
  document.getElementById('disp').innerHTML = dp.length ? dp.map(v=>{
    const cl = v.pct>=99.5?'bom':v.pct>=97?'meio':'ruim';
    return '<div class="dp"><span>'+esc(v.nome)+'</span><b class="'+cl+'">'+v.pct.toFixed(1)+'%</b>'+
      '<span class="q">'+(v.quedas?v.quedas+(v.quedas>1?' quedas':' queda'):'sem queda')+
      (v.ms!=null?' · '+v.ms+' ms em média':'')+'</span></div>';
  }).join('') : '<p class="vazio">Todos com 100% de resposta nas últimas 24 h.</p>';

  marcarAba(off.length, ins.length);
  pintarLongo(lista, nomes);

  document.getElementById('lat').innerHTML = todos.filter(d=>d.ms!=null)
    .sort((a,b)=>b.ms-a.ms).slice(0,5).map(d=>
      '<div class="lat"><span>'+esc(d.name)+'</span><i>'+d.ms+' ms</i></div>').join('')
    || '<p class="vazio">Sem medições ainda.</p>';

  document.getElementById('log').innerHTML = s.events.slice(0,15).map(ev=>
    '<div class="ev '+ev.level+'"><b>'+esc(ev.device)+'</b>'+esc(ev.message)+
    '<div class="q">'+hora(ev.at)+(ev.mudo?' · silenciado':'')+'</div></div>').join('')
    || '<p class="vazio">Nada mudou desde que o monitor subiu.</p>';

  pintarDetalhe();
}

function trocar(ev){ const b=ev.target.closest('[data-s]'); if(!b) return; setor=b.dataset.s; pintar(true); }
document.getElementById('denso').addEventListener('click', ev=>{
  const b = ev.currentTarget;
  const on = b.getAttribute('aria-pressed') !== 'true';
  b.setAttribute('aria-pressed', on);
  document.body.classList.toggle('compacto', on);
});
document.getElementById('grid').addEventListener('click', ev=>{
  const c = ev.target.closest('[data-ip]'); if(!c) return;
  detalhe = c.dataset.ip; pintarDetalhe();
});
document.getElementById('veu').addEventListener('click', ev=>{
  if (ev.target.id==='veu') fecharDetalhe();
});
document.addEventListener('keydown', ev=>{ if(ev.key==='Escape') fecharDetalhe(); });
document.getElementById('q').addEventListener('input', ev=>{ busca=ev.target.value.trim(); pintar(true); });
document.getElementById('abas').addEventListener('click', trocar);
document.getElementById('petalas').addEventListener('click', trocar);
document.getElementById('man').addEventListener('click', async ev=>{
  const b=ev.target.closest('button'); if(!b) return;
  await fetch('/api/silenciar',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({setor,minutos:Number(b.dataset.min)})});
  puxar();
});

async function puxar(){ dados=await (await fetch('/api/state')).json(); pintar(); }
async function puxarLongo(){
  try { longo = await (await fetch('/api/historico')).json(); if (dados) pintar(true); } catch {}
}
puxar(); setInterval(puxar,5000);
puxarLongo(); setInterval(puxarLongo,60000);

// modo TV: gira os setores sozinho, priorizando quem tem problema
if (TV) {
  setInterval(()=>{
    if (!dados) return;
    const setores = [...new Set(dados.devices.map(sec))];
    const ruins = setores.filter(x=>dados.devices.some(d=>sec(d)===x && d.status!=='online'));
    const roda = ruins.length ? ruins : ['Todos', ...setores];
    setor = roda[(roda.indexOf(setor)+1) % roda.length];
    document.getElementById('tvsel').textContent = setor;
    pintar(true);
  }, 20000);
  document.getElementById('tvsel').textContent = setor;
}
setInterval(()=>{document.getElementById('hh').textContent=relogio(Date.now());},20000);
</script></html>`;

// Comparação de tamanho fixo: evita descobrir a senha medindo o tempo de resposta.
function igual(a, b) {
  const crypto = require('crypto');
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

function autorizado(req) {
  if (!SENHA) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const [u, ...resto] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
  return igual(u, USUARIO) && igual(resto.join(':'), SENHA);
}

const server = http.createServer((req, res) => {
  if (!autorizado(req)) {
    res.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="Vale Encantado - monitoramento", charset="UTF-8"',
      'Content-Type': 'text/plain; charset=utf-8',
    });
    return res.end('Acesso restrito.');
  }

  if (req.method === 'POST' && req.url.startsWith('/api/silenciar')) {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e4) req.destroy(); });
    req.on('end', () => {
      try {
        const { setor, minutos } = JSON.parse(body);
        if (minutos > 0) {
          silencio.set(setor, Date.now() + minutos * 60000);
          console.log(`manutenção: ${setor} silenciado por ${minutos} min`);
        } else {
          silencio.delete(setor);
          console.log(`manutenção: ${setor} reativado`);
        }
      } catch { /* ignora corpo inválido */ }
      res.writeHead(204).end();
    });
    return;
  }

  if (req.url === '/logo') {
    const cand = ['logo.png', 'logo.svg', 'logo.jpg', 'logo.webp']
      .map((f) => path.resolve(path.dirname(CFG_FILE), f)).find((p) => fs.existsSync(p));
    if (!cand) { res.writeHead(404).end(); return; }
    const tipo = { '.png': 'image/png', '.svg': 'image/svg+xml',
                   '.jpg': 'image/jpeg', '.webp': 'image/webp' }[path.extname(cand)];
    res.writeHead(200, { 'Content-Type': tipo, 'Cache-Control': 'max-age=60' });
    return fs.createReadStream(cand).pipe(res);
  }

  if (req.url.startsWith('/relatorio.csv')) {
    const d24 = disponibilidade(24), d7 = disponibilidade(168);
    const inc = incidentes();
    const linhas = [['aparelho', 'ip', 'tipo', 'setor', 'uplink', 'estado',
                     'disponibilidade_24h_%', 'disponibilidade_7d_%', 'latencia_media_ms',
                     'quedas_24h', 'quedas_7d', 'minutos_fora_7d'].join(';')];
    const nomes = Object.fromEntries([...state.values()].map((x) => [x.ip, x.name]));
    for (const x of state.values()) {
      const i7 = inc.filter((i) => i.ip === x.ip && i.inicio > Date.now() - 168 * 3600e3);
      linhas.push([
        x.name, x.ip, x.type || '', x.sector || '', x.parent ? nomes[x.parent] || x.parent : '',
        x.status,
        d24[x.ip] ? String(d24[x.ip].pct).replace('.', ',') : '',
        d7[x.ip] ? String(d7[x.ip].pct).replace('.', ',') : '',
        d24[x.ip] && d24[x.ip].ms != null ? String(d24[x.ip].ms).replace('.', ',') : '',
        d24[x.ip] ? d24[x.ip].quedas : 0,
        d7[x.ip] ? d7[x.ip].quedas : 0,
        i7.reduce((t, i) => t + i.minutos, 0),
      ].map((c) => (/[;"\n]/.test(String(c)) ? '"' + String(c).replace(/"/g, '""') + '"' : c)).join(';'));
    }
    const hoje = new Date().toISOString().slice(0, 10);
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="rede-vale-encantado-' + hoje + '.csv"',
    });
    return res.end('\uFEFF' + linhas.join('\n'));   // BOM: o Excel abre com acento certo
  }

  if (req.url.startsWith('/api/historico')) {
    const horasAtras = 168;
    const base = new Date(Date.now() - horasAtras * 3600e3);
    base.setUTCMinutes(0, 0, 0);
    const chaves = Array.from({ length: horasAtras }, (_, i) =>
      new Date(base.getTime() + i * 3600e3).toISOString().slice(0, 13));
    const idx = Object.fromEntries(chaves.map((h, i) => [h, i]));
    const saida = {};
    for (const a of [...arquivo, ...horas.values()]) {
      const i = idx[a.h];
      if (i === undefined || !a.env) continue;
      (saida[a.ip] || (saida[a.ip] = Array(horasAtras).fill(null)))[i] =
        Math.round((1 - a.perd / a.env) * 100);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ desde: chaves[0], horas: horasAtras, dados: saida }));
  }

  if (req.url.startsWith('/api/state')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      lastRun, anchorIp, anchorOk,
      silencio: Object.fromEntries(silencio),
      disp: disponibilidade(24),
      incidentes: incidentes().slice(0, 40),
      devices: [...state.values()].sort((a, b) =>
        (a.status === 'online') - (b.status === 'online') || a.name.localeCompare(b.name, 'pt-BR')),
      events,
    }));
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});

const encerrar = () => {
  const todas = [...horas.values()];
  if (todas.length) {
    try { fs.appendFileSync(HORA_FILE, todas.map((a) => JSON.stringify(a)).join('\n') + '\n'); } catch {}
  }
  console.log('\nmonitor encerrado — histórico gravado.');
  process.exit(0);
};
process.on('SIGINT', encerrar);
process.on('SIGTERM', encerrar);

server.listen(PORT, BIND, async () => {
  anchorIp = await detectarGateway();
  console.log(`sistema: ${process.platform} · ping: ${PING}`);
  console.log(`http://localhost:${PORT}`);
  if (BIND === '0.0.0.0') {
    const ifs = require('os').networkInterfaces();
    const meus = Object.values(ifs).flat()
      .filter((n) => n.family === 'IPv4' && !n.internal).map((n) => n.address);
    meus.forEach((ip) => console.log(`http://${ip}:${PORT}   <- este endereço funciona na rede`));
    console.log(SENHA
      ? `protegido por senha — usuário "${USUARIO}"`
      : 'ATENÇÃO: aberto na rede SEM SENHA. Defina NETWATCH_PASS para exigir login.');
  }
  console.log(`${CFG.devices.length} aparelhos · ${CFG.concurrency} pings por vez · âncora ${anchorIp || 'desativada'}`);
  await rodada();
  setInterval(rodada, CFG.intervalSec * 1000);
});
