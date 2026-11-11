'use strict';

function resumirSaude(devices, anchorOk = true) {
  const offline = devices.filter((d) => d.status === 'offline');
  const dependentes = devices.filter((d) => d.status === 'dependente');
  const instaveis = devices.filter((d) => d.status === 'instavel');
  // Se o host já está fora, a falha TCP é consequência da queda do próprio host.
  const servicos = devices.filter((d) =>
    d.porta && d.portaOk === false && !['offline', 'dependente'].includes(d.status));

  let nivel = 'ok';
  if (!anchorOk || !devices.length) nivel = 'unknown';
  else if (offline.length || servicos.length) nivel = 'critical';
  else if (dependentes.length || instaveis.length) nivel = 'warning';

  return {
    nivel,
    total: devices.length,
    online: devices.filter((d) => d.status === 'online').length,
    offline: offline.length,
    dependentes: dependentes.length,
    instaveis: instaveis.length,
    servicos: servicos.length,
  };
}

module.exports = { resumirSaude };
