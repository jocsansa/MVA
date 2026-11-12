# Teste no culto (domingo 15/11/2026) — roteiro no Mac

Objetivo: validar o MVA na WING real (leitura, alertas, gravação e assistente) sem arriscar o culto.
Regra de ouro: **o som não depende do MVA**. Se algo estranho acontecer, clique em **Desligado** no
assistente ou feche o servidor (Ctrl+C no Terminal). A mesa continua normal.

## Sábado, em casa (uns 20 min)

1. Instale o **Node.js 24 LTS** pelo instalador do Mac em https://nodejs.org (arquivo `.pkg`).
   No Terminal: `node -v` tem que mostrar `v22.18` ou mais novo.
2. Baixe o projeto e instale:
   ```
   git clone https://github.com/jocsansa/MVA.git
   cd MVA
   git checkout claude/epic-bell-2mxxne
   npm install
   npm run check
   ```
   Se já tiver a pasta: `cd MVA && git fetch && git checkout claude/epic-bell-2mxxne && git pull && npm install`.
3. Ensaio com a mesa simulada (dois Terminais, na pasta MVA):
   ```
   npm run simulate                                              # Terminal 1
   CONSOLE_HOST=127.0.0.1 WING_ALLOW_WRITES=1 LAN=1 npm start    # Terminal 2
   ```
   Abra http://localhost:3000. Na simulação o CH 3 clipa, o CH 4 fica quente e o CH 6 entra fraco
   (a sugestão de "fraco" aparece depois de 1 minuto). Teste **Aplicar**, **Desfazer**, **Ignorar**
   e o **Automático**. No celular (mesmo Wi-Fi), abra o link que o Terminal 2 mostra.
   Na primeira vez o macOS pergunta se o `node` pode **aceitar conexões de entrada**: clique em
   **Permitir** (sem isso os medidores da WING e os celulares não chegam).

## Domingo, antes do culto (chegue uns 40 min antes)

### 1. Conectar e achar a mesa (2 min)

- Ligue o Mac na mesma rede da WING (cabo no roteador/switch da mesa ou o Wi-Fi dela).
- `npm run discover` mostra o IP da WING (ex.: `192.168.0.50`).

### 2. Somente leitura primeiro (5 min)

```
CONSOLE_HOST=<ip-da-wing> LAN=1 npm start
```

Confira na página:
- pílulas **OSC** e **Medidores** verdes, medidores mexendo com o som da passagem;
- nomes dos canais iguais aos da mesa;
- no celular, o link do Terminal (ou o botão **Rede · código** na página) abre a página.

### 3. Convivência com o Mixing Station e o app dos retornos (5 min) — PENDENTE

A WING aceita uma assinatura OSC por vez. Com o Mixing Station e o app dos retornos conectados:
- mexa um fader no Mixing Station → o MVA mostra a mudança em até ~1 s?
- o Mixing Station e o app dos retornos continuam funcionando normal (faders e medidores)?
- os medidores do MVA continuam mexendo?

Se o MVA parar de ver as mudanças, ele ainda relê tudo a cada 30 s (os alertas continuam com
medidores). Se o Mixing Station ou o app dos retornos falhar, **feche o MVA** e anote o que houve.

### 4. Medidor de entrada: antes ou depois do trim? (5 min) — PENDENTE

Num canal com microfone ligado e alguém falando de forma constante (ou um playback), em outro Terminal:
```
npm run medidor -- <canal>
```
Na **própria WING**, mude o **TRIM** desse canal +6 dB e olhe a coluna "entrada":
- **subiu ~6 dB** → o medidor é depois do trim. Reinicie o servidor com `INPUT_METER_POST_TRIM=1`.
- **não mudou** → o medidor é antes do trim (é o que o app supõe). Nada a fazer.

Volte o trim ao valor original na mesa.

### 5. Escrita supervisionada num canal de teste (10 min) — PENDENTE

Reinicie com escrita liberada (Ctrl+C no Terminal do servidor e):
```
CONSOLE_HOST=<ip-da-wing> WING_ALLOW_WRITES=1 LAN=1 npm start
```
Use um canal com microfone de teste (não o do pastor), **com o fader do canal abaixado e os envios
para os retornos fechados**, para o ganho alto não ir para o PA nem microfonar:
1. Na WING, suba o ganho até a fala alta passar de −5 dBFS no `npm run medidor`.
2. Em até ~20 s aparece a sugestão **"quente: baixar o ganho"** com os comandos exatos.
3. **Aplicar**. Confira na WING: o ganho caiu e o trim subiu o mesmo tanto (o nível depois do trim
   fica igual). Anote o passo do ganho que a mesa usou (ex.: 0,5 ou 2,5 dB).
4. **Desfazer**. Confira que o ganho e o trim voltaram.
5. Se qualquer coisa não bater, deixe o assistente em **Desligado** no culto e me mande o Terminal.

### 6. Durante o culto

- Aba **SESSÕES**: seu nome, momento **Pré-culto** e **Iniciar gravação**. Vá marcando os momentos.
- Assistente: recomendo **Sugestivo** neste primeiro culto (você vê e decide cada correção). Use o
  **Automático** se o passo 5 passou e você quiser validar; o botão **Desligado** para tudo na hora.
- No automático: no máximo 6 ações por minuto, 18 dB por canal, 10 s entre correções no mesmo
  canal. Cada ação aparece com **Desfazer** por 3 minutos e fica no **Histórico**.

### 7. Depois do culto

- **Encerrar gravação** na aba SESSÕES.
- Guarde os arquivos de `MVA/data/sessions/` (um por culto) e o texto do Terminal: são a base para
  calibrar os limites e para a próxima fase (padrão de mixagem).
- Anote: o que ajudou, o que atrapalhou, alarmes falsos, sugestões que você ignoraria.

## O que registrar no README depois (seção "Testado na mesa real")

Passos 3, 4 e 5: convivência com outros apps, posição do medidor de entrada em relação ao trim,
escrita de trim e ganho (passo do pré), e o comportamento do assistente.
