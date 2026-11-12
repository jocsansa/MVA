# MVA — WING Remote

## Problema e objetivo

A equipe de som da igreja opera uma Behringer WING (firmware 3.1). O MVA dá ao operador uma
interface no navegador (computador ou celular na mesma rede) para ver e ajustar a mesa, gravar o
que aconteceu em cada culto e receber avisos quando algo dá errado ao vivo.

Objetivo final: um **assistente proativo** que faz o que o técnico líder faria ao lado de um
voluntário: cuida da estrutura de ganho sozinho ou sugere a correção, segue o padrão de mixagem da
igreja, orienta voluntários e, com templo fixo, permite operar eventos pequenos de casa recebendo só
alertas e decisões.

## Público

- **Operador de som** no culto: usa as abas do mixer, os alertas, o assistente e a gravação da
  sessão. O nome do operador é digitado ao iniciar a gravação.
- **Voluntário em treino**: acompanha alertas e sugestões no próprio celular, tablet ou notebook
  (acesso pela rede com código).
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
5. **Assistente de ganho** com três modos, escolhidos na página:
   - **Desligado**: só os alertas.
   - **Sugestivo**: propõe a correção com os comandos exatos; só aplica com o OK do operador.
   - **Automático**: aplica sozinho, com limites (uma correção por vez, cooldown por canal, teto de
     dB por canal, ações por minuto); toda ação pode ser desfeita. Desmutar sempre pede OK.
   Correções de hoje: entrada clipando ou quente → baixar o ganho da fonte; entrada fraca → subir.
   Sempre neutras no volume (o trim de todos os canais da mesma fonte compensa), e na ordem segura
   (primeiro o que abaixa o nível). Tudo vai para a gravação da sessão.
6. **Acesso pela rede** (`LAN=1`): celular, tablet ou notebook na rede da igreja abrem a página com
   um código de acesso; o computador do servidor não precisa de código.

## Próximas fases (fora do teste de 15/11/2026)

1. **Padrão de mixagem da igreja**: aprender, das sessões gravadas com o técnico líder, níveis-alvo
   por canal e por momento do culto; o assistente compara a mix atual com esse padrão.
2. **Modo treino do voluntário**: dicas contínuas para seguir o padrão ("o vocal está 6 dB abaixo do
   padrão do louvor"), no aparelho do voluntário.
3. **Mais correções** no assistente (ex.: microfonia, que precisa de análise de espectro).
4. **Operação remota** (quando houver templo fixo): acesso de fora da igreja por túnel seguro
   (ex.: Tailscale) e login, para eventos pequenos operados de casa com alertas e decisões.
5. **Alinhamento de sistema**: com microfone de medição (os medidores da WING pela rede são só nível).
6. **IA geral (LLM)** para conversar sobre a mix; por enquanto só regras locais, sem internet.

## Fora do escopo

- Acesso pela internet (até a fase de operação remota).
- Outras mesas além da WING.

## Restrições

- **Segurança da mesa real acima de tudo**: somente leitura por padrão; escrita só liberada por
  variável de ambiente e, pelo chat, só com confirmação do usuário, uma por vez. O modo automático
  do assistente escreve sem perguntar **por decisão do usuário (Jocsan, 12/11/2026)**, só quando
  escolhido na página, nunca ao subir o servidor, e dentro dos limites de `ASSIST_LIMITS`.
- Sem dependências de execução (só Node.js); roda em qualquer computador com Node ≥ 22.18.
- Interface em português (pt-BR), usável no celular (390 px) e com toque.
- A WING aceita uma assinatura OSC por vez; outro app conectado pode disputar a assinatura.

## Suposições e pendências

- Limites dos alertas (−45 / −60 / −0,5 dB e tempos de espera) vêm do automix; **calibração na mesa
  real pendente** (`ALERT_LIMITS` em src/alerts.ts).
- Palavras 0/1 do medidor como entrada pré-fader e pré-mute: segue a tabela do protocolo, **ainda não
  conferido na WING real**.
- Escrita de ganho e a lista de parâmetros de gate/compressor ainda não foram testadas na mesa real.
- Assistente: escrita do trim, medidor de entrada antes ou depois do trim (`INPUT_METER_POST_TRIM`),
  passo do ganho dos pré locais e limites (`ASSIST_LIMITS` em src/assistant-rules.ts): **pendentes
  de teste na mesa real** (roteiro em docs/teste-no-culto.md).
- Convivência com o Mixing Station e o app dos retornos conectados à mesma WING: pendente.
- O que já foi testado na mesa real está em "Testado na mesa real" no README.

## Critérios de aceite (gerais)

- `npm run check` passa (tipos, lint, regras de lint e testes).
- Nenhum caminho de leitura, gravação, alerta ou sugestão (plano) envia comando de escrita à mesa;
  o assistente só escreve com OK do operador (sugestivo) ou no modo automático, e nunca sem
  `WING_ALLOW_WRITES=1`.
- Nenhum caminho de leitura, gravação ou alerta envia comando de escrita à mesa. Leituras e
  `dryRun` são conferidos nos testes com a mesa falsa (`fake.writes.length === 0`); gravação e
  alertas não importam o cliente da WING, então não têm como escrever.
- `npm run smoke` passa contra a mesa simulada no desktop e no celular.

## Manutenção

Mudou o escopo, o público ou uma restrição: atualize este arquivo. Detalhes técnicos ficam em
docs/architecture.md; uso e rotas, no README.
