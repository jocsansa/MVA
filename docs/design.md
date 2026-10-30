# Design e acessibilidade

## Direção

Estilo "Violet dMix": tema escuro quase preto, strips planos, texto branco sem serifa. Cor só para a
identidade do canal (as 18 cores da WING) e para estado (medidores, mute, solo, alertas). Um único
âmbar (`--accent`) para ativo/selecionado.

## Sistema existente

Tokens em `:root` no início de `public/app.css`:

| Token | Uso |
|---|---|
| `--bg`, `--s0`..`--s3`, `--line`, `--edge` | Fundo e superfícies |
| `--text`, `--ink2`, `--muted` | Texto |
| `--accent` | Ativo/selecionado |
| `--mute`, `--solo` | Botões MUTE e S |
| `--m-green`, `--m-amber`, `--m-red` | Zonas do medidor (−18 e −6 dBFS; `MixerLib.ZONES`) |
| `--ok`, `--err` | Estado de conexão |

Alertas: cartões vermelhos (crítico) e âmbar (aviso) acima do conteúdo, pílula de alertas no topo e
marca "!" no strip.

## Interação

- Abas por função (FADERS, GAIN, EQ, GATE/COMP, SENDS, OVERVIEW, SESSÕES) e modo Rápido/Completo
  (Rápido esconde parâmetros secundários com `.full-only`; tudo continua no Completo).
- Valores digitáveis: Enter envia, Esc desfaz. Alvos de toque ≥ 42–48 px.
- Foco visível (`:focus-visible` com contorno âmbar). Estado de conexão com `role="status"`.

## Layout e revisão

- Funciona de 390 px (celular) ao desktop, sem rolagem horizontal; pontos de quebra em 400, 560,
  700, 760, 900 e 1500 px.
- Conferir mudanças visuais com `npm run smoke` (desktop e celular) e, quando for visual, com
  captura de tela na mesa simulada.

## Manutenção

Mudou token, padrão de interação ou ponto de quebra: atualize aqui junto com o CSS.
