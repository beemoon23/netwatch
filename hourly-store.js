'use strict';

const fs = require('fs');

function persistirHorasFechadas(horas, arquivo, caminho, horaAtual) {
  const prontas = [...horas.entries()].filter(([, item]) => item.h !== horaAtual);
  if (!prontas.length) return 0;

  const linhas = prontas.map(([, item]) => JSON.stringify(item)).join('\n') + '\n';
  // Só removemos da memória depois de a gravação síncrona confirmar sucesso.
  fs.appendFileSync(caminho, linhas);
  prontas.forEach(([chave, item]) => {
    arquivo.push(item);
    horas.delete(chave);
  });
  return prontas.length;
}

function persistirTodasHoras(horas, caminho) {
  if (!horas.size) return 0;
  const itens = [...horas.values()];
  const linhas = itens.map((item) => JSON.stringify(item)).join('\n') + '\n';
  fs.appendFileSync(caminho, linhas);
  horas.clear();
  return itens.length;
}

module.exports = { persistirHorasFechadas, persistirTodasHoras };
