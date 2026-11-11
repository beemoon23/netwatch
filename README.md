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
| `netwatch.js` | monitor, servidor web e interface |
| `incidents.js` | diário persistente e ciclo de vida dos incidentes |
| `devices.json` | os aparelhos monitorados e as configurações |
| `netwatch.service` | unidade do systemd |
| `netwatch-events.jsonl` | histórico de eventos, gerado em execução |
| `netwatch-horas.jsonl` | consolidado por hora, gerado em execução |
| `netwatch-incidents.jsonl` | diário persistente de incidentes, abertura, atualização e recuperação |

Os arquivos `.jsonl` moram só no servidor e estão no `.gitignore`. Eles sustentam
o mapa de 7 dias, os relatórios e a Central de Incidentes — apagar significa perder
o histórico correspondente.

## Incidentes e testes

A Central de Incidentes grava cada abertura, mudança de causa e recuperação em
`netwatch-incidents.jsonl`. O arquivo é independente do histórico visual limitado
aos eventos recentes. A causa é apresentada como provável: queda sem evidência de
uplink recebe confiança baixa; quando o equipamento `parent` está indisponível,
a relação de dependência recebe confiança alta. A duração continua sendo atualizada
enquanto o incidente estiver aberto.

Na primeira inicialização, se o diário ainda não existir, o Netwatch importa as
quedas e recuperações registradas no histórico antigo completo. A causa desses itens
legados fica marcada como não determinada e com confiança baixa. Dependências antigas
não são reconstruídas porque a versão anterior não registrava esse estado como evento.

Para executar os testes nativos do Node.js (sem instalar dependências):

```bash
node --test
```

## Alertas e saúde geral

Quedas de equipamentos aguardam `AVISAR_QUEDA_MIN` minutos antes do aviso no Telegram.
Se o equipamento recuperar antes desse prazo, a notificação de queda é cancelada; o retorno
só é enviado quando uma queda já notificada se recupera. Isso reduz ruído de oscilações curtas.

O Netwatch também identifica oscilação quando o mesmo equipamento cai pelo menos
`OSCILA_QUEDAS` vezes em uma janela de 60 minutos. O aviso de oscilação respeita
`OSCILA_SILENCIO_MIN` minutos de intervalo. Se `TELEGRAM_NIVEIS` incluir `offline`,
os avisos de oscilação também são enviados.

O indicador principal considera indisponibilidade ICMP, serviços TCP fora do ar,
links instáveis e perda de conectividade do próprio monitor. Um servidor pode responder
ao ping e ainda assim deixar o painel em estado crítico se a porta do serviço não responder.

O histórico por hora é persistido automaticamente a cada minuto quando uma hora termina,
e também no encerramento normal do processo. Se a gravação falhar, os dados permanecem
em memória para uma nova tentativa.

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

Em produção, as credenciais ficam fora do repositório, em
`/etc/netwatch/netwatch.env` (o systemd lê o arquivo antes de iniciar o processo):

```bash
sudo install -d -m 700 /etc/netwatch
sudoedit /etc/netwatch/netwatch.env
# No arquivo, coloque:
# NETWATCH_USER=vale
# NETWATCH_PASS=UMA_SENHA_LONGA_E_UNICA
sudo chmod 600 /etc/netwatch/netwatch.env
sudo systemctl daemon-reload
sudo systemctl restart netwatch
```

O serviço encerra a inicialização se estiver exposto na rede sem
`NETWATCH_PASS`. Isso evita deixar o painel aberto por engano. A autenticação
Basic sobre HTTP não cifra as credenciais; para redes não totalmente confiáveis,
publique o painel por HTTPS (proxy reverso) ou VPN. Não exponha a porta 48715
diretamente à internet.


```
PORT=48715
NETWATCH_BIND=0.0.0.0            # 127.0.0.1 = só local; 0.0.0.0 = rede interna
TZ=America/Sao_Paulo
TELEGRAM_TOKEN=...
TELEGRAM_CHAT=-5396993498
TELEGRAM_NIVEIS=offline,online,reboot,servico,instavel
AVISAR_QUEDA_MIN=5          # espera antes de alertar queda confirmada
OSCILA_QUEDAS=3             # quedas na última hora para alertar oscilação
OSCILA_SILENCIO_MIN=120     # intervalo entre avisos de oscilação
NETWATCH_USER=vale               # usuário do painel
NETWATCH_PASS=uma-senha-forte      # obrigatório quando NETWATCH_BIND não é loopback
NETWATCH_INCIDENTS=./netwatch-incidents.jsonl # opcional: caminho do diário
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
