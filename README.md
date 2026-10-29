# WING Remote

Controle da Behringer WING pela rede, com interface no navegador (Node.js + TypeScript).
Por padrão o app é **somente leitura**; comandos só com `WING_ALLOW_WRITES=1`. Cada
escrita é validada na descrição da mesa, mostra o comando exato e os avisos de risco e é
lida de volta (sem etapa de confirmação por enquanto; veja "Confirmação removida").

## Instalar (em qualquer computador)

1. Instale o **Node.js 22.18 ou mais novo** (LTS em https://nodejs.org).
2. Baixe o projeto e as dependências:

```
git clone https://github.com/jocsansa/MVA.git
cd MVA
npm install
npm run check               # checagem de tipos + testes
```

## Usar sem a mesa (mesa simulada)

Dois terminais na pasta do projeto:

```
npm run simulate            # terminal 1: mesa simulada em 127.0.0.1
```

macOS / Linux, terminal 2:

```
CONSOLE_HOST=127.0.0.1 WING_ALLOW_WRITES=1 npm start
```

Windows (PowerShell), terminal 2:

```
$env:CONSOLE_HOST="127.0.0.1"; $env:WING_ALLOW_WRITES="1"; npm start
```

Abra http://localhost:3000. A mesa simulada (`src/simulator.ts`) imita a WING real
(firmware 3.1): respostas OSC, descrição de nós, assinatura, envios e medidores em
movimento. Escritas só mudam a memória do simulador e aparecem no terminal 1.

## Usar com a WING real

```
npm run discover            # procura a WING na rede (envia 'WING?' em UDP 2222)
CONSOLE_HOST=<ip-da-wing> npm start                      # somente leitura
CONSOLE_HOST=<ip-da-wing> WING_ALLOW_WRITES=1 npm start  # libera comandos
```

No Windows use `$env:CONSOLE_HOST="<ip>"; npm start`. A porta da página muda com `PORT`.

## Protocolo (fonte: WING Remote Protocols, P.-G. Maillot)

| O quê | Como |
|---|---|
| Descoberta | UDP 2222, datagrama `WING?` → `WING,<ip>,<nome>,<modelo>,<serial>,<fw>` |
| OSC | UDP 2223. GET = endereço sem argumentos; resposta `,s` / `,sff` / `,sfi` |
| Eventos | `/*s` (renovar a cada < 10 s). A WING aceita **uma** assinatura OSC por vez |
| Nome | `/ch/N/name` (S, 16 caracteres) |
| Mute | `/ch/N/mute` (I, 0..1) |
| Fader | `/ch/N/fdr` (F, -144..10 dB) |
| Ganho | `/ch/N/in/set/$g` (F, dB, espelho do headamp da fonte) |
| Medidores | TCP 2222, canal nativo 3 (`0xdf 0xd3`): porta UDP (`0xd3`), report id (`0xd4`), coleção `0xdc 0xa0 idx… 0xde`; renovar a cada < 5 s. Dados em UDP: report id + int16 BE em 1/256 dB, 8 valores por canal |

## Leitura e escrita

Por padrão o app é somente leitura: o cliente (`src/wing.ts`) só envia GETs OSC,
a assinatura `/*s`, o heartbeat `/?` e pedidos de medidor no canal nativo 3.

Para liberar comandos:

```
CONSOLE_HOST=<ip-da-wing> WING_ALLOW_WRITES=1 npm start
```

A página tem uma aba por tipo de strip: Canais (40), Aux (8), Buses (16), Mains (4),
Matrizes (8), DCAs (16) e Mute groups (8). Nome, fader, pan e ganho viram caixas de
texto (Enter envia, Esc desfaz); MUTE e S (solo) viram botões; a barra colorida no topo
abre a paleta de cores (tocar numa cor já envia). A escrita vai direto, sem etapa de
confirmação: a barra no rodapé mostra o comando exato que está saindo, o resultado da
leitura de volta e os avisos de risco (main, DCA, mute group, phantom, patch, ganho na
fonte, aumento de mais de 6 dB). Toda escrita aparece no terminal com os bytes, e o app
lê o valor de volta para confirmar (a WING não ecoa escritas). `POST /api/param` e
`POST /api/channels/N/gain` devolvem `command` (o comando exato) e `risk`.

| Comando | Mensagem |
|---|---|
| Renomear | `/<tipo>/N/name ,s "<nome>"` (até 16 caracteres ASCII) |
| Mutar / desmutar | `/<tipo>/N/mute ,i 1` / `,i 0` (nunca o toggle `-1`) |
| Solo | `/<tipo>/N/$solo ,i 1` / `,i 0` |
| Fader | `/<tipo>/N/fdr ,f <dB>` (-144 = -∞ até +10) |
| Pan | `/<tipo>/N/pan ,f <-100..100>` (DCA não tem pan) |
| Cor | `/<tipo>/N/col ,i <1..18>` |
| Ganho | `/io/in/<grp>/<n>/g ,f <dB>` (faixa lida da mesa; só LCL, A, B, C, SC) |

`<tipo>` = `ch`, `aux`, `bus`, `main`, `mtx`, `dca` ou `mgrp` (mute group: só nome e mute).

### Base genérica

O app pergunta à própria mesa como é cada parte dela com a consulta de descrição de nó
(`<nó> ,s #`, só leitura): tipo, faixa, opções e se é somente leitura. Toda escrita pela
rota genérica (`POST /api/param`) é conferida contra essa descrição antes de sair.

| Rota | O que faz |
|---|---|
| `GET /api/describe?path=/ch/1` | Descrição do nó com valores atuais e avisos de risco |
| `GET /api/param?path=/ch/1/pan` | Lê um parâmetro |
| `POST /api/param` `{path, value}` | Escreve um parâmetro (só com `WING_ALLOW_WRITES=1`) |
| `GET /api/sends?dest=bus/1` | Envios de todas as fontes para um bus (ou `mtx/1..8`) |
| `POST /api/sends` `{src, dest, param, value}` | Escreve um parâmetro de envio (veja "Sends" abaixo) |

Envios: canais e aux mandam para buses 1–16 e matrizes MX1–MX8 (`on`, `lvl`, `mode`
PRE/POST/GRP); buses e mains mandam só para as matrizes e usam `pre` (0/1) no lugar
de `mode`. Envio de bus para bus existe mas é somente leitura.

Medidores: uma coleção só com todos os tipos (tokens `0xa0`..`0xa5`; na WING real um pedido
novo substitui o anterior na mesma conexão), 8 valores por
strip e 4 no DCA; a página mostra a saída (L/R). Nos canais, as palavras 5 e 7 são o
ganho do gate e do compressor (Table 5), usadas no medidor de redução de ganho.

### EQ e filtro dos canais

Aba **Canal**, seção EQ (ou botão EQ no card do canal; link direto `http://localhost:3000/#eq/5`). PEQ de
6 bandas (LOW, 1–4, HIGH; LOW e HIGH podem ser PEQ ou shelf) e filtros passa-alta e
passa-baixa. Soltar um ponto arrastado na curva, tocar em −/+, digitar ou escolher uma
opção envia na hora, sem etapa de confirmação (veja abaixo). Cada comando é validado na
descrição da mesa, enviado um por vez e lido de volta; o envio para no primeiro problema.
A barra no rodapé mostra os comandos exatos enviados, a confirmação da leitura de volta e
os avisos de risco; o aviso do passa-alta fica sempre visível no painel. O painel edita só
o EQ modelo STD (outros modelos têm outros parâmetros).

**Confirmação removida (temporário):** a etapa de confirmação antes de enviar foi removida
de toda a página (controles da grade, EQ, dinâmica e Sends) a pedido do usuário (Jocsan,
25/10), enquanto ele não está usando a mesa ao vivo. Validação, avisos de risco, leitura
de volta e o padrão somente leitura (escrita só com `WING_ALLOW_WRITES=1`) continuam.
Para uso ao vivo, a confirmação pode ser recolocada: as rotas de EQ, dinâmica e sends têm
`dryRun`, que devolve o comando exato sem escrever.

| Rota | O que faz |
|---|---|
| `GET /api/channels/N/eq` | EQ (`eq`) e filtro (`flt`) do canal: valor, faixa, opções e risco de cada parâmetro (2 consultas de descrição, só leitura) |
| `POST /api/channels/N/eq` `{param, value}` | Escreve um parâmetro do EQ: `on`, `lg lf lq leq`, `1g`…`4q`, `hg hf hq heq` |
| `POST /api/channels/N/flt` `{param, value}` | Escreve um parâmetro do filtro: `lc lcf lcs` (passa-alta), `hc hcf hcs` (passa-baixa) |
| … com `"dryRun": true` | Só valida na descrição da mesa e devolve o comando exato; nada é escrito |

| Parâmetro | Tipo e faixa (fw 3.1) |
|---|---|
| `on`, `lc`, `hc` | `,i` 0 ou 1 |
| `lg`, `1g`…`4g`, `hg` | `,f` -15 a +15 dB |
| `lf`, `1f`…`4f`, `hf` | `,f` 20 a 20000 Hz |
| `lq`, `1q`…`4q`, `hq` | `,f` 0.44 a 10 |
| `leq`, `heq` | `,s` `PEQ` ou `SHV` (shelf) |
| `lcf` / `hcf` | `,f` 20 a 2000 Hz / 50 a 20000 Hz |
| `lcs` / `hcs` | `,s` `"6"`, `"12"`, `"18"`, `"24"` / `"6"`, `"12"` (dB/oitava) |

A resposta da escrita traz `ok` (leitura de volta confere, dentro de um passo da mesa),
`command`, `risk` e `readBack`. Avisos: desligar o EQ, mexer no passa-alta e ganhos de EQ.

### Sends

Aba **Sends** (link direto `http://localhost:3000/#sends/bus/3` ou `#sends/mtx/2`): escolha
um bus ou uma matriz e cada fonte vira um fader com o nível do envio para esse destino,
com ON/OFF e PRE/POST/GRP (bus e main para matriz: só PRE/POST). Como no EQ, as mudanças
vão direto, sem etapa de confirmação: ao soltar o fader (arrastar é relativo, tocar sem
mover não muda nada; Shift = ajuste fino), ao tocar em ON/modo ou ao digitar o nível
(`-inf` = -∞). Teclado no fader: setas ±1 dB, Page Up/Down ±6 dB. Enquanto arrasta, a
barra do rodapé mostra o comando OSC exato que vai sair e os avisos; depois, o comando
enviado e a leitura de volta. "Só ligados" esconde os envios desligados. No celular, cada
grupo de fontes é uma fileira de faders com rolagem horizontal.

`POST /api/sends` com `{src, dest, param, value, dryRun?}`: um parâmetro por pedido,
validado na descrição do nó da mesa e lido de volta (com `dryRun` só valida e devolve o
comando). A resposta tem `ok`, `command`, `risk` e `readBack`.

| Campo | Valores |
|---|---|
| `dest` | `bus/1`..`bus/16`, `mtx/1`..`mtx/8` |
| `src` | para bus: `ch/1..40`, `aux/1..8`; para matriz: também `bus/1..16`, `main/1..4` |
| `param` | `lvl` (`,f` -144 = -∞ a +10 dB), `on` (`,i` 0/1); canal e aux: `mode` (`,s` `PRE`/`POST`/`GRP`); bus e main: `pre` (`,i` 1 = pré, 0 = pós) |

### Dinâmica dos canais (gate e compressor)

Aba **Canal**, seções Gate e Compressor (links diretos `#gate/5` e `#dyn/5`). Os controles
são montados pela **descrição do nó na mesa** (`/ch/N/gate`, `/ch/N/dyn`): o app mostra todos
os parâmetros que a mesa expõe para o modelo escolhido (threshold, alcance, attack, hold,
release, ratio, knee, makeup, mix, detector...), com faixa e opções vindas dela; trocar o
modelo relê o nó. Curva de transferência (entrada x saída; arrastar para os lados muda o
threshold) e medidor de redução de ganho. Como no EQ, as mudanças vão direto, uma por vez,
com o comando exato e os avisos na barra e leitura de volta.

| Rota | O que faz |
|---|---|
| `GET /api/channels/N/dyn` | Gate (`gate`) e compressor (`dyn`): modelo, on e todos os parâmetros com valor, faixa, opções, somente leitura e risco |
| `POST /api/channels/N/gate` `{param, value}` | Escreve um parâmetro do gate (qualquer nome que a descrição da mesa aceite) |
| `POST /api/channels/N/dyn` `{param, value}` | Escreve um parâmetro do compressor |
| … com `"dryRun": true` | Só valida na descrição da mesa e devolve o comando exato |

Ainda não conferido na mesa real: a lista exata de parâmetros de cada modelo (o simulador
usa uma versão plausível) e o mapa das palavras 5 e 7 do medidor como ganho do gate e do
compressor.

### Gravação das sessões (captura das mixagens)

Aba **SESSÕES**. O operador escreve o nome (sem login), marca o momento do culto (Pré-culto,
Louvor, Ministração, Pregação, Ofertório, Avisos, Final) e inicia a gravação. Enquanto grava,
a pílula vermelha **REC** fica no topo de todas as abas. Mesmo desenho da caixa-preta do
automix: um arquivo JSONL por culto, uma linha por evento, em `data/sessions/culto-AAAA-MM-DD_HH-MM-SS.jsonl`
(pasta configurável com `SESSIONS_DIR`; fora do git).

- **Só leitura.** Funciona em somente leitura (sem `WING_ALLOW_WRITES`). O gravador escuta o
  que a mesa já manda (assinatura `/*s`, GETs e medidores) e, ao iniciar, lê EQ, filtro,
  gate e compressor dos 40 canais pela descrição dos nós. Nunca envia comando para a mesa.
- **Eventos:** `session` (data, operador, momento, mesa), `snapshot` (fader, mute, solo, pan e
  ganho de todos os strips), `proc` (EQ/filtro/gate/compressor de cada canal), `change`
  (fader, mute, solo, pan, ganho, EQ, dinâmica e nome, com valor anterior; valor repetido não
  grava), `moment`, `meters` (pico de cada strip a cada segundo), `conn`, `alert` (alerta
  disparado, resolvido ou dispensado) e `session-end`.
- **Rotação:** guarda as últimas `SESSIONS_KEEP` sessões (padrão 60) e no máximo
  `SESSIONS_MAX_MB` somados (padrão 500); apaga as mais antigas ao iniciar uma sessão. Uma
  sessão esquecida aberta é encerrada sozinha depois de 6 h.
- Servidor encerrado com Ctrl+C fecha a sessão. Se o processo cair, o arquivo fica sem a
  linha de fim e a lista mostra **INTERROMPIDA**, com a duração até o último evento.

| Rota | O que faz |
|---|---|
| `GET /api/sessions` | Gravação em andamento, momentos e lista das sessões (data, operador, duração, tamanho) |
| `GET /api/sessions/<id>` | Registro bruto (JSONL) de uma sessão |
| `POST /api/sessions/start` `{operator, moment}` | Inicia a gravação |
| `POST /api/sessions/moment` `{moment}` | Marca o momento do culto |
| `POST /api/sessions/stop` | Encerra a gravação |

### Alertas ao vivo

Durante o culto o app avisa o operador quando algo está errado, com o passo a passo para
corrigir na mesa. Só leitura: os alertas olham os medidores e o estado dos canais e **nunca
escrevem na mesa**. Desenho das regras do automix, adaptado para a WING.

| Regra | Nível | Espera | Condição |
|---|---|---|---|
| Mesa desconectada | crítico | imediato | Sem resposta OSC por 12 s ou sem medidores por 3 s |
| Canal mutado com sinal | crítico | 2 s | Mute ligado, fader aberto (acima de -50 dB) e entrada acima de -45 dB |
| Clip | aviso | imediato | Entrada em -0,5 dBFS ou acima; sai 10 s depois do último pico |
| Canal sem sinal | aviso | 30 s | Canal aberto (sem mute, fader acima de -50 dB) com entrada abaixo de -60 dB; não vale no pré-culto. Passos de sem fio (bateria, receptor) ou com fio (cabo, phantom) |
| MAIN LR sem sinal | crítico | 5 s | Algum canal aberto sai com sinal, mas o MAIN 1 está abaixo de -60 dB |

- **Entrada do canal:** as regras de mute, clip e canal sem sinal usam a entrada (palavras 0
  e 1 do medidor da WING, antes do fader e do mute). O MAIN usa a saída dos canais.
  As regras olham o pico dos últimos 500 ms, avaliado a cada 250 ms.
- **Uma vez por ocorrência:** cada alerta dispara uma vez, fica na tela enquanto a condição
  durar e some sozinho quando ela resolve. **Dispensar** tira da tela; o alerta só volta se a
  condição sumir e aparecer de novo. Com a mesa desconectada os outros alertas ficam congelados.
- **Tela:** cartões no topo (crítico em vermelho, aviso em âmbar) com "O que fazer", um "!" no
  strip do canal e a pílula de alertas no topo, que abre o histórico da sessão (disparou,
  resolvido, dispensado). Com gravação em andamento, cada alerta entra no registro da sessão.
- **Limites:** todos em `ALERT_LIMITS`, em [src/alerts.ts](src/alerts.ts) (níveis, tempos de espera,
  canais sem fio, canais ignorados). **Calibração com a WING real pendente:** os valores vêm do
  automix e ainda não foram conferidos com os níveis reais da igreja.

| Rota | O que faz |
|---|---|
| `GET /api/alerts` | Alertas ativos, histórico e limites |
| `POST /api/alerts/dismiss` `{id}` | Dispensa um alerta (só some da tela) |

No simulador os canais 1 a 20 têm fonte, e a entrada sobe com o ganho: ganho no máximo faz o
canal clipar. Os canais 21 a 40 não têm fonte. Abrir um deles provoca "canal sem sinal".

### Comandar pelo chat (Claude Code)

As rotas acima são HTTP local, então o Claude Code pode operar a mesa a pedido no chat
(EQ, dinâmica, sends e a rota genérica). Ler não precisa de nada. Para escrever, o Claude
mostra o comando OSC exato e o aviso de risco (com `dryRun`), pergunta e só envia depois
do "sim" do usuário, uma escrita por vez, informando a leitura de volta. Não há uma etapa
de confirmação a mais além desse "sim".

```
curl -s http://localhost:3000/api/channels/5/eq
curl -s -H "content-type: application/json" -d '{"param":"1g","value":-3,"dryRun":true}' http://localhost:3000/api/channels/5/eq
curl -s -H "content-type: application/json" -d '{"param":"1g","value":-3}' http://localhost:3000/api/channels/5/eq
curl -s "http://localhost:3000/api/sends?dest=bus/3"
curl -s -H "content-type: application/json" -d '{"src":"ch/5","dest":"bus/3","param":"lvl","value":-10,"dryRun":true}' http://localhost:3000/api/sends
curl -s -H "content-type: application/json" -d '{"src":"ch/5","dest":"bus/3","param":"lvl","value":-10}' http://localhost:3000/api/sends
curl -s http://localhost:3000/api/channels/5/dyn
curl -s -H "content-type: application/json" -d '{"param":"thr","value":-20,"dryRun":true}' http://localhost:3000/api/channels/5/dyn
curl -s -H "content-type: application/json" -d '{"param":"thr","value":-20}' http://localhost:3000/api/channels/5/dyn
```

A rota recusa pedidos com `Origin` de outro site e sem `content-type: application/json`.

### Ganho: cuidados

O ganho fica no headamp da **fonte**, não no canal. O app lê a fonte em
`/ch/N/in/conn/grp` + `/in` (ou `altgrp`/`altin` se `/ch/N/in/set/altsrc` = 1).
Na WING (firmware 3.1) `/conn/in` responde `,sfi` com o **texto 1-based** e o **inteiro
0-based** (ex.: `"5"`, `4`); o número certo é o do texto. Antes de escrever, o app confere
que o ganho atual da fonte é igual ao espelho `/ch/N/in/set/$g`; se não for, recusa.
Mudar o ganho de uma fonte muda todos os canais que usam essa fonte.

## Testado na mesa real (WING fw 3.1)

Renomear, mutar/desmutar, fader, pan, cor e solo, sempre um comando por vez, com
confirmação, num canal sem entrada, e revertidos depois. Ganho ainda não foi testado na
mesa real.

Comportamentos do firmware 3.1 descobertos nos testes:

- Responde ao `/?` no endereço `/*`.
- Em respostas `,sfi` o inteiro é a posição na faixa (valor − mínimo); o valor real é o texto.
- Um pedido de medidores novo substitui o anterior na mesma conexão.
- Solo soma (ligar o solo de um canal não desliga o solo de outro strip).
- Depois de reiniciar a mesa, o socket OSC antigo pode parar de receber respostas.
