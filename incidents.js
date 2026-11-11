'use strict';

const fs = require('fs');
const path = require('path');

class IncidentStore {
  constructor(file, options = {}) {
    this.file = path.resolve(file);
    this.now = options.now || Date.now;
    this.incidents = new Map();
    this.legacyMigrated = false;
    this.load();
  }

  load() {
    let content;
    try { content = fs.readFileSync(this.file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (!entry || !entry.event || !entry.incidentId) continue;
      if (entry.event === 'migration' && entry.incidentId === 'legacy-events-v1') {
        this.legacyMigrated = true;
      } else if (entry.event === 'opened' && entry.incident) {
        this.incidents.set(entry.incidentId, entry.incident);
      } else if (entry.event === 'updated') {
        const current = this.incidents.get(entry.incidentId);
        if (current && entry.patch && typeof entry.patch === 'object') Object.assign(current, entry.patch);
      } else if (entry.event === 'resolved') {
        const current = this.incidents.get(entry.incidentId);
        if (current) {
          current.status = 'resolved';
          current.fim = entry.at;
          current.motivoResolucao = entry.reason || 'Equipamento recuperado';
        }
      }
    }
  }

  append(entry) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, JSON.stringify(entry) + '\n', { mode: 0o600 });
  }

  migrateLegacy(eventsFile) {
    if (this.legacyMigrated) return false;
    let content;
    try { content = fs.readFileSync(eventsFile, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (!event || !event.ip || !Number.isFinite(event.at)) continue;
      if (event.level === 'offline') {
        this.open({ device: event.device, ip: event.ip, sector: event.sector,
          tipo: 'queda', inicio: event.at,
          causa: 'Ocorrência importada do histórico anterior; causa não registrada',
          causaTipo: 'legado', confianca: 'baixa' });
      } else if (event.level === 'online' || event.level === 'reboot') {
        this.resolve(event.ip, event.at, 'Recuperação importada do histórico anterior');
      }
    }
    this.append({ event: 'migration', incidentId: 'legacy-events-v1', at: this.now() });
    this.legacyMigrated = true;
    return true;
  }

  open(data) {
    const existing = [...this.incidents.values()].find(
      (item) => item.ip === data.ip && item.status === 'open'
    );
    if (existing) {
      const patch = {};
      for (const key of ['tipo', 'causa', 'causaTipo', 'confianca', 'impacto']) {
        if (data[key] !== undefined && existing[key] !== data[key]) patch[key] = data[key];
      }
      if (Object.keys(patch).length) {
        this.append({ event: 'updated', incidentId: existing.id, patch, at: this.now() });
        Object.assign(existing, patch);
      }
      return existing;
    }

    const inicio = Number.isFinite(data.inicio) ? data.inicio : this.now();
    const incident = {
      id: data.id || data.ip + '-' + inicio,
      status: 'open',
      device: data.device,
      ip: data.ip,
      sector: data.sector || '—',
      tipo: data.tipo || 'queda',
      inicio,
      fim: null,
      causa: data.causa || 'Equipamento sem resposta; causa ainda não determinada',
      causaTipo: data.causaTipo || 'desconhecida',
      confianca: data.confianca || 'baixa',
      impacto: Number(data.impacto || 0),
    };
    this.append({ event: 'opened', incidentId: incident.id, incident });
    this.incidents.set(incident.id, incident);
    return incident;
  }

  resolve(ip, at = this.now(), reason = 'Equipamento recuperado') {
    const incident = [...this.incidents.values()].find(
      (item) => item.ip === ip && item.status === 'open'
    );
    if (!incident) return null;
    this.append({ event: 'resolved', incidentId: incident.id, at, reason });
    incident.status = 'resolved';
    incident.fim = at;
    incident.motivoResolucao = reason;
    return incident;
  }

  list(limit = 100) {
    const now = this.now();
    return [...this.incidents.values()]
      .map((incident) => ({
        ...incident,
        minutos: Math.max(0, Math.round(((incident.fim || now) - incident.inicio) / 60000)),
        duracaoMs: Math.max(0, (incident.fim || now) - incident.inicio),
      }))
      .sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1)
        || (b.inicio - a.inicio))
      .slice(0, limit);
  }
}

module.exports = { IncidentStore };
