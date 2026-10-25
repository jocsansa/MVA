# WING Remote

Controle da Behringer WING pela rede, com interface no navegador (Node.js + TypeScript).
Por padrão o app é **somente leitura**; comandos só com `WING_ALLOW_WRITES=1` e sempre
com confirmação na página.

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
abre a escolha de cor. Antes de enviar, a página mostra o comando exato e pede
confirmação; main, DCA, mute group, phantom e patch mostram um aviso extra. Toda escrita
aparece no terminal com os bytes, e o app lê o valor de volta para confirmar (a WING não
ecoa escritas).

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

Envios: canais e aux mandam para buses 1–16 e matrizes MX1–MX8 (`on`, `lvl`, `mode`
PRE/POST/GRP); buses e mains mandam só para as matrizes e usam `pre` (0/1) no lugar
de `mode`. Envio de bus para bus existe mas é somente leitura.

Medidores: uma coleção só com todos os tipos (tokens `0xa0`..`0xa5`; na WING real um pedido
novo substitui o anterior na mesma conexão), 8 valores por
strip e 4 no DCA; a página mostra a saída (L/R).

### EQ e filtro dos canais

Aba **EQ** (ou botão EQ no card do canal; link direto `http://localhost:3000/#eq/5`). PEQ de
6 bandas (LOW, 1–4, HIGH; LOW e HIGH podem ser PEQ ou shelf) e filtros passa-alta e
passa-baixa. Soltar um ponto arrastado na curva, tocar em −/+, digitar ou escolher uma
opção envia na hora, sem etapa de confirmação (veja abaixo). Cada comando é validado na
descrição da mesa, enviado um por vez e lido de volta; o envio para no primeiro problema.
A barra no rodapé mostra os comandos exatos enviados, a confirmação da leitura de volta e
os avisos de risco; o aviso do passa-alta fica sempre visível no painel. O painel edita só
o EQ modelo STD (outros modelos têm outros parâmetros).

**Confirmação removida (temporário):** a etapa de confirmação antes de enviar foi removida
do painel de EQ e do fluxo por chat a pedido do usuário, enquanto ele não está usando a
mesa ao vivo. Validação, avisos de risco, leitura de volta e o padrão somente leitura
(escrita só com `WING_ALLOW_WRITES=1`) continuam. Para uso ao vivo, a confirmação pode
ser recolocada: a rota já tem o `dryRun`, que devolve o comando exato sem escrever. Os
outros controles da página (nome, mute, fader, pan, cor, ganho) continuam pedindo
confirmação.

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

### Comandar pelo chat (Claude Code)

As rotas acima são HTTP local, então o Claude Code pode operar a mesa a pedido no chat.
O Claude lê (`GET /api/channels/N/eq`), mostra o comando OSC exato e o aviso de risco
(com `dryRun`) e envia, uma escrita por vez, informando a leitura de volta. Não há etapa
separada de confirmação (removida a pedido do usuário enquanto não está ao vivo): o "sim"
do usuário para prosseguir já cobre o envio.

```
curl -s http://localhost:3000/api/channels/5/eq
curl -s -H "content-type: application/json" -d '{"param":"1g","value":-3,"dryRun":true}' http://localhost:3000/api/channels/5/eq
curl -s -H "content-type: application/json" -d '{"param":"1g","value":-3}' http://localhost:3000/api/channels/5/eq
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
