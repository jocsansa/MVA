// Medidor de entrada de um canal, para calibrar o assistente na mesa real (só leitura).
// Uso, com o servidor rodando:  npm run medidor -- 5        (canal 5)
// Imprime 2x por segundo: pico de entrada (palavras 0/1 da WING), ganho da fonte e trim do canal.
// Teste do roteiro: mude o TRIM do canal na própria WING; se a "entrada" acompanhar, o medidor é
// depois do trim (inicie o servidor com INPUT_METER_POST_TRIM=1).

const ch = Number(process.argv[2]);
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(ch) || ch < 1 || ch > 40) {
  console.error("Uso: npm run medidor -- <canal 1..40>");
  process.exit(1);
}
const fmt = (v) => (typeof v === "number" ? v.toFixed(1).padStart(6) : "     —");
let peak = -Infinity;
let since = Date.now();
setInterval(async () => {
  try {
    const st = (await (await fetch(`http://127.0.0.1:${port}/api/state`)).json()).strips.ch[ch - 1];
    const lvl = st.meter?.in;
    if (typeof lvl === "number") peak = Math.max(peak, lvl);
    if (Date.now() - since > 5000) {
      since = Date.now();
      peak = typeof lvl === "number" ? lvl : -Infinity;
    }
    console.log(`CH ${ch} ${st.name.padEnd(16)} entrada ${fmt(lvl)} dBFS  (pico 5 s ${fmt(peak)})  ganho ${fmt(st.gainDb)} dB  trim ${fmt(st.trimDb)} dB`);
  } catch (e) {
    console.log(`Sem resposta do servidor em http://127.0.0.1:${port}: ${e.message}`);
  }
}, 500);
