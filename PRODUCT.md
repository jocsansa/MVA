# MVA — WING Remote

## Problema e objetivo

A equipe de som da igreja opera uma Behringer WING (firmware 3.1). O MVA dá ao operador uma
interface no navegador (computador ou celular na mesma rede) para ver e ajustar a mesa, gravar o
que aconteceu em cada culto e receber avisos quando algo dá errado ao vivo.

## Público

- **Operador de som** no culto: usa as abas do mixer, os alertas e a gravação da sessão. Sem login;
  o nome do operador é digitado ao iniciar a gravação.
- **Quem mantém o projeto**: usa o simulador, os testes e as rotas HTTP (inclusive pelo Claude Code).

## Fluxos que existem hoje

1. **Mixer** (abas FADERS, GAIN, EQ, GATE/COMP, SENDS, OVERVIEW): ver nome, fader, mute, solo,
   pan, cor, ganho e medidores de todos os strips (40 canais, 8 aux, 16 buses, 4 mains, 8 matrizes,
   16 DCAs, 8 mute groups); EQ de 6 bandas com filtros e curva; gate e compressor; envios.
2. **Escrita na mesa** (só com `WING_ALLOW_WRITES=1`): cada escrita é validada contra a descrição do
   nó na mesa, mostra o comando exato e os avisos de risco, e é lida de volta.
3. **Gravação da sessão** (aba SESSÕES): operador, momento do culto, mudanças e medidores a 1 Hz num
   JSONL por culto, com lista e visualizador. Só leitura.
4. **Alertas ao vivo**: mesa desconectada, canal mutado com sinal, clip, canal sem sinal e MAIN sem
   sinal, com o passo a passo para corrigir. Só leitura.

## Fora do escopo

- Automação de mixagem (o app avisa; quem corrige é o operador).
- Acesso pela internet: o servidor escuta só em `127.0.0.1`.
- Outras mesas além da WING.

## Restrições

- **Segurança da mesa real acima de tudo**: somente leitura por padrão; escrita só liberada por
  variável de ambiente e, pelo chat, só com confirmação do usuário, uma por vez.
- Sem dependências de execução (só Node.js); roda em qualquer computador com Node ≥ 22.18.
- Interface em português (pt-BR), usável no celular (390 px) e com toque.
- A WING aceita uma assinatura OSC por vez; outro app conectado pode disputar a assinatura.

## Suposições e pendências

- Limites dos alertas (−45 / −60 / −0,5 dB e tempos de espera) vêm do automix; **calibração na mesa
  real pendente** (`ALERT_LIMITS` em src/alerts.ts).
- Palavras 0/1 do medidor como entrada pré-fader e pré-mute: segue a tabela do protocolo, **ainda não
  conferido na WING real**.
- Escrita de ganho e a lista de parâmetros de gate/compressor ainda não foram testadas na mesa real.
- O que já foi testado na mesa real está em "Testado na mesa real" no README.

## Critérios de aceite (gerais)

- `npm run check` passa (tipos, lint, regras de lint e testes).
- Nenhum caminho de leitura, gravação ou alerta envia comando de escrita à mesa. Leituras e
  `dryRun` são conferidos nos testes com a mesa falsa (`fake.writes.length === 0`); gravação e
  alertas não importam o cliente da WING, então não têm como escrever.
- `npm run smoke` passa contra a mesa simulada no desktop e no celular.

## Manutenção

Mudou o escopo, o público ou uma restrição: atualize este arquivo. Detalhes técnicos ficam em
docs/architecture.md; uso e rotas, no README.
