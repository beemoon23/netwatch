'use strict';

class AlertManager {
  constructor({
    downDelayMin = 5,
    flapThreshold = 3,
    flapWindowMin = 60,
    flapCooldownMin = 120,
  } = {}) {
    this.downDelayMs = Math.max(0, downDelayMin) * 60000;
    this.flapThreshold = Math.max(1, flapThreshold);
    this.flapWindowMs = Math.max(1, flapWindowMin) * 60000;
    this.flapCooldownMs = Math.max(0, flapCooldownMin) * 60000;
    this.pending = new Map();
    this.flaps = new Map();
    this.lastFlapAlert = new Map();
  }

  registrarQueda(ip, device, message, at = Date.now()) {
    const recentes = (this.flaps.get(ip) || [])
      .filter((timestamp) => at - timestamp <= this.flapWindowMs);
    recentes.push(at);
    this.flaps.set(ip, recentes);

    if (!this.pending.has(ip)) {
      this.pending.set(ip, { ip, device, message, since: at, notified: false });
    }

    const ultimoAviso = this.lastFlapAlert.get(ip) ?? -Infinity;
    const oscilando = recentes.length >= this.flapThreshold
      && at - ultimoAviso >= this.flapCooldownMs;
    if (oscilando) this.lastFlapAlert.set(ip, at);

    return { oscilando, quedasNaJanela: recentes.length };
  }

  vencidas(at = Date.now()) {
    return [...this.pending.values()].filter((item) =>
      !item.notified && at - item.since >= this.downDelayMs);
  }

  marcarNotificada(ip) {
    const item = this.pending.get(ip);
    if (!item) return false;
    item.notified = true;
    return true;
  }

  registrarRecuperacao(ip) {
    const item = this.pending.get(ip);
    this.pending.delete(ip);
    return Boolean(item && item.notified);
  }
}

module.exports = { AlertManager };
