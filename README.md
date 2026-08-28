# Netwatch — painel de rede do Vale Encantado

Monitora APs, switches e servidores por ping, mostra tudo num painel web e avisa
no Telegram quando algo cai.

Não usa a API da UniFi: só ICMP e, para servidores, checagem de porta TCP.
Isso significa que ele funciona sem credencial da controladora e continua
funcionando mesmo se a controladora estiver fora.

---

## Rodando

Precisa de Node 18 ou mais novo. Não tem dependência para instalar.

```bash
cd /opt/netwatch
node netwatch.js
```

Em produção roda como serviço:

```bash
sudo systemctl status netwatch --no-pager
sudo systemctl restart netwatch      # depois de git pull ou de editar devices.json
sudo journalctl -u netwatch -f       # logs ao vivo (Control+C sai do log, não do serviço)
```

O painel fica em `http://IP_DO_SERVIDOR:48715`.

## Arquivos

| arquivo | o que é |
|---|---|
| `netwatch.js` | tudo: monitor, servidor web e interface |
| `devices.json` | os aparelhos monitorados e as configurações |
| `netwatch.service` | unidade do systemd |
| `netwatch-events.jsonl` | histórico de eventos, gerado em execução |
| `netwatch-horas.jsonl` | consolidado por hora, gerado em execução |

Os dois `.jsonl` moram só no servidor e estão no `.gitignore`. São eles que
sustentam o mapa de 7 dias e o relatório — apagar significa perder o histórico.

## Configuração

Fica no `devices.json` (o que muda pouco) e em variáveis de ambiente no
`netwatch.service` (o que é específico da máquina).

```jsonc
{
  "intervalSec": 30,        // intervalo entre rodadas
  "failThreshold": 3,       // rodadas sem resposta até declarar queda
  "rebootWindowMin": 5,     // voltou dentro disso = reinício, não queda
  "concurrency": 10,        // pings simultâneos
  "janelaInstavel": 20,     // rodadas analisadas para julgar instabilidade
  "perdaInstavel": 20,      // % de perda que caracteriza link instável
  "anchorIp": null,         // gateway; null = detecta sozinho
  "devices": [ ... ]
}
```

Cada aparelho:

```jsonc
{
  "name": "U7 Pro - Lanchonete",
  "ip": "27.78.100.77",
  "type": "AP",                    // AP, Switch, Servidor ou Central (define o ícone)
  "sector": "Lazer",               // vira aba no painel
  "parent": "27.78.108.115",       // IP do switch de onde ele pendura (opcional)
  "porta": 8088,                   // só para servidores: checa se o serviço responde
  "servico": "GLPI"                // nome que aparece no card
}
```

Variáveis no `netwatch.service`:

```
PORT=48715
NETWATCH_BIND=0.0.0.0            # 127.0.0.1 = só local; 0.0.0.0 = rede interna
TZ=America/Sao_Paulo
TELEGRAM_TOKEN=...
TELEGRAM_CHAT=-5396993498
TELEGRAM_NIVEIS=offline,online,reboot,servico
NETWATCH_USER=vale               # opcional: exige login no painel
NETWATCH_PASS=...
```

---

## Decisões que não são óbvias

**Por que 3 pacotes e 3 rodadas.** Equipamento UniFi trata ICMP como tráfego de
menor prioridade e descarta ping quando a CPU de gerência está ocupada. Um único
pacote perdido não significa nada. Só declara queda quem falhar 9 pacotes em
3 rodadas seguidas.

**Por que existe a âncora.** Antes de julgar qualquer aparelho, o monitor pinga o
gateway. Se ele não responde, quem está sem rede é o servidor, e a rodada inteira
é ignorada. Sem isso, um cabo solto no monitor pintaria os 82 aparelhos de
vermelho de uma vez.

**Por que a fila de pings é limitada.** Disparar 82 pings simultâneos é uma rajada
que provoca exatamente o descarte de ICMP que o monitor quer medir. Com 10 por vez
e um jitter entre eles, o monitor para de criar o problema que detecta.

**Por que o `-W` muda de valor.** No macOS o parâmetro é em milissegundos, no Linux
é em segundos. O código detecta a plataforma e ajusta. O mesmo vale para a saída:
o macOS escreve `3 packets received` e o Linux escreve `3 received`.

**Por que existe o estado "instável".** Um link que responde mas perde 40% dos
pacotes nunca dispara alerta de queda — e é o que mais incomoda hóspede. Por isso
existe um estado próprio, com alerta próprio e limiar próprio.

**Por que o `parent` importa.** Quando um switch cai, todos os APs abaixo dele
param junto. Sem a dependência mapeada, isso vira cinco alertas sem causa. Com
ela, vira um alerta com a causa dentro.

**Por que o painel não redesenha a cada 5 segundos.** Os dados só mudam a cada
rodada. Redesenhar antes disso apagava tooltip, seleção de texto e foco de teclado
sem trazer informação nova.

## Manutenção

**Aparelho novo:** adicionar ao `devices.json` e reiniciar o serviço.

**Aparelho removido:** apagar a linha no mesmo dia. Aparelho que saiu de operação
e ficou no arquivo vira card vermelho permanente — e alarme que ninguém pode
resolver é alarme que todo mundo aprende a ignorar.

**Logo:** um arquivo `logo.png` na pasta aparece automaticamente no topo.

**Modo TV:** `http://IP:48715/?tv=1` em tela cheia. Gira os setores sozinho e,
quando há problema, gira só entre os setores com problema.

## Pendências conhecidas

- O gateway `10.0.0.195` é também um servidor monitorado. Se ele cair, para a
  rede e o monitoramento junto — vale separar as duas funções.
- A rede usa a faixa `27.78.x.x`, que é pública. Funciona hoje, mas complica
  rota e VPN no futuro.
- Os APs wall-in dos quartos não têm uplink mapeado, então aparecem como
  "sem uplink mapeado" no mapa em vez de pendurados no switch deles.
