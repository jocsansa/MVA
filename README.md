# WING Remote

Controle da Behringer WING pela rede, com interface no navegador.
**Fase atual: somente leitura** — o app não envia nenhuma escrita para a mesa.

## Uso

```
npm install
npm run discover            # procura a WING na rede (envia 'WING?' em UDP 2222)
CONSOLE_HOST=<ip-da-wing> npm start
```

Abra http://localhost:3000 (mude com `PORT=`).

## Verificação

```
npm run check               # tsc --noEmit + testes
```

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

Na página, o nome, o fader e o ganho de cada canal viram caixas de texto (Enter envia,
Esc desfaz) e a etiqueta MUTE/ativo vira botão. Antes de enviar, a página mostra o comando
exato e pede confirmação. Toda escrita aparece no terminal com os bytes, e o app lê o valor
de volta para confirmar (a WING não ecoa escritas).

| Comando | Mensagem |
|---|---|
| Renomear | `/ch/N/name ,s "<nome>"` (até 16 caracteres ASCII) |
| Mutar / desmutar | `/ch/N/mute ,i 1` / `,i 0` (nunca o toggle `-1`) |
| Fader | `/ch/N/fdr ,f <dB>` (-144 = -∞ até +10) |
| Ganho | `/io/in/<grp>/<n>/g ,f <dB>` (-3 a 45,5; só LCL, A, B, C, SC) |

### Ganho: cuidados

O ganho fica no headamp da **fonte**, não no canal. O app lê a fonte em
`/ch/N/in/conn/grp` + `/in` (ou `altgrp`/`altin` se `/ch/N/in/set/altsrc` = 1).
Na WING (firmware 3.1) `/conn/in` responde `,sfi` com o **texto 1-based** e o **inteiro
0-based** (ex.: `"5"`, `4`); o número certo é o do texto. Antes de escrever, o app confere
que o ganho atual da fonte é igual ao espelho `/ch/N/in/set/$g`; se não for, recusa.
Mudar o ganho de uma fonte muda todos os canais que usam essa fonte.

## Testado na mesa real (WING fw 3.1)

Renomear, mutar/desmutar e fader, sempre um comando por vez e com confirmação.
O firmware 3.1 responde ao `/?` no endereço `/*`.
