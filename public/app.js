// Comportamento da página (public/index.html): DOM, rede e eventos. Script clássico, carregado
// depois do bloco mixer-lib, de onde vêm as funções puras (MixerLib).
  const { clamp, METER_FLOOR, meterPct, meterZone, peakValue, peakStep, dbToPos, posToDb, banks, colorGroups,
    fmtNum, fmtDb, fmtPan, parseDb, parsePan, fmtDur, sessionLog } = MixerLib;
  // Cores 1..18 da WING. Tons aproximados (a documentação não traz os valores RGB).
  const COLORS = ["#6b7c93", "#3d6fd1", "#1f3f9e", "#2bb3c0", "#2f9e44", "#7a9a2f", "#e3c02b", "#e8862b", "#d63a3a",
    "#e86a5a", "#e35d9c", "#9b59b6", "#5b4bb7", "#a0a0a0", "#ffffff", "#8b5a2b", "#c0a080", "#404040"];
  const PREFIX = { ch: "CH", aux: "AUX", bus: "BUS", main: "MAIN", mtx: "MTX", dca: "DCA", mgrp: "MGRP" };
  const TAB_IDS = ["faders", "gain", "eq", "dyn", "sends", "overview", "rec"];

  let kinds = [];
  let strips = {};
  let lastStatus = null;
  const load = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
  let tab = load("wing-ui-tab", "faders");
  let bankId = load("wing-ui-bank", "ch:1");
  let uiMode = load("wing-ui-mode", "quick") === "full" ? "full" : "quick";
  let detailOpen = false;
  const stripsEl = document.getElementById("strips");
  const mixerPanel = document.getElementById("mixer");
  const recPanel = document.getElementById("rec");
  const layersEl = document.getElementById("layers");
  const cards = {}; // "ch/1" -> elementos

  // ---------- paleta e escolhas (as únicas janelas da página: não há etapa de confirmação) ----------
  const dlg = {
    root: document.getElementById("dlg"), title: document.getElementById("dlg-title"),
    extra: document.getElementById("dlg-extra"), close: document.getElementById("dlg-cancel"),
  };
  function openPicker(title, content) {
    dlg.title.textContent = title;
    dlg.extra.replaceChildren(content);
    dlg.root.classList.add("open");
    dlg.close.focus();
  }
  function closeDialog() { dlg.root.classList.remove("open"); }
  dlg.close.addEventListener("click", closeDialog);
  dlg.root.addEventListener("click", (e) => { if (e.target === dlg.root) closeDialog(); });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (dlg.root.classList.contains("open")) closeDialog();
    else if (detailOpen && !(document.activeElement && document.activeElement.matches("input"))) closeDetail();
  });

  let toastTimer = null;
  function toast(text, isError) {
    const t = document.getElementById("toast");
    t.textContent = text;
    t.className = "show " + (isError ? "err" : "ok");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.className = ""), 4000);
  }

  // ---------- envio ----------
  async function postJson(url, body) {
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) return { error: "Erro: " + data.error };
      return { data };
    } catch (e) {
      return { error: "Falha: " + e.message };
    }
  }
  async function riskFor(path) {
    try { return (await (await fetch("/api/risk?path=" + encodeURIComponent(path))).json()).risk || ""; } catch { return ""; }
  }

  // ---------- barra de status (uma só para a página) ----------
  // Sem etapa de confirmação (pedido do usuário enquanto não está ao vivo). Antes de enviar a
  // barra mostra o comando OSC exato e o aviso de risco; cada comando é validado pela rota na
  // descrição da mesa, enviado um por vez e lido de volta.
  function statusBar(root) {
    let timer = null;
    const part = (c) => root.querySelector(c);
    const bar = {
      show(kind, main, cmds = [], risks = new Set()) {
        root.className = `status show ${kind}`;
        part(".st-main").textContent = main;
        part(".st-cmd").textContent = cmds.slice(-4).join("\n");
        part(".st-risk").textContent = [...risks].filter(Boolean).map((r) => "⚠ " + r).join(" ");
        clearTimeout(timer);
        if (kind === "ok") timer = setTimeout(bar.hide, 8000);
      },
      hide() { clearTimeout(timer); root.className = "status"; },
    };
    return bar;
  }
  const statusMain = statusBar(document.getElementById("status"));
  document.getElementById("status-x").addEventListener("click", () => statusMain.hide());
  const gridStatus = statusMain, eqStatus = statusMain, sndStatus = statusMain;

  // ---------- escrita direta dos controles dos strips ----------
  // O valor é conferido aqui, a rota valida na descrição da mesa e lê de volta; a barra de
  // status mostra o comando exato e os avisos de risco antes e depois de enviar. Um por vez.
  let gridQueue = Promise.resolve();
  function gridSend({ label, path, command, risks = [], post, done }) {
    gridQueue = gridQueue.then(async () => {
      const rs = new Set(risks.filter(Boolean));
      const risk = path ? await riskFor(path) : "";
      if (risk) rs.add(risk);
      gridStatus.show("sending", `Enviando ${label}:`, [command], rs);
      const r = await post();
      const sent = r.data && r.data.command ? r.data.command : command;
      if (r.data && r.data.risk) rs.add(r.data.risk);
      if (r.error) gridStatus.show("err", `${label}: ${r.error}`.replace(/\.?$/, ".") + " Nada foi alterado.", [command], rs);
      else if (!r.data.ok) gridStatus.show("err", `A mesa não confirmou ${label} (lido: ${r.data.readBack.text}).`, [sent], rs);
      else gridStatus.show(rs.size ? "risk" : "ok", `${label}: enviado e confirmado pela mesa (leitura de volta).`, [sent], rs);
      if (done) done();
    });
  }
  const postParam = (path, value) => postJson("/api/param", { path, value });

  // ---------- campos editáveis (Enter confirma, Esc desfaz) ----------
  function bindEditable(input, currentText, onCommit) {
    input.addEventListener("focus", () => { if (!input.readOnly) { input.dataset.editing = "1"; input.select(); } });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); input.blur(); }
      if (e.key === "Escape") { input.value = currentText(); input.blur(); }
    });
    input.addEventListener("blur", () => {
      if (input.value !== currentText()) onCommit(input.value);
      else delete input.dataset.editing;
    });
  }
  function endEdit(input, text) { delete input.dataset.editing; input.value = text; }

  /**
   * Arrastar para mudar um valor (relativo: tocar sem mover não muda nada; Shift = fino).
   * o: { axis "x"|"y", enabled(), get() -> número, perPx() (unidades por pixel), min, max,
   * start()?, apply(v) (durante o arraste), end()?, commit(v) (ao soltar), tap()? (toque sem mover) }.
   */
  function dragEdit(target, o) {
    target.addEventListener("pointerdown", (e) => {
      if (e.button > 0 || !o.enabled()) return;
      const v0 = o.get();
      if (typeof v0 !== "number" || !Number.isFinite(v0)) return;
      e.preventDefault();
      try { target.setPointerCapture(e.pointerId); } catch {}
      const d = { id: e.pointerId, x: e.clientX, y: e.clientY, v0, v: v0, moved: false, k: o.perPx() };
      const move = (ev) => {
        if (ev.pointerId !== d.id) return;
        const delta = o.axis === "x" ? ev.clientX - d.x : d.y - ev.clientY;
        if (!d.moved) {
          if (Math.abs(delta) < 4) return;
          d.moved = true;
          if (o.start) o.start();
        }
        d.v = clamp(d.v0 + delta * d.k * (ev.shiftKey ? 0.25 : 1), o.min, o.max);
        o.apply(d.v);
      };
      const up = (ev) => {
        if (ev.pointerId !== d.id) return;
        target.removeEventListener("pointermove", move);
        target.removeEventListener("pointerup", up);
        target.removeEventListener("pointercancel", up);
        if (d.moved) { if (o.end) o.end(); o.commit(d.v); }
        else if (o.tap) o.tap();
      };
      target.addEventListener("pointermove", move);
      target.addEventListener("pointerup", up);
      target.addEventListener("pointercancel", up);
    });
  }
  /** Toque sem arrastar num campo de valor: abre para digitar. */
  const focusInput = (input) => () => { input.focus(); input.select(); };

  const label = (st) => st.name || `${PREFIX[st.kind]} ${st.index}`;
  // Estado atual do strip (o objeto é trocado a cada evento da mesa).
  const now = (st) => strips[st.kind][st.index - 1];
  const writable = () => !!(lastStatus && lastStatus.writesEnabled);

  function editName(st, c, text) {
    const revert = () => endEdit(c.name, now(st).name);
    if (!writable()) return revert();
    const error = text.length > 16 ? "máximo de 16 caracteres." : !/^[\x20-\x7e]*$/.test(text) ? "use só letras sem acento, números e símbolos." : null;
    if (error) { toast(`Nome de ${PREFIX[st.kind]} ${st.index}: ${error}`, true); return revert(); }
    const path = `/${st.kind}/${st.index}/name`;
    gridSend({ label: `nome de ${PREFIX[st.kind]} ${st.index}`, path, command: `${path} ,s ${JSON.stringify(text)}`,
      post: () => postParam(path, text), done: revert });
  }

  function editFader(st, c, text) {
    const db = parseDb(text);
    if (Number.isNaN(db)) {
      toast(`Fader de ${label(st)}: digite um número em dB (ex.: -5, 0, +3) ou -inf.`, true);
      c.pendFdr = null;
      endEdit(c.fdrIn, fmtNum(now(st).faderDb));
      return renderFader(c);
    }
    commitFader(st, c, db);
  }
  /** Envia o fader (arraste, roda, teclado ou valor digitado); fica pendente até a mesa responder. */
  function commitFader(st, c, db) {
    const revert = () => { c.pendFdr = null; endEdit(c.fdrIn, fmtNum(now(st).faderDb)); renderFader(c); };
    if (!writable()) return revert();
    if (db < -144 || db > 10) { toast(`Fader de ${label(st)}: o fader vai de -∞ (-144) até +10 dB.`, true); return revert(); }
    if (db === st.faderDb) { gridStatus.hide(); return revert(); }
    c.pendFdr = db;
    renderFader(c);
    const path = `/${st.kind}/${st.index}/fdr`;
    gridSend({ label: `fader de ${label(st)} (${fmtDb(db)})`, path, command: `${path} ,f ${db}`,
      risks: [db > (st.faderDb ?? -144) + 6 ? "Aumento de mais de 6 dB." : ""],
      post: () => postParam(path, db), done: revert });
  }

  function editPan(st, c, text) {
    const revert = () => { c.pendPan = null; endEdit(c.pan, fmtPan(now(st).pan)); renderCard(c); };
    if (!writable()) return revert();
    const v = parsePan(text);
    const error = Number.isNaN(v) ? "use L30, R20, C ou um número de -100 a 100." : (v < -100 || v > 100) ? "o pan vai de L100 a R100." : null;
    if (error) { toast(`Pan de ${label(st)}: ${error}`, true); return revert(); }
    if (v === Math.round(st.pan ?? NaN)) return revert();
    c.pendPan = v;
    const path = `/${st.kind}/${st.index}/pan`;
    gridSend({ label: `pan de ${label(st)} (${fmtPan(v)})`, path, command: `${path} ,f ${v}`,
      post: () => postParam(path, v), done: revert });
  }

  function toggle(st, key, param, word) {
    if (!writable() || st[key] == null) return;
    const on = !st[key];
    const path = `/${st.kind}/${st.index}/${param}`;
    gridSend({ label: `${on ? word[0] : word[1]} "${label(st)}"`, path, command: `${path} ,i ${on ? 1 : 0}`,
      post: () => postParam(path, on ? 1 : 0) });
  }
  const toggleMute = (st) => toggle(st, "mute", "mute", ["Mutar", "Desmutar", "mutado", "desmutado"]);
  const toggleSolo = (st) => toggle(st, "solo", "$solo", ["Ligar solo de", "Desligar solo de", "solo ligado", "solo desligado"]);

  function editColor(st) {
    if (!writable()) return;
    const box = document.createElement("div");
    box.className = "swatches";
    const path = `/${st.kind}/${st.index}/col`;
    COLORS.forEach((hex, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.style.background = hex;
      b.textContent = i + 1;
      b.title = `Cor ${i + 1}`;
      if (i + 1 === st.col) b.classList.add("sel");
      // Tocar na cor já envia (sem etapa de confirmação).
      b.addEventListener("click", () => {
        closeDialog();
        if (i + 1 === now(st).col) return;
        gridSend({ label: `cor de ${label(st)} (${i + 1})`, path, command: `${path} ,i ${i + 1}`, post: () => postParam(path, i + 1) });
      });
      box.appendChild(b);
    });
    openPicker(`Cor de "${label(st)}"`, box);
  }

  // Ganho fica na fonte do canal: rota própria que confere a fonte antes de escrever.
  async function editGain(st, c, text) {
    const revert = () => { c.pendGain = null; endEdit(c.gain, fmtNum(now(st).gainDb)); renderCard(c); };
    if (!writable()) return revert();
    const db = parseDb(text);
    let error = Number.isNaN(db) ? "digite um número em dB (ex.: 20, 32.5)." : null;
    if (!error && db === st.gainDb) return revert();
    let src = null;
    if (!error) {
      try {
        const res = await fetch(`/api/channels/${st.index}/source`);
        src = await res.json();
        if (!res.ok) error = src.error;
        else if (!src.gainAddress) error = `este canal usa a fonte ${src.grp} ${src.in}, que não tem ganho ajustável.`;
      } catch (e) {
        error = "não foi possível ler a fonte do canal: " + e.message;
      }
    }
    if (error) { toast(`Ganho de ${label(st)}: ${error}`, true); return revert(); }
    c.pendGain = db;
    const srcName = `${src.grp} ${src.in}${src.alt ? " (entrada alternativa)" : ""}`;
    gridSend({
      label: `ganho de ${label(st)} (fonte ${srcName}, ${fmtDb(db)})`, path: src.gainAddress, command: `${src.gainAddress} ,f ${db}`,
      risks: [`O ganho fica na fonte ${srcName}: muda em todos os canais que usam essa fonte.`,
        db > (st.gainDb ?? 0) + 6 ? "Aumento de mais de 6 dB." : ""],
      post: async () => {
        const r = await postJson(`/api/channels/${st.index}/gain`, { db });
        if (r.data) r.data = { ...r.data, readBack: { text: fmtDb(r.data.readBack) } };
        return r;
      },
      done: revert,
    });
  }

  // ---------- strips ----------
  function info(kind) { return kinds.find((k) => k.kind === kind); }
  const has = (kind, p) => info(kind).params.includes(p);
  const chColor = (st) => st && st.col ? COLORS[st.col - 1] : "#6b7c93";

  /** Medidor fino L/R com pico retido. */
  function meterBox() {
    const el = document.createElement("span");
    el.className = "mtr";
    el.setAttribute("aria-hidden", "true");
    el.innerHTML = `<i class="mb"><i class="pk"></i></i><i class="mb"><i class="pk"></i></i>`;
    const bars = el.querySelectorAll(".mb");
    let pk = [null, null];
    return {
      el,
      set(m) {
        const t = performance.now();
        [m && m.l, m && m.r].forEach((db, i) => {
          pk[i] = peakStep(pk[i], db, t);
          const p = peakValue(pk[i], t);
          bars[i].style.setProperty("--h", meterPct(db) + "%");
          bars[i].style.setProperty("--p", meterPct(p) + "%");
          bars[i].dataset.z = p > METER_FLOOR ? meterZone(p) : "";
        });
      },
      reset() { pk = [null, null]; },
    };
  }

  const FDR_TICKS = [[10, "+10"], [5, "+5"], [0, "0"], [-10, "-10"], [-20, "-20"], [-30, "-30"], [-40, "-40"], [-60, "-60"], [-144, "-∞"]]
    .map(([db, t]) => `<span${db === 0 ? ' class="u"' : ""} style="bottom:${(dbToPos(db) * 100).toFixed(2)}%">${t}</span>`).join("");

  // Cada strip tem uma parte de cima por aba (só a visível aparece) e embaixo nome, mute/solo,
  // fader com medidor e valor em dB. Trocar de aba não move os strips.
  function card(st) {
    const key = `${st.kind}/${st.index}`;
    if (cards[key]) return cards[key];
    const k = info(st.kind), id = `${PREFIX[st.kind]} ${st.index}`, isCh = st.kind === "ch";
    const hasPan = has(st.kind, "pan"), hasGain = has(st.kind, "in/set/$g"), hasFdr = has(st.kind, "fdr");
    const none = '<span class="t-none">—</span>';
    const field = 'inputmode="decimal" autocomplete="off" spellcheck="false" readonly';
    const el = document.createElement("div");
    el.className = "strip";
    el.innerHTML = `<div class="s-top">
        <div class="t t-faders">${hasPan ? '<span class="pan-ind" aria-hidden="true"><i></i></span><span class="pan-txt"></span>' : none}</div>
        <div class="t t-gain">
          ${hasGain ? `<div class="knob"><span class="k-l">GANHO <small>dB</small></span><input class="k-v gain" ${field} aria-label="Ganho de ${id} em dB"><span class="k-bar"><i></i></span></div>` : ""}
          ${hasPan ? `<div class="knob full-only"><span class="k-l">PAN</span><input class="k-v pan" ${field} aria-label="Pan de ${id}"><span class="k-bar pan-bar"><i></i></span></div>` : ""}
          ${!hasGain ? `<span class="t-none${hasPan ? " quick-only" : ""}">—</span>` : ""}
        </div>
        <div class="t t-eq">${isCh ? `<button type="button" class="t-open eq-open" aria-label="Abrir EQ de ${id}"><b>EQ</b><small>abrir ›</small></button>` : none}</div>
        <div class="t t-dyn">${isCh ? `<button type="button" class="t-open dyn-open" aria-label="Abrir gate e compressor de ${id}" title="Redução de ganho: G = gate, C = compressor"><span class="grt"><b>G</b><i class="gr-g"></i></span><span class="grt"><b>C</b><i class="gr-c"></i></span></button>` : none}</div>
        <div class="t t-sends snd-slot"></div>
      </div>
      <div class="s-id">
        ${has(st.kind, "col") ? '<button type="button" class="s-col full-only" title="Cor" aria-label="Cor"></button>' : ""}
        <span class="s-num">${id}</span>
        <input class="s-name" maxlength="16" placeholder="(sem nome)" spellcheck="false" autocomplete="off" readonly aria-label="Nome de ${id}">
      </div>
      <div class="s-btns"><button type="button" class="sbtn mute" disabled>MUTE</button>
        ${has(st.kind, "$solo") ? '<button type="button" class="sbtn solo" disabled>SOLO</button>' : ""}</div>
      <div class="s-body">${hasFdr ? `<div class="fdr" tabindex="0" role="slider" aria-label="Fader de ${id}" aria-valuemin="-144" aria-valuemax="10">
        <div class="fdr-track"></div><div class="fdr-ticks">${FDR_TICKS}</div><div class="fdr-cap"></div></div>` : '<div class="fdr-none"></div>'}</div>
      <div class="s-db">${hasFdr ? `<input class="fdr-v" ${field} aria-label="Fader de ${id} em dB"><span>dB</span>` : ""}</div>`;
    const q = (s) => el.querySelector(s);
    const c = {
      el, st, name: q(".s-name"), colBtn: q(".s-col"), mute: q(".mute"), solo: q(".solo"),
      fdrEl: q(".fdr"), cap: q(".fdr-cap"), fdrIn: q(".fdr-v"), pan: q(".k-v.pan"), gain: q(".k-v.gain"),
      panInd: q(".pan-ind"), panTxt: q(".pan-txt"), panBar: q(".pan-bar"), gainBar: q(".k-v.gain + .k-bar"),
      grG: q(".gr-g"), grC: q(".gr-c"), sndSlot: q(".snd-slot"), meter: null,
      pendFdr: null, pendPan: null, pendGain: null, nudgeT: null,
    };
    if (k.meter) { c.meter = meterBox(); q(".s-body").appendChild(c.meter.el); }
    const cur = () => strips[st.kind][st.index - 1];
    // Tocar em qualquer parte do strip seleciona o canal.
    el.addEventListener("pointerdown", () => selectStrip(st.kind, st.index), true);
    bindEditable(c.name, () => cur().name, (t) => editName(cur(), c, t));
    c.mute.addEventListener("click", () => toggleMute(cur()));
    if (c.solo) c.solo.addEventListener("click", () => toggleSolo(cur()));
    if (c.colBtn) c.colBtn.addEventListener("click", () => editColor(cur()));
    const eqBtn = q(".eq-open"), dynBtn = q(".dyn-open");
    if (eqBtn) eqBtn.addEventListener("click", () => openDetail(st.index));
    if (dynBtn) dynBtn.addEventListener("click", () => openDetail(st.index));
    if (c.fdrEl) {
      c.fdrIn.value = "—";
      bindEditable(c.fdrIn, () => fmtNum(c.pendFdr ?? cur().faderDb), (t) => editFader(cur(), c, t));
      dragEdit(c.fdrEl, {
        axis: "y", min: 0, max: 1, enabled: () => writable() && cur().faderDb != null,
        get: () => dbToPos(c.pendFdr ?? cur().faderDb), perPx: () => 1 / Math.max(60, c.fdrEl.clientHeight - 28),
        apply: (p) => {
          c.pendFdr = posToDb(p);
          renderFader(c);
          gridStatus.show("sending", `Ao soltar, envia o fader de ${label(cur())}:`, [`/${st.kind}/${st.index}/fdr ,f ${c.pendFdr}`]);
        },
        commit: (p) => commitFader(cur(), c, posToDb(p)),
      });
      // Roda do mouse e setas: envia depois de uma pausa (um comando com o valor final).
      const nudge = (step) => {
        const v = c.pendFdr ?? cur().faderDb;
        if (!writable() || typeof v !== "number") return;
        let next = v <= -144 ? (step > 0 ? -60 : -144) : Math.min(10, v + step);
        if (next < -90) next = -144;
        c.pendFdr = Math.round(next * 10) / 10;
        renderFader(c);
        clearTimeout(c.nudgeT);
        c.nudgeT = setTimeout(() => commitFader(cur(), c, c.pendFdr), 450);
      };
      c.fdrEl.addEventListener("keydown", (e) => {
        const step = { ArrowUp: 1, ArrowDown: -1, PageUp: 6, PageDown: -6 }[e.key];
        if (!step) return;
        e.preventDefault();
        nudge(e.shiftKey ? step / 10 : step);
      });
      c.fdrEl.addEventListener("wheel", (e) => { if (!writable()) return; e.preventDefault(); nudge(e.deltaY < 0 ? 0.5 : -0.5); }, { passive: false });
    }
    if (c.pan) {
      c.pan.value = "—";
      bindEditable(c.pan, () => fmtPan(c.pendPan ?? cur().pan), (t) => editPan(cur(), c, t));
      dragEdit(c.pan, {
        axis: "x", min: -100, max: 100, enabled: () => writable() && cur().pan != null && !c.pan.dataset.editing,
        get: () => c.pendPan ?? Math.round(cur().pan), perPx: () => 1,
        apply: (v) => { c.pendPan = Math.round(v); renderCard(c); },
        commit: (v) => editPan(cur(), c, String(Math.round(v))), tap: focusInput(c.pan),
      });
    }
    if (c.gain) {
      c.gain.value = "—";
      bindEditable(c.gain, () => fmtNum(c.pendGain ?? cur().gainDb), (t) => editGain(cur(), c, t));
      dragEdit(c.gain, {
        axis: "y", min: -2, max: 45.5, enabled: () => writable() && cur().gainDb != null && !c.gain.dataset.editing,
        get: () => c.pendGain ?? cur().gainDb, perPx: () => 0.25,
        apply: (v) => { c.pendGain = Math.round(v * 2) / 2; renderCard(c); },
        commit: (v) => editGain(cur(), c, String(Math.round(v * 2) / 2)), tap: focusInput(c.gain),
      });
    }
    cards[key] = c;
    mountSend(c);
    return c;
  }

  function renderFader(c) {
    if (!c.fdrEl) return;
    const st = now(c.st), db = c.pendFdr ?? st.faderDb, p = dbToPos(db);
    c.cap.style.bottom = `calc(14px + ${p} * (100% - 28px))`;
    c.fdrEl.classList.toggle("pend", c.pendFdr != null);
    c.fdrEl.setAttribute("aria-valuenow", db == null ? "" : String(db));
    c.fdrEl.setAttribute("aria-valuetext", db == null ? "sem leitura" : fmtDb(db));
    if (!c.fdrIn.dataset.editing && document.activeElement !== c.fdrIn) c.fdrIn.value = fmtNum(db);
  }

  function renderCard(c) {
    const st = now(c.st), w = writable();
    if (!c.name.dataset.editing && c.name.value !== st.name && document.activeElement !== c.name) c.name.value = st.name;
    c.el.style.setProperty("--cc", st.col ? COLORS[st.col - 1] : "var(--edge)");
    c.el.classList.toggle("muted", st.mute === true);
    c.el.classList.toggle("soloed", st.solo === true);
    c.el.classList.toggle("sel", isSel(st));
    c.mute.textContent = st.mute == null ? "—" : "MUTE";
    c.mute.classList.toggle("on", st.mute === true);
    c.mute.setAttribute("aria-pressed", String(st.mute === true));
    c.mute.disabled = !w || st.mute == null;
    if (c.solo) {
      c.solo.classList.toggle("on", st.solo === true);
      c.solo.setAttribute("aria-pressed", String(st.solo === true));
      c.solo.disabled = !w || st.solo == null;
    }
    // Nome e cor só se editam no modo Completo.
    c.name.readOnly = !w || uiMode !== "full";
    if (c.colBtn) c.colBtn.disabled = !w;
    if (c.fdrEl) { renderFader(c); c.fdrIn.readOnly = !w || st.faderDb == null; }
    const pan = c.pendPan ?? st.pan;
    const panX = pan == null ? "50%" : `${(pan + 100) / 2}%`;
    if (c.panInd) { c.panInd.style.setProperty("--x", panX); c.panTxt.textContent = fmtPan(pan); }
    if (c.pan) {
      if (!c.pan.dataset.editing && document.activeElement !== c.pan) c.pan.value = fmtPan(pan);
      c.pan.readOnly = !w || st.pan == null;
      c.panBar.style.setProperty("--x", panX);
    }
    if (c.gain) {
      const g = c.pendGain ?? st.gainDb;
      if (!c.gain.dataset.editing && document.activeElement !== c.gain) c.gain.value = fmtNum(g);
      c.gain.readOnly = !w || st.gainDb == null;
      c.gainBar.style.setProperty("--w", g == null ? "0%" : `${clamp(((g + 2) / 47.5) * 100, 0, 100)}%`);
    }
    renderMeter(st);
  }

  function render(st) {
    strips[st.kind][st.index - 1] = st;
    if (st.kind === "ch") updateChip(st);
    onStripForSends(st);
    if (tab === "overview") renderOvStrip(st);
    const c = cards[`${st.kind}/${st.index}`];
    if (c && c.el.isConnected) renderCard(c);
  }

  const setGr = (el, g, full) => el.style.setProperty("--w", `${typeof g === "number" ? Math.min(100, (Math.max(0, -g) / full) * 100) : 0}%`);
  function renderMeter(st) {
    const c = cards[`${st.kind}/${st.index}`];
    if (!c || !c.el.isConnected) return;
    if (c.meter) c.meter.set(st.meter);
    if (c.grG && tab === "dyn") { setGr(c.grG, st.meter && st.meter.gate, 30); setGr(c.grC, st.meter && st.meter.dyn, 24); }
  }

  // ---------- seleção ----------
  let sel = (() => { const m = /^(\w+)\/(\d+)$/.exec(load("wing-ui-sel", "ch/1")); return m ? { kind: m[1], index: Number(m[2]) } : { kind: "ch", index: 1 }; })();
  const isSel = (st) => st.kind === sel.kind && st.index === sel.index;
  function selectStrip(kind, index) {
    if (sel.kind === kind && sel.index === index) return;
    if (kind === "ch" && index !== eqCh && !switchEqChannel(index)) return;
    setSel(kind, index);
  }
  function setSel(kind, index) {
    sel = { kind, index };
    save("wing-ui-sel", `${kind}/${index}`);
    for (const c of Object.values(cards)) if (c.el.isConnected) c.el.classList.toggle("sel", isSel(c.st));
    if (tab === "overview") renderOverview();
    renderCtx();
  }

  // ---------- abas e camadas ----------
  const ctxEl = document.getElementById("ctx");
  const isDetailTab = (t) => t === "eq" || t === "dyn";
  function showTab(t) {
    if (!TAB_IDS.includes(t)) t = "faders";
    if (t !== tab && isDetailTab(tab) && detailOpen && (eqWriter.sending || dynWriter.sending || drag || dynDrag)) {
      return toast("Aguarde o envio terminar.", true);
    }
    tab = t;
    save("wing-ui-tab", t);
    document.body.dataset.tab = t;
    document.querySelectorAll("#tabs button").forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === t);
      b.setAttribute("aria-selected", String(b.dataset.tab === t));
      // No celular a faixa de abas rola: mantém a aba ativa à vista.
      if (b.dataset.tab === t) b.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    if (t === "eq") chSection = "eq";
    if (t === "dyn") chSection = dynSec;
    const detail = detailOpen && isDetailTab(t);
    mixerPanel.hidden = t === "overview" || t === "rec" || detail;
    eqPanel.hidden = !detail;
    ovPanel.hidden = t !== "overview";
    recPanel.hidden = t !== "rec";
    layersEl.hidden = t === "overview" || t === "rec" || detail;
    document.getElementById("sends-ctx").hidden = t !== "sends";
    renderCtx();
    if (t === "rec") return loadSessions();
    if (!kinds.length) return;
    if (detail) return showEq();
    if (t === "overview") return renderOverview();
    showBank();
    if (t === "sends") showSends();
  }

  function renderCtx() {
    const hint = document.getElementById("ctx-hint"), open = document.getElementById("ctx-open");
    const detail = detailOpen && isDetailTab(tab);
    let text = "";
    if (tab === "gain") text = "Arraste o valor (ganho para cima/baixo, pan para os lados) ou toque para digitar.";
    else if (isDetailTab(tab) && !detail) text = `Toque no ${tab === "eq" ? "EQ" : "gate/compressor"} de um canal para abrir os detalhes.`;
    else if (tab === "overview") text = "Medidores de todas as entradas, agrupados pela cor. Toque num medidor para selecionar o canal.";
    hint.textContent = text;
    const canOpen = isDetailTab(tab) && !detail && sel.kind === "ch" && strips.ch;
    open.hidden = !canOpen;
    if (canOpen) {
      const st = strips.ch[sel.index - 1];
      open.textContent = `Abrir CH ${sel.index}${st && st.name ? " · " + st.name : ""} ›`;
    }
    ctxEl.hidden = !text && !canOpen && tab !== "sends";
  }
  document.getElementById("ctx-open").addEventListener("click", () => { if (sel.kind === "ch") openDetail(sel.index); });

  function bankList() { return banks(kinds); }
  function currentBank() {
    const list = bankList();
    return list.find((b) => b.id === bankId) || list[0];
  }
  function buildLayers() {
    layersEl.replaceChildren();
    let last = null;
    for (const b of bankList()) {
      if (last && last !== b.kind) { const g = document.createElement("span"); g.className = "gap"; layersEl.appendChild(g); }
      last = b.kind;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.bank = b.id;
      btn.textContent = b.label;
      btn.addEventListener("click", () => { bankId = b.id; save("wing-ui-bank", b.id); showBank(); if (tab === "sends") renderSends(); });
      layersEl.appendChild(btn);
    }
  }
  function showBank() {
    const b = currentBank();
    if (!b) return;
    bankId = b.id;
    layersEl.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x.dataset.bank === b.id));
    const list = strips[b.kind].slice(b.start - 1, b.end);
    stripsEl.replaceChildren(...list.map((st) => { const c = card(st); c.el.hidden = false; return c.el; }));
    for (const st of list) renderCard(card(st));
    markAlertStrips();
  }

  // ---------- Rápido / Completo ----------
  function setMode(m) {
    uiMode = m;
    save("wing-ui-mode", m);
    document.body.classList.toggle("quick", m === "quick");
    document.body.classList.toggle("full", m === "full");
    document.getElementById("ui-quick").classList.toggle("on", m === "quick");
    document.getElementById("ui-full").classList.toggle("on", m === "full");
    document.getElementById("ui-quick").setAttribute("aria-pressed", String(m === "quick"));
    document.getElementById("ui-full").setAttribute("aria-pressed", String(m === "full"));
    for (const c of Object.values(cards)) if (c.el.isConnected) renderCard(c);
    if (!eqPanel.hidden) renderEq();
  }
  document.getElementById("ui-quick").addEventListener("click", () => setMode("quick"));
  document.getElementById("ui-full").addEventListener("click", () => setMode("full"));
  document.querySelectorAll("#tabs button").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.tab === tab && detailOpen && isDetailTab(tab)) return closeDetail();
    showTab(b.dataset.tab);
  }));

  // ---------- detalhe do canal ----------
  function openDetail(ch) {
    if (ch !== eqCh && !switchEqChannel(ch)) return;
    setSel("ch", ch);
    detailOpen = true;
    if (!isDetailTab(tab)) tab = "eq";
    showTab(tab);
  }
  function closeDetail() {
    if (eqWriter.sending || dynWriter.sending || drag || dynDrag) return toast("Aguarde o envio terminar.", true);
    detailOpen = false;
    showTab(tab);
  }
  document.getElementById("det-close").addEventListener("click", closeDetail);

  // ---------- OVERVIEW: ponte de medidores ----------
  // Todas as entradas (canais e aux) agrupadas pela cor; o canal selecionado fica fixo à
  // esquerda e o MAIN LR (MAIN 1) fixo à direita.
  const ovPanel = document.getElementById("overview");
  const ovBridge = document.getElementById("ov-bridge");
  const OV_KINDS = ["ch", "aux"];
  let ovKey = "";
  const ovCells = new Map(); // "ch/1" -> { el, m }

  function ovCell(st) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ovm";
    const m = meterBox();
    b.append(m.el);
    b.insertAdjacentHTML("beforeend", `<span class="ovm-n"></span><span class="ovm-name"></span>`);
    b.querySelector(".ovm-n").textContent = st.kind === "ch" ? String(st.index) : `A${st.index}`;
    b.addEventListener("click", () => selectStrip(st.kind, st.index));
    return { el: b, m };
  }
  function renderOvStrip(st) {
    const x = ovCells.get(`${st.kind}/${st.index}`);
    if (x) {
      x.el.querySelector(".ovm-name").textContent = st.name || "—";
      x.el.title = `${PREFIX[st.kind]} ${st.index}${st.name ? " · " + st.name : ""}${st.mute ? " (mute)" : ""}`;
      x.el.classList.toggle("muted", st.mute === true);
      x.el.classList.toggle("sel", isSel(st));
      x.el.setAttribute("aria-pressed", String(isSel(st)));
    }
    if (isSel(st) || (st.kind === "main" && st.index === 1)) renderOvPins();
    if (OV_KINDS.includes(st.kind)) {
      const key = ovGroupKey();
      if (key !== ovKey) renderOverview();
    }
  }
  const ovGroupKey = () => colorGroups(OV_KINDS.flatMap((k) => strips[k] || [])).map((g) => g.col + ":" + g.items.map((s) => s.kind + s.index).join(",")).join("|");
  function renderOverview() {
    if (ovPanel.hidden || !kinds.length) return;
    const key = ovGroupKey();
    if (key !== ovKey) {
      ovKey = key;
      ovCells.clear();
      ovBridge.replaceChildren();
      for (const g of colorGroups(OV_KINDS.flatMap((k) => strips[k] || []))) {
        const box = document.createElement("div");
        box.className = "ov-grp";
        box.style.setProperty("--gc", g.col ? COLORS[g.col - 1] : "var(--edge)");
        box.setAttribute("aria-label", g.col ? `Cor ${g.col}` : "Sem cor");
        const row = document.createElement("div");
        row.className = "ov-ms";
        for (const st of g.items) {
          const x = ovCell(st);
          ovCells.set(`${st.kind}/${st.index}`, x);
          row.appendChild(x.el);
        }
        box.appendChild(row);
        ovBridge.appendChild(box);
      }
    }
    for (const k of OV_KINDS) for (const st of strips[k] || []) {
      const x = ovCells.get(`${st.kind}/${st.index}`);
      if (!x) continue;
      x.el.querySelector(".ovm-name").textContent = st.name || "—";
      x.el.title = `${PREFIX[st.kind]} ${st.index}${st.name ? " · " + st.name : ""}${st.mute ? " (mute)" : ""}`;
      x.el.classList.toggle("muted", st.mute === true);
      x.el.classList.toggle("sel", isSel(st));
      x.el.setAttribute("aria-pressed", String(isSel(st)));
    }
    renderOvPins();
    renderOvMeters();
  }

  /** Coluna fixa: nome, medidor grande, fader em dB e mute/solo. */
  function ovPin(root, title) {
    root.innerHTML = `<span class="k-l"></span><span class="ov-pin-name"></span><span class="ov-pin-db"></span>
      <div class="ov-btns"><button type="button" class="sbtn mute">MUTE</button><button type="button" class="sbtn solo">SOLO</button></div>`;
    const m = meterBox();
    root.insertBefore(m.el, root.querySelector(".ov-pin-db"));
    const p = { root, m, key: "", title, l: root.querySelector(".k-l"), name: root.querySelector(".ov-pin-name"),
      db: root.querySelector(".ov-pin-db"), mute: root.querySelector(".mute"), solo: root.querySelector(".solo"), st: null };
    p.mute.addEventListener("click", () => { if (p.st) toggleMute(now(p.st)); });
    p.solo.addEventListener("click", () => { if (p.st) toggleSolo(now(p.st)); });
    return p;
  }
  let pinSel = null, pinMain = null;
  function renderPin(p, st, extraTitle) {
    if (!st) return;
    const key = `${st.kind}/${st.index}`;
    if (p.key !== key) { p.key = key; p.m.reset(); }
    p.st = st;
    const w = writable();
    p.root.style.setProperty("--cc", st.col ? COLORS[st.col - 1] : "var(--edge)");
    p.l.textContent = `${extraTitle} · ${PREFIX[st.kind]} ${st.index}`;
    p.name.textContent = st.name || `${PREFIX[st.kind]} ${st.index}`;
    p.name.classList.toggle("muted", st.mute === true);
    p.db.innerHTML = has(st.kind, "fdr") ? `${fmtNum(st.faderDb)} <small>dB</small>` : "";
    p.mute.classList.toggle("on", st.mute === true);
    p.mute.setAttribute("aria-pressed", String(st.mute === true));
    p.mute.disabled = !w || st.mute == null;
    p.solo.hidden = !has(st.kind, "$solo");
    p.solo.classList.toggle("on", st.solo === true);
    p.solo.setAttribute("aria-pressed", String(st.solo === true));
    p.solo.disabled = !w || st.solo == null;
    p.m.el.hidden = !info(st.kind).meter;
  }
  function renderOvPins() {
    if (ovPanel.hidden) return;
    if (!pinSel) { pinSel = ovPin(document.getElementById("ov-sel")); pinMain = ovPin(document.getElementById("ov-main")); }
    document.getElementById("ov-sel").classList.add("sel");
    renderPin(pinSel, strips[sel.kind] && strips[sel.kind][sel.index - 1], "Selecionado");
    renderPin(pinMain, strips.main && strips.main[0], "MAIN LR");
  }
  function renderOvMeters() {
    if (ovPanel.hidden) return;
    for (const [key, x] of ovCells) {
      const [kind, n] = key.split("/");
      const st = strips[kind] && strips[kind][Number(n) - 1];
      if (st) x.m.set(st.meter);
    }
    if (pinSel && pinSel.st) pinSel.m.set(now(pinSel.st).meter);
    if (pinMain && pinMain.st) pinMain.m.set(now(pinMain.st).meter);
  }

  // ---------- painel de EQ ----------
  // Sem etapa de confirmação (pedido do usuário enquanto não está ao vivo): ao soltar o ponto
  // arrastado, tocar em −/+, digitar ou escolher uma opção, o valor fica PENDENTE (curva branca;
  // a tracejada é o que está na mesa) e é enviado na hora. A rota valida cada comando na
  // descrição da mesa e lê de volta; a barra de status mostra o comando exato e os avisos.
  const BANDS = [
    { id: "l", label: "LOW", short: "L", shape: "leq" }, { id: "1", label: "1", short: "1" },
    { id: "2", label: "2", short: "2" }, { id: "3", label: "3", short: "3" },
    { id: "4", label: "4", short: "4" }, { id: "h", label: "HIGH", short: "H", shape: "heq" },
  ];
  const BAND_COLORS = { l: "#ff6b5e", 1: "#ffb02e", 2: "#f2e94e", 3: "#4be37a", 4: "#3ec8ff", h: "#d08bff" };
  const DB_RANGE = 18; // a escala vai de -18 a +18 dB (ganho das bandas: ±15)
  const eqPanel = document.getElementById("eq");
  const svg = document.getElementById("eq-graph");
  let curveLib = null;
  let eqCh = Number(load("wing-eq-ch", "1")) || 1;
  // Link direto: http://localhost:3000/#eq/5 abre o EQ do CH 5.
  const eqHash = /^#eq(?:\/(\d+))?$/.exec(location.hash);
  if (eqHash) {
    tab = "eq";
    detailOpen = true;
    if (eqHash[1] && Number(eqHash[1]) >= 1 && Number(eqHash[1]) <= 40) eqCh = Number(eqHash[1]);
  }
  let eqData = null; // GET /api/channels/N/eq
  let eqError = null;
  let eqLoadToken = 0;
  let selBand = "1";
  const pending = new Map(); // "eq/1g" -> valor
  let G = { w: 800, h: 340 };
  let handles = [];
  let drag = null;

  import("/eq-curve.js").then((m) => { curveLib = m; renderEq(); }, () => { eqError = "Não foi possível carregar /eq-curve.js"; renderEq(); });

  const fmtHz = (f) => f >= 1000 ? (f / 1000).toFixed(f >= 10000 ? 1 : 2) + "k" : f.toFixed(f < 100 ? 1 : 0);
  const fmtGain = (g) => (g > 0 ? "+" : "") + g.toFixed(1);
  const fmtQ = (q) => q.toFixed(2);
  // "1k2", "1.2k", "1200", "1200 Hz" -> 1200
  function parseHz(text) {
    const t = text.trim().toLowerCase().replace(",", ".").replace(/\s*hz$/, "");
    let m = /^(\d+)k(\d*)$/.exec(t);
    if (m) return Number(m[1] + "." + (m[2] || "0")) * 1000;
    m = /^(\d+(?:\.\d+)?)k$/.exec(t);
    if (m) return Number(m[1]) * 1000;
    return /^\d+(\.\d+)?$/.test(t) ? Number(t) : NaN;
  }
  const parseNum = (text) => { const t = text.trim().replace(",", ".").replace(/\s*db$/i, ""); return /^[+-]?\d+(\.\d+)?$/.test(t) ? Number(t) : NaN; };
  const inkOn = (hex) => { const n = parseInt(hex.slice(1), 16); return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) > 150 ? "#000" : "#fff"; };

  const eqDesc = (sec, p) => eqData && eqData[sec][p];
  const eqCur = (sec, p) => { const d = eqDesc(sec, p); return d ? d.value : null; };
  const eqVal = (sec, p) => pending.has(`${sec}/${p}`) ? pending.get(`${sec}/${p}`) : eqCur(sec, p);
  const isChanged = (sec, p) => pending.has(`${sec}/${p}`);
  const canEditEq = () => writable() && !!eqData && eqData.editable && !!curveLib;

  function sameValue(d, a, b) {
    if (typeof a !== "number" || typeof b !== "number") return a === b;
    return d.type === "log" ? Math.abs(a / b - 1) < 0.001 : Math.abs(a - b) < 0.005;
  }

  /** Muda o valor pendente (limitado e arredondado ao passo da faixa que a mesa descreveu). */
  function setPending(sec, p, v) {
    const d = eqDesc(sec, p);
    if (!d || !canEditEq() || v == null || (typeof v === "number" && !Number.isFinite(v))) return;
    if (typeof v === "number") v = normalizeNum(d, v);
    const k = `${sec}/${p}`;
    if (sameValue(d, v, d.value)) pending.delete(k);
    else pending.set(k, v);
  }

  /** Número no passo da faixa que a mesa descreveu (int: inteiro dentro da faixa). */
  function normalizeNum(d, v) {
    if (d.type === "int") return Math.round(clamp(v, d.min, d.max));
    if (d.type === "lin" || d.type === "log") {
      const q = curveLib.quantize(v, d);
      return d.type === "log" ? Number(q.toPrecision(5)) : Math.round(q * 100) / 100;
    }
    return d.min !== undefined && d.max !== undefined ? clamp(v, d.min, d.max) : v;
  }

  function curveModel(get) {
    const num = (sec, p) => { const v = get(sec, p); return typeof v === "number" ? v : null; };
    const bands = [];
    for (const b of BANDS) {
      const f = num("eq", b.id + "f"), g = num("eq", b.id + "g"), q = num("eq", b.id + "q");
      if (f == null || g == null || q == null) continue;
      const shape = b.shape && get("eq", b.shape) === "SHV" ? (b.id === "l" ? "low" : "high") : "peq";
      bands.push({ id: b.id, shape, f, g, q });
    }
    const cut = (on, f, s) => num("flt", f) == null ? null : { on: num("flt", on) === 1, f: num("flt", f), slope: Number(get("flt", s)) || 12 };
    return { eqOn: num("eq", "on") === 1, bands, lc: cut("lc", "lcf", "lcs"), hc: cut("hc", "hcf", "hcs") };
  }

  // ---- curva (SVG em pixels: o viewBox acompanha a largura) ----
  const fx = (f) => (Math.log(f / 20) / Math.log(1000)) * G.w;
  const xf = (x) => 20 * Math.pow(1000, clamp(x, 0, G.w) / G.w);
  const dy = (db) => G.h / 2 - (db / DB_RANGE) * (G.h / 2 - 14);
  const yd = (y) => ((G.h / 2 - y) / (G.h / 2 - 14)) * DB_RANGE;

  function drawEq() {
    if (eqPanel.hidden || chSection !== "eq") return;
    const w = Math.max(280, Math.round(document.getElementById("eq-graph-wrap").clientWidth - 2));
    G = { w, h: Math.round(clamp(w * 0.38, 220, 400)) };
    const h = G.h;
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    svg.setAttribute("width", w);
    svg.setAttribute("height", h);
    let s = "";
    for (const f of [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
      const x = fx(f);
      s += `<line class="g${[100, 1000, 10000].includes(f) ? " g-major" : ""}" x1="${x}" x2="${x}" y1="0" y2="${h}"/>`;
      if (f > 20 && f < 20000) s += `<text class="gl" x="${x + 3}" y="${h - 6}">${f >= 1000 ? f / 1000 + "k" : f}</text>`;
    }
    for (const db of [-12, -6, 0, 6, 12]) {
      const y = dy(db);
      s += `<line class="g${db === 0 ? " g-major" : ""}" x1="0" x2="${w}" y1="${y}" y2="${y}"/>`;
      s += `<text class="gl" x="4" y="${y - 4}">${db > 0 ? "+" + db : db}</text>`;
    }
    handles = [];
    if (!eqData || !curveLib) { svg.innerHTML = s; return; }
    const freqs = curveLib.logFreqs(Math.min(480, Math.round(w / 2)));
    const pathFor = (model) => freqs.map((f, i) =>
      `${i ? "L" : "M"}${fx(f).toFixed(1)},${clamp(dy(curveLib.responseDb(model, f)), -4, h + 4).toFixed(1)}`).join("");
    const cur = curveModel(eqCur), next = curveModel(eqVal);
    const main = pathFor(next);
    const st = strips.ch && strips.ch[eqCh - 1];
    s += `<path class="c-fill" style="fill:${chColor(st)}" d="${main}L${w},${dy(0)}L0,${dy(0)}Z"/>`;
    if (pending.size) s += `<path class="c-old" d="${pathFor(cur)}"/>`;
    const sb = next.bands.find((b) => b.id === selBand);
    if (sb && next.eqOn) s += `<path class="c-band" style="stroke:${BAND_COLORS[sb.id]}" d="${pathFor({ eqOn: true, bands: [sb], lc: null, hc: null })}"/>`;
    s += `<path class="c-main" d="${main}"/>`;
    for (const [key, cut, text] of [["lc", next.lc, "HP"], ["hc", next.hc, "LP"]]) {
      if (!cut) continue;
      const x = clamp(fx(cut.f), 20, w - 20), y = h - 36;
      handles.push({ key, filter: true, x, y });
      s += `<g class="h-flt${cut.on ? "" : " off"}"><rect x="${x - 20}" y="${y - 14}" width="40" height="28" rx="7"/>` +
        `<text class="hl" x="${x}" y="${y + 5}">${text}</text></g>`;
    }
    for (const b of next.bands) {
      const x = clamp(fx(b.f), 16, w - 16), y = clamp(dy(b.g), 16, h - 16);
      handles.push({ key: b.id, filter: false, x, y });
      s += `<g class="h${next.eqOn ? "" : " dim"}">${b.id === selBand ? `<circle class="ring" cx="${x}" cy="${y}" r="20"/>` : ""}` +
        `<circle cx="${x}" cy="${y}" r="14" style="fill:${BAND_COLORS[b.id]}"/>` +
        `<text class="hl" x="${x}" y="${y + 5}">${BANDS.find((x) => x.id === b.id).short}</text></g>`;
    }
    svg.innerHTML = s;
  }

  function svgPoint(e) {
    const r = svg.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * G.w, y: ((e.clientY - r.top) / r.height) * G.h };
  }
  function nearestHandle(p, radius) {
    let best = null, bestD = radius;
    // Bandas por último no desenho = por cima: procura de trás para frente.
    for (let i = handles.length - 1; i >= 0; i--) {
      const hd = handles[i], d = Math.hypot(hd.x - p.x, hd.y - p.y);
      if (d < bestD) { best = hd; bestD = d; }
    }
    return best;
  }
  svg.addEventListener("pointerdown", (e) => {
    const hit = nearestHandle(svgPoint(e), e.pointerType === "touch" ? 36 : 26);
    if (!hit) return;
    e.preventDefault();
    if (!hit.filter) selBand = hit.key;
    drag = canEditEq() ? { key: hit.key, filter: hit.filter, id: e.pointerId } : null;
    if (drag) svg.setPointerCapture(e.pointerId);
    renderEq();
  });
  svg.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const p = svgPoint(e);
    if (drag.filter) setPending("flt", drag.key + "f", xf(p.x));
    else { setPending("eq", drag.key + "f", xf(p.x)); setPending("eq", drag.key + "g", yd(p.y)); }
    renderEq();
    eqWriter.preview();
  });
  const endDrag = (e) => { if (drag && e.pointerId === drag.id) { drag = null; sendEq(); } };
  const sendEq = () => eqWriter.flush();
  svg.addEventListener("pointerup", endDrag);
  svg.addEventListener("pointercancel", endDrag);
  // Roda do mouse sobre uma banda: Q.
  svg.addEventListener("wheel", (e) => {
    const hit = nearestHandle(svgPoint(e), 26);
    if (!hit || hit.filter || !canEditEq()) return;
    e.preventDefault();
    selBand = hit.key;
    const q = eqVal("eq", hit.key + "q");
    if (typeof q === "number") setPending("eq", hit.key + "q", q * (e.deltaY < 0 ? 1.06 : 1 / 1.06));
    renderEq();
    eqWriter.preview();
    // Envia quando a roda para (um comando com o Q final, não um por passo da roda).
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(sendEq, 400);
  }, { passive: false });
  let wheelTimer = null;

  // ---- controles ----
  // Cada controle recebe uma ligação com o parâmetro: { get(), set(v), changed(), enabled(),
  // commit() }. commit redesenha e envia (direto, sem confirmação).
  const eqBind = (sec, param) => ({
    get: () => eqVal(sec, param()), set: (v) => setPending(sec, param(), v), changed: () => isChanged(sec, param()),
    enabled: canEditEq, commit: () => { renderEq(); sendEq(); },
  });
  /** Linha [rótulo] [−] [valor] [+]. o: ligação + { step(v, dir), fmt, parse } */
  function stepper(text, o) {
    const el = document.createElement("div");
    el.className = "stp";
    el.innerHTML = `<span class="stp-l"></span><button type="button" class="big" aria-label="Diminuir">−</button>` +
      `<input class="stp-v" inputmode="decimal" autocomplete="off" spellcheck="false"><button type="button" class="big" aria-label="Aumentar">+</button>`;
    el.querySelector(".stp-l").textContent = text;
    const [minus, plus] = el.querySelectorAll("button");
    const input = el.querySelector("input");
    input.setAttribute("aria-label", text);
    const bump = (dir) => { const v = o.get(); if (typeof v === "number") { o.set(o.step(v, dir)); o.commit(); } };
    minus.addEventListener("click", () => bump(-1));
    plus.addEventListener("click", () => bump(1));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); input.blur(); }
      if (e.key === "Escape") { input.value = o.fmt(o.get()); input.blur(); }
    });
    input.addEventListener("blur", () => {
      const v = o.get();
      if (v == null || input.value === o.fmt(v)) return;
      const n = o.parse(input.value);
      if (Number.isNaN(n)) { toast(`${text}: valor inválido (“${input.value}”)`, true); input.value = o.fmt(v); return; }
      o.set(n);
      o.commit();
    });
    return {
      el,
      update() {
        const v = o.get(), en = o.enabled() && typeof v === "number";
        if (document.activeElement !== input) input.value = typeof v === "number" ? o.fmt(v) : "—";
        input.readOnly = !en;
        minus.disabled = plus.disabled = !en;
        el.classList.toggle("changed", o.changed());
      },
    };
  }
  /** Botões de escolha (tipo de banda, inclinação, modelo, ratio...). o: ligação. */
  function segmented(options, o) {
    const el = document.createElement("div");
    el.className = "seg";
    const btns = options.map(([value, text]) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "big";
      b.textContent = text;
      b.addEventListener("click", () => { o.set(value); o.commit(); });
      el.appendChild(b);
      return [value, b];
    });
    return {
      el,
      update() {
        const v = o.get(), en = o.enabled() && v != null;
        for (const [value, b] of btns) { b.classList.toggle("on", value === v); b.disabled = !en; b.setAttribute("aria-pressed", String(value === v)); }
        el.classList.toggle("changed", o.changed());
      },
    };
  }
  /** Botão liga/desliga de um parâmetro int 0..1. o: ligação. */
  function onOff(btn, o, text) {
    btn.addEventListener("click", () => { const v = o.get(); if (v === 0 || v === 1) { o.set(v ? 0 : 1); o.commit(); } });
    return {
      update() {
        const v = o.get();
        btn.textContent = `${text ? text + " " : ""}${v === 1 ? "ON" : v === 0 ? "OFF" : "—"}`;
        btn.classList.toggle("on", v === 1);
        btn.setAttribute("aria-pressed", String(v === 1));
        btn.disabled = !o.enabled() || v == null;
        btn.style.boxShadow = o.changed() ? "0 0 0 3px var(--accent)" : "";
      },
    };
  }

  const freqStep = (v, dir) => v * Math.pow(2, dir / 6); // 1/6 de oitava
  const controls = [];
  const bandButtons = {};
  function buildEqControls() {
    const bandsEl = document.getElementById("eq-bands");
    for (const b of BANDS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "big band";
      btn.style.setProperty("--bc", BAND_COLORS[b.id]);
      btn.innerHTML = `<span></span><small></small>`;
      btn.firstChild.textContent = b.label;
      btn.addEventListener("click", () => { selBand = b.id; renderEq(); });
      bandsEl.appendChild(btn);
      bandButtons[b.id] = btn;
    }
    const card = document.getElementById("eq-band-card");
    card.innerHTML = `<h3 id="eq-band-title"></h3>`;
    const p = (s) => () => selBand + s;
    const shapeSeg = segmented([["PEQ", "PEQ"], ["SHV", "Shelf"]], eqBind("eq", () => (selBand === "l" ? "leq" : "heq")));
    shapeSeg.el.classList.add("full-only");
    const rows = [
      stepper("Frequência", { ...eqBind("eq", p("f")), step: freqStep, fmt: fmtHz, parse: parseHz }),
      stepper("Ganho dB", { ...eqBind("eq", p("g")), step: (v, d) => v + d * 0.5, fmt: fmtGain, parse: parseNum }),
      stepper("Q", { ...eqBind("eq", p("q")), step: (v, d) => v * Math.pow(2, d / 4), fmt: fmtQ, parse: parseNum }),
    ];
    rows[2].el.classList.add("full-only"); // Rápido: só frequência e ganho
    for (const r of rows) card.appendChild(r.el);
    card.appendChild(shapeSeg.el);
    controls.push(...rows, {
      update() {
        const band = BANDS.find((b) => b.id === selBand);
        card.style.setProperty("--bc", BAND_COLORS[selBand]);
        const title = document.getElementById("eq-band-title");
        title.textContent = `Banda ${band.label}`;
        title.classList.toggle("changed", ["f", "g", "q"].some((s) => isChanged("eq", selBand + s)) || (!!band.shape && isChanged("eq", band.shape)));
        shapeSeg.el.hidden = !band.shape;
        if (band.shape) shapeSeg.update();
      },
    });
    for (const [id, title, on, f, s, slopes] of [
      ["eq-hpf", "Passa-alta (HPF)", "lc", "lcf", "lcs", ["6", "12", "18", "24"]],
      ["eq-lpf", "Passa-baixa (LPF)", "hc", "hcf", "hcs", ["6", "12"]],
    ]) {
      const el = document.getElementById(id);
      el.innerHTML = `<h3><span></span><button type="button" class="big toggle"></button></h3><p class="eq-risk"></p>`;
      el.querySelector("h3 span").textContent = title;
      const riskEl = el.querySelector(".eq-risk");
      const toggle = onOff(el.querySelector("h3 button"), eqBind("flt", () => on), "");
      const freq = stepper("Frequência", { ...eqBind("flt", () => f), step: freqStep, fmt: fmtHz, parse: parseHz });
      const slope = segmented(slopes.map((v) => [v, v + " dB/oit"]), eqBind("flt", () => s));
      slope.el.classList.add("full-only");
      el.append(freq.el, slope.el);
      controls.push(toggle, freq, slope, {
        update() {
          el.querySelector("h3").classList.toggle("changed", [on, f, s].some((x) => isChanged("flt", x)));
          // Aviso de risco sempre visível (não há confirmação antes de enviar).
          const d = eqDesc("flt", on);
          riskEl.textContent = d && d.risk && canEditEq() ? "⚠ " + d.risk : "";
        },
      });
    }
    controls.push(onOff(document.getElementById("eq-on"), eqBind("eq", () => "on"), "EQ"));
    document.getElementById("eq-reload").addEventListener("click", () => {
      if (eqWriter.sending || dynWriter.sending) return toast("Aguarde o envio terminar.", true);
      pending.clear();
      dPending.clear();
      loadCurrentSection(true);
    });
    new ResizeObserver(() => drawEq()).observe(document.getElementById("eq-graph-wrap"));
  }

  // ---- canais ----
  const chips = {};
  function buildChips() {
    const box = document.getElementById("eq-chips");
    if (box.childElementCount || !strips.ch) return;
    for (const st of strips.ch) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "big chip";
      b.innerHTML = `<b></b><span></span>`;
      b.addEventListener("click", () => selectEqChannel(st.index));
      box.appendChild(b);
      chips[st.index] = b;
      updateChip(st);
    }
  }
  function updateChip(st) {
    const b = chips[st.index];
    if (!b) return;
    b.style.setProperty("--chip", chColor(st));
    b.querySelector("b").textContent = `CH ${st.index}`;
    b.querySelector("span").textContent = st.name || "—";
    b.classList.toggle("sel", st.index === eqCh);
    b.setAttribute("aria-pressed", String(st.index === eqCh));
    if (st.index === eqCh && !eqPanel.hidden) renderEqHead();
  }

  /** Troca o canal do detalhe (zera o que estava carregado). false se não dá agora. */
  function switchEqChannel(ch) {
    if (eqWriter.sending || dynWriter.sending || drag || dynDrag) { toast("Aguarde o envio terminar.", true); return false; }
    pending.clear();
    dPending.clear();
    if (!eqPanel.hidden) eqStatus.hide();
    eqData = null;
    dynData = null;
    eqCh = ch;
    save("wing-eq-ch", String(ch));
    if (strips.ch) strips.ch.forEach(updateChip);
    return true;
  }
  function selectEqChannel(ch) {
    if (ch === eqCh && (eqData || dynData)) return;
    if (ch !== eqCh && !switchEqChannel(ch)) return;
    setSel("ch", ch);
    scrollToChip();
    loadCurrentSection(true);
  }
  // Rola só a fileira de canais (scrollIntoView rolaria a página inteira).
  function scrollToChip() {
    const b = chips[eqCh], box = document.getElementById("eq-chips");
    if (b) box.scrollLeft = b.offsetLeft - box.offsetLeft - (box.clientWidth - b.offsetWidth) / 2;
  }
  function showEq() {
    buildChips();
    if (strips.ch) strips.ch.forEach(updateChip);
    scrollToChip();
    // Sem alterações pendentes, relê ao abrir (a mesa pode ter mudado por fora).
    loadCurrentSection(false);
  }

  async function loadEq(ch) {
    const token = ++eqLoadToken;
    eqError = null;
    renderEq();
    try {
      const res = await fetch(`/api/channels/${ch}/eq`);
      const data = await res.json();
      if (token !== eqLoadToken) return;
      if (!res.ok) throw new Error(data.error);
      eqData = data;
    } catch (e) {
      if (token !== eqLoadToken) return;
      eqError = "Não foi possível ler o EQ da mesa: " + e.message;
    }
    renderEq();
  }

  /** Valor vindo da mesa (GET, leitura de volta ou evento da assinatura). */
  function applyEqValue(d, v) {
    if (d.type === "list" || d.type === "string") { if (v.kind === "string") d.value = v.text; }
    else if (v.kind !== "string") d.value = v.value;
  }
  const EQ_PATH = /^\/ch\/(\d+)\/(eq|flt)\/([^/]+)$/;
  function onEqParam(path, value) {
    const m = EQ_PATH.exec(path);
    if (!m || !eqData || Number(m[1]) !== eqData.ch) return;
    if (m[2] === "eq" && m[3] === "mdl" && value.kind === "string") {
      eqData.model = value.text;
      eqData.editable = value.text === "STD";
    } else {
      const d = eqData[m[2]][m[3]];
      if (!d) return;
      applyEqValue(d, value);
      const k = `${m[2]}/${m[3]}`;
      if (pending.has(k) && sameValue(d, pending.get(k), d.value)) pending.delete(k);
    }
    renderEq();
  }

  function renderEqHead() {
    const st = strips.ch && strips.ch[eqCh - 1];
    const color = chColor(st);
    eqPanel.style.setProperty("--cc", color);
    eqPanel.style.setProperty("--cc-ink", inkOn(color));
    document.getElementById("eq-chnum").textContent = `CH ${eqCh}`;
    document.getElementById("eq-chname").textContent = st && st.name ? st.name : "(sem nome)";
    const model = chSection === "eq" ? eqData && eqData.model : dynData && dynData.ch === eqCh && dynData[chSection].model;
    document.getElementById("eq-model").textContent = model ? `${SECTION_LABEL[chSection]} ${model}` : "";
  }

  function renderEq() {
    if (eqPanel.hidden) return;
    if (!controls.length) buildEqControls();
    renderEqHead();
    renderSections();
    if (chSection !== "eq") return renderDyn();
    const msg = document.getElementById("eq-msg");
    let text = "";
    if (eqError) text = eqError;
    else if (!eqData) text = `Lendo o EQ do CH ${eqCh} na mesa…`;
    else if (!eqData.editable) text = `Este canal usa o EQ ${eqData.model || "?"}: o painel só edita o modelo STD (só leitura aqui).`;
    else if (!writable()) text = "Somente leitura: dá para ver a curva, mas mudanças pedem WING_ALLOW_WRITES=1.";
    msg.textContent = text;
    msg.classList.toggle("err", !!eqError);
    for (const b of BANDS) {
      const btn = bandButtons[b.id];
      const f = eqVal("eq", b.id + "f"), g = eqVal("eq", b.id + "g");
      btn.querySelector("small").textContent = typeof f === "number" && typeof g === "number" ? `${fmtHz(f)} · ${fmtGain(g)}` : "—";
      btn.classList.toggle("sel", b.id === selBand);
      btn.setAttribute("aria-pressed", String(b.id === selBand));
      btn.classList.toggle("changed", ["f", "g", "q"].some((s) => isChanged("eq", b.id + s)) || (!!b.shape && isChanged("eq", b.shape)));
    }
    for (const c of controls) c.update();
    drawEq();
  }

  // ---- envio direto ----
  function eqLabel(sec, p) {
    if (sec === "flt") {
      return { lc: "Passa-alta", lcf: "Passa-alta · frequência", lcs: "Passa-alta · inclinação",
        hc: "Passa-baixa", hcf: "Passa-baixa · frequência", hcs: "Passa-baixa · inclinação" }[p];
    }
    if (p === "on") return "EQ";
    if (p === "leq" || p === "heq") return `Banda ${p === "leq" ? "LOW" : "HIGH"} · tipo`;
    return `Banda ${BANDS.find((b) => b.id === p[0]).label} · ${{ f: "frequência", g: "ganho", q: "Q" }[p[1]]}`;
  }

  // Comando como a mesa vai receber (mesmo formato que o servidor devolve em "command").
  const oscText = (path, tag, v) => `${path} ,${tag} ${tag === "s" ? JSON.stringify(v) : v}`;
  const eqTag = (d) => !d ? "f" : d.type === "int" ? "i" : d.type === "list" || d.type === "string" ? "s" : "f";
  const eqKey = (k) => { const [sec, p] = k.split("/"); return { sec, p, d: eqDesc(sec, p) }; };
  const eqWriter = writer({
    pending, status: eqStatus, render: renderEq,
    canSend: canEditEq, held: () => !!drag,
    context: () => `CH ${eqCh}`,
    label: (k) => { const { sec, p } = eqKey(k); return eqLabel(sec, p); },
    command: (k, v) => { const { sec, p, d } = eqKey(k); return oscText(`/ch/${eqCh}/${sec}/${p}`, eqTag(d), v); },
    risk: (k) => { const { d } = eqKey(k); return d && d.risk; },
    extraRisk: (k, v) => {
      const { sec, p } = eqKey(k), cur = eqCur(sec, p);
      return /^[lh1-4]g$/.test(p) && typeof cur === "number" && v > cur + 6 ? `Reforço de mais de 6 dB em ${eqLabel(sec, p)}.` : null;
    },
    post: (k, v) => { const { sec, p } = eqKey(k); return postJson(`/api/channels/${eqCh}/${sec}`, { param: p, value: v }); },
    apply: (k, readBack) => { const { d } = eqKey(k); if (d) applyEqValue(d, readBack); },
  });

  /**
   * Fila de envio de um painel. o: { pending (Map chave -> valor), status, render(), canSend(),
   * held() (arrastando: espera soltar), context(), label(k), command(k, v), risk(k),
   * extraRisk(k, v), post(k, v) -> postJson, apply(k, readBack), done()? (fim do envio) }.
   * Envia um por vez; para no primeiro problema e volta a mostrar o que está na mesa.
   */
  function writer(o) {
    let sending = false, again = false;
    const risksOf = (items) => new Set(items.flatMap(([k, v]) => [o.risk(k), o.extraRisk(k, v)]).filter(Boolean));
    return {
      get sending() { return sending; },
      /** Mostra, antes de enviar, os comandos que vão sair (ex.: durante o arraste). */
      preview() {
        const items = [...o.pending];
        if (!items.length || sending) return;
        o.status.show("sending", "Ao soltar, envia:", items.map(([k, v]) => o.command(k, v)), risksOf(items));
      },
      async flush() {
        if (!o.canSend() || o.held()) return;
        if (sending) { again = true; return; }
        sending = true;
        const cmds = [], risks = new Set();
        let error = null;
        try {
          do {
            again = false;
            for (const [key, value] of [...o.pending]) {
              for (const r of risksOf([[key, value]])) risks.add(r);
              o.status.show("sending", `Enviando ${o.label(key)}:`, [...cmds, o.command(key, value)], risks);
              const r = await o.post(key, value);
              if (r.error) { error = `${o.label(key)}: ${r.error}`; break; }
              cmds.push(r.data.command);
              if (r.data.risk) risks.add(r.data.risk);
              o.apply(key, r.data.readBack);
              if (o.pending.get(key) === value) o.pending.delete(key);
              o.render();
              if (!r.data.ok) { error = `A mesa não confirmou ${r.data.path} (lido: ${r.data.readBack.text}).`; break; }
            }
          } while (again && !error && !o.held());
        } finally {
          sending = false;
        }
        if (error) {
          o.pending.clear();
          o.render();
          o.status.show("err", `${error.replace(/\.?$/, ".")} Nada mais foi enviado.`, cmds, risks);
        } else if (cmds.length) {
          const n = cmds.length === 1 ? "1 comando enviado e confirmado" : `${cmds.length} comandos enviados e confirmados`;
          o.status.show(risks.size ? "risk" : "ok", `${o.context()}: ${n} pela mesa (leitura de volta).`, cmds, risks);
        }
        if (o.done) o.done();
      },
    };
  }

  // ---------- dinâmica do canal (gate e compressor) ----------
  // Os controles são montados pela descrição do nó na mesa (/ch/N/gate, /ch/N/dyn): cada modelo
  // tem parâmetros próprios. Como no EQ, as mudanças vão direto (sem confirmação), validadas
  // na descrição, uma por vez, com o comando exato e os avisos na barra e leitura de volta.
  const SECTIONS = [["gate", "Gate"], ["dyn", "Compressor"]];
  const SECTION_LABEL = { eq: "EQ", gate: "Gate", dyn: "Compressor" };
  const DYN_LABELS = { thr: "Threshold", range: "Alcance", att: "Attack", hld: "Hold", rel: "Release", ratio: "Ratio",
    knee: "Knee", gain: "Makeup", mix: "Mix", det: "Detector", env: "Envelope", auto: "Auto", acc: "Accent" };
  // Modo Rápido: só o essencial de cada seção (o resto aparece no Completo).
  const QUICK_DYN = { gate: ["thr", "range"], dyn: ["thr", "ratio", "gain"] };
  let dynSec = load("wing-ch-section", "gate");
  if (dynSec !== "gate" && dynSec !== "dyn") dynSec = "gate";
  let chSection = "eq";
  // Link direto: #gate/5 e #dyn/5 abrem o gate e o compressor do CH 5 (#eq/5 abre o EQ).
  const dynHash = /^#(gate|dyn)(?:\/(\d+))?$/.exec(location.hash);
  if (dynHash) {
    tab = "dyn";
    detailOpen = true;
    dynSec = dynHash[1];
    if (dynHash[2] && Number(dynHash[2]) >= 1 && Number(dynHash[2]) <= 40) eqCh = Number(dynHash[2]);
  }
  if (eqHash || dynHash) sel = { kind: "ch", index: eqCh };
  let dynData = null, dynError = null, dynToken = 0, dynDrag = null, dynBuilt = "", dynReload = false;
  const dPending = new Map(); // "gate/thr" -> valor
  let dynControls = [];
  let DG = { w: 400, h: 260, lo: -60, hi: 12 };

  const dynParam = (sec, n) => (dynData && dynData[sec] ? dynData[sec].params.find((p) => p.name === n) : undefined);
  const dynCur = (sec, n) => { const d = dynParam(sec, n); return d ? d.value : null; };
  const dynVal = (sec, n) => (dPending.has(`${sec}/${n}`) ? dPending.get(`${sec}/${n}`) : dynCur(sec, n));
  const canEditDyn = () => writable() && !!dynData && dynData.ch === eqCh && !!curveLib;
  const dynLabel = (n) => DYN_LABELS[n] || n;

  function setDynPending(sec, n, v) {
    const d = dynParam(sec, n);
    if (!d || d.readOnly || !canEditDyn() || v == null || (typeof v === "number" && !Number.isFinite(v))) return;
    if (typeof v === "number") v = normalizeNum(d, v);
    const k = `${sec}/${n}`;
    if (sameValue(d, v, d.value)) dPending.delete(k);
    else dPending.set(k, v);
  }
  const dynBind = (n) => ({
    get: () => dynVal(chSection, n), set: (v) => setDynPending(chSection, n, v),
    changed: () => dPending.has(`${chSection}/${n}`),
    enabled: () => canEditDyn() && !!dynParam(chSection, n) && !dynParam(chSection, n).readOnly,
    commit: () => { renderEq(); sendDyn(); },
  });
  /** Passo do −/+: ~80 toques cobrem a faixa (no passo que a mesa descreveu). */
  function stepFor(d) {
    if (d.type === "int") return (v, dir) => v + dir;
    const n = d.steps && d.steps > 1 ? d.steps - 1 : 100;
    const k = Math.max(1, Math.round(n / 80));
    if (d.type === "log" && d.min > 0) { const r = Math.pow(d.max / d.min, k / n); return (v, dir) => v * Math.pow(r, dir); }
    const step = ((d.max - d.min) / n) * k;
    return (v, dir) => v + dir * step;
  }
  function fmtFor(d) {
    const step = d.steps > 1 ? (d.max - d.min) / (d.steps - 1) : 1;
    return (v) => {
      if (typeof v !== "number") return "—";
      if (d.type === "fader" && v <= -144) return "-∞";
      if (d.unit === "Hz" && v >= 1000) return fmtHz(v);
      const dec = d.type === "int" ? 0 : d.type === "log" ? (v < 10 ? 2 : v < 100 ? 1 : 0) : step < 0.1 ? 2 : step < 1 ? 1 : 0;
      return v.toFixed(dec);
    };
  }
  const parseFor = (d) => (d.unit === "Hz" ? parseHz : d.type === "fader" ? parseDb : parseNum);

  const dynWriter = writer({
    pending: dPending, status: eqStatus, render: renderEq,
    canSend: canEditDyn, held: () => !!dynDrag,
    context: () => `CH ${eqCh}`,
    label: (k) => { const [sec, n] = k.split("/"); return `${SECTION_LABEL[sec]} · ${dynLabel(n)}`; },
    command: (k, v) => { const [sec, n] = k.split("/"); return oscText(`/ch/${eqCh}/${sec}/${n}`, eqTag(dynParam(sec, n)), v); },
    risk: (k) => { const [sec, n] = k.split("/"); const d = dynParam(sec, n); return d && d.risk; },
    extraRisk: (k, v) => {
      const [sec, n] = k.split("/"), cur = dynCur(sec, n);
      return sec === "dyn" && n === "gain" && typeof cur === "number" && v > cur + 6 ? "Reforço de mais de 6 dB no ganho de maquiagem." : null;
    },
    post: (k, v) => { const [sec, n] = k.split("/"); return postJson(`/api/channels/${eqCh}/${sec}`, { param: n, value: v }); },
    apply: (k, readBack) => {
      const [sec, n] = k.split("/"), d = dynParam(sec, n);
      if (d) applyEqValue(d, readBack);
      if (n === "mdl") dynReload = true; // outro modelo pode ter outros parâmetros
    },
    done: () => { if (dynReload) { dynReload = false; loadDyn(eqCh); } },
  });
  const sendDyn = () => dynWriter.flush();

  function renderSections() {
    const box = document.getElementById("ch-sections");
    if (!box.childElementCount) {
      for (const [k, t] of SECTIONS) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "big";
        b.dataset.sec = k;
        b.textContent = t;
        b.addEventListener("click", () => selectSection(k));
        box.appendChild(b);
      }
    }
    for (const b of box.children) {
      b.classList.toggle("on", b.dataset.sec === chSection);
      b.setAttribute("aria-pressed", String(b.dataset.sec === chSection));
    }
    // EQ tem aba própria; Gate e Compressor dividem a aba GATE/COMP.
    box.hidden = chSection === "eq";
    document.getElementById("eq-view").hidden = chSection !== "eq";
    document.getElementById("dyn-view").hidden = chSection === "eq";
    document.getElementById("eq-on").hidden = chSection !== "eq";
  }
  function selectSection(k) {
    if (k === chSection) return;
    if (eqWriter.sending || dynWriter.sending || drag || dynDrag) return toast("Aguarde o envio terminar.", true);
    chSection = k;
    dynSec = k;
    save("wing-ch-section", k);
    eqStatus.hide();
    loadCurrentSection(false);
  }
  /** Lê a seção aberta (EQ ou dinâmica); sem pendentes, relê para pegar mudanças feitas por fora. */
  function loadCurrentSection(force) {
    if (chSection === "eq") {
      if (force || !pending.size || !eqData || eqData.ch !== eqCh) loadEq(eqCh);
      else renderEq();
    } else if (force || !dPending.size || !dynData || dynData.ch !== eqCh) loadDyn(eqCh);
    else renderEq();
  }

  async function loadDyn(ch) {
    const token = ++dynToken;
    dynError = null;
    renderEq();
    try {
      const res = await fetch(`/api/channels/${ch}/dyn`);
      const data = await res.json();
      if (token !== dynToken) return;
      if (!res.ok) throw new Error(data.error);
      dynData = data;
    } catch (e) {
      if (token !== dynToken) return;
      dynError = "Não foi possível ler a dinâmica da mesa: " + e.message;
    }
    renderEq();
  }

  /** Monta os controles da seção a partir da descrição (só refaz se os parâmetros mudarem). */
  function buildDynControls() {
    const sec = chSection, data = dynData && dynData.ch === eqCh ? dynData[sec] : null;
    const key = data ? `${dynData.ch}/${sec}/${data.params.map((d) => `${d.name}:${d.type}:${(d.options || []).join(",")}`).join("|")}` : "";
    if (key === dynBuilt) return;
    dynBuilt = key;
    dynControls = [];
    const top = document.getElementById("dyn-top"), box = document.getElementById("dyn-params");
    top.replaceChildren();
    box.replaceChildren();
    if (!data) return;
    if (dynParam(sec, "on")) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "big toggle";
      top.appendChild(b);
      dynControls.push(onOff(b, dynBind("on"), SECTION_LABEL[sec]));
    }
    const mdl = dynParam(sec, "mdl");
    if (mdl && mdl.options && !mdl.readOnly) {
      const m = segmented(mdl.options.map((o) => [o, o]), dynBind("mdl"));
      m.el.setAttribute("aria-label", "Modelo");
      m.el.classList.add("full-only");
      top.appendChild(m.el);
      dynControls.push(m);
    }
    for (const d of data.params) {
      if (d.name === "on" || d.name === "mdl" || d.type === "string") continue;
      const n = d.name;
      const item = document.createElement("div");
      item.className = "dyn-item";
      if (!(QUICK_DYN[sec] || []).includes(n)) item.classList.add("full-only");
      const title = `${dynLabel(n)}${d.unit ? " " + d.unit : ""}`;
      let ctl;
      if (d.readOnly || d.type === "list" || (d.type === "int" && d.min === 0 && d.max === 1)) {
        const h = document.createElement("h4");
        h.innerHTML = "<span></span>";
        h.firstChild.textContent = title;
        item.appendChild(h);
        if (d.readOnly) {
          const span = document.createElement("span");
          span.className = "dyn-ro";
          h.appendChild(span);
          const fmt = fmtFor(d);
          ctl = { update() { const v = dynCur(sec, n); span.textContent = `${typeof v === "number" ? fmt(v) : v ?? "—"} (somente leitura)`; } };
        } else if (d.type === "list") {
          ctl = segmented(d.options.map((o) => [o, o]), dynBind(n));
          item.appendChild(ctl.el);
        } else {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "big toggle";
          h.appendChild(b);
          ctl = onOff(b, dynBind(n), "");
        }
      } else {
        ctl = stepper(title, { ...dynBind(n), step: stepFor(d), fmt: fmtFor(d), parse: parseFor(d) });
        item.appendChild(ctl.el);
      }
      dynControls.push({ update() { ctl.update(); item.classList.toggle("changed", dPending.has(`${sec}/${n}`)); } });
      box.appendChild(item);
    }
  }

  function renderDyn() {
    const msg = document.getElementById("eq-msg");
    const ready = dynData && dynData.ch === eqCh;
    msg.textContent = dynError ? dynError : !ready ? `Lendo ${SECTION_LABEL[chSection].toLowerCase()} do CH ${eqCh} na mesa…`
      : !writable() ? "Somente leitura: dá para ver a dinâmica, mas mudanças pedem WING_ALLOW_WRITES=1." : "";
    msg.classList.toggle("err", !!dynError);
    buildDynControls();
    for (const c of dynControls) c.update();
    drawDyn();
    renderGr();
  }

  /** Saída (dB) para uma entrada x, pela curva do gate ou do compressor. Aproximação para a tela. */
  function transferDb(sec, x, get) {
    const num = (n) => { const v = get(sec, n); return typeof v === "number" ? v : null; };
    const thr = num("thr");
    if (thr == null || num("on") !== 1) return x;
    if (sec === "dyn") {
      const r = Number(get(sec, "ratio")) || 1, knee = (num("knee") ?? 0) * 3, gain = num("gain") ?? 0;
      let y;
      if (get(sec, "mdl") === "EXP") y = x >= thr ? x : thr + (x - thr) * r; // expansor: age abaixo do threshold
      else if (knee > 0 && Math.abs(x - thr) <= knee / 2) y = x + ((1 / r - 1) * Math.pow(x - thr + knee / 2, 2)) / (2 * knee);
      else y = x <= thr ? x : thr + (x - thr) / r;
      return y + gain;
    }
    if (x >= thr) return x;
    const range = num("range") ?? 60;
    const m = /^1:([\d.]+)$/.exec(String(get(sec, "ratio") ?? ""));
    return m ? Math.max(x - range, thr + (x - thr) * Number(m[1])) : x - range;
  }

  function drawDyn() {
    if (eqPanel.hidden || chSection === "eq") return;
    const svgD = document.getElementById("dyn-graph");
    const sec = chSection;
    const w = Math.max(200, Math.round(document.getElementById("dyn-graph-wrap").clientWidth - 2));
    const h = Math.round(clamp(w * 0.55, 200, 360));
    const lo = sec === "gate" ? -80 : -60, hi = sec === "dyn" ? 12 : 0;
    DG = { w, h, lo, hi };
    const X = (db) => ((db - lo) / -lo) * w, Y = (db) => h - ((db - lo) / (hi - lo)) * h;
    svgD.setAttribute("viewBox", `0 0 ${w} ${h}`);
    svgD.setAttribute("width", w);
    svgD.setAttribute("height", h);
    let s = "";
    for (let db = lo; db <= 0; db += 10) {
      const x = X(db);
      s += `<line class="g${db % 20 === 0 ? " g-major" : ""}" x1="${x}" x2="${x}" y1="0" y2="${h}"/>`;
      if (db > lo && db < 0) s += `<text class="gl" x="${x + 3}" y="${h - 6}">${db}</text>`;
    }
    for (let db = lo + 10; db <= hi; db += 10) {
      const y = Y(db);
      s += `<line class="g${db === 0 ? " g-major" : ""}" x1="0" x2="${w}" y1="${y}" y2="${y}"/><text class="gl" x="4" y="${y - 4}">${db}</text>`;
    }
    s += `<text class="gl" x="${w - 92}" y="${h - 20}">entrada (dB)</text><text class="gl" x="34" y="14">saída (dB)</text>`;
    s += `<line class="unity" x1="${X(lo)}" y1="${Y(lo)}" x2="${X(0)}" y2="${Y(0)}"/>`;
    if (dynData && dynData.ch === eqCh) {
      const path = (get) => {
        let d = "";
        for (let i = 0; i <= 160; i++) {
          const x = lo + (-lo * i) / 160;
          d += `${i ? "L" : "M"}${X(x).toFixed(1)},${clamp(Y(transferDb(sec, x, get)), -4, h + 4).toFixed(1)}`;
        }
        return d;
      };
      if ([...dPending.keys()].some((k) => k.startsWith(sec + "/"))) s += `<path class="c-old" d="${path(dynCur)}"/>`;
      s += `<path class="c-main" d="${path(dynVal)}"/>`;
      const thr = dynVal(sec, "thr");
      if (typeof thr === "number") {
        const x = X(thr), y = clamp(Y(transferDb(sec, thr, dynVal)), 14, h - 14);
        s += `<line class="thr" x1="${x}" x2="${x}" y1="0" y2="${h}"/><circle class="thr-h" cx="${x}" cy="${y}" r="12"/>` +
          `<text class="thr-t" x="${clamp(x + 10, 4, w - 110)}" y="30">thr ${thr.toFixed(1)} dB</text>`;
      }
    }
    svgD.innerHTML = s;
    svgD.classList.toggle("dim", dynVal(sec, "on") === 0);
  }

  // Arrastar na curva (para os lados) muda o threshold; é relativo: tocar sem mover não muda nada.
  const dynSvg = document.getElementById("dyn-graph");
  dynSvg.addEventListener("pointerdown", (e) => {
    const thr = dynVal(chSection, "thr"), d = dynParam(chSection, "thr");
    if (!canEditDyn() || typeof thr !== "number" || !d || d.readOnly) return;
    e.preventDefault();
    try { dynSvg.setPointerCapture(e.pointerId); } catch {}
    dynDrag = { id: e.pointerId, x0: e.clientX, t0: thr, w: dynSvg.getBoundingClientRect().width };
  });
  dynSvg.addEventListener("pointermove", (e) => {
    if (!dynDrag || e.pointerId !== dynDrag.id) return;
    setDynPending(chSection, "thr", dynDrag.t0 + ((e.clientX - dynDrag.x0) / dynDrag.w) * -DG.lo);
    renderEq();
    dynWriter.preview();
  });
  const endDynDrag = (e) => { if (dynDrag && e.pointerId === dynDrag.id) { dynDrag = null; sendDyn(); } };
  dynSvg.addEventListener("pointerup", endDynDrag);
  dynSvg.addEventListener("pointercancel", endDynDrag);
  new ResizeObserver(() => drawDyn()).observe(document.getElementById("dyn-graph-wrap"));

  /**
   * Medidor de redução de ganho: palavras 5 (gate) e 7 (compressor) do medidor do canal
   * (Table 5), em dB com 0 = sem redução. Mapa ainda não conferido na mesa real.
   */
  function renderGr() {
    if (eqPanel.hidden || chSection === "eq") return;
    const st = strips.ch && strips.ch[eqCh - 1];
    const g = st && st.meter ? st.meter[chSection] : undefined;
    const red = typeof g === "number" ? Math.max(0, -g) : null;
    const range = dynVal("gate", "range");
    const full = chSection === "gate" ? (typeof range === "number" ? range : 60) : 24;
    document.getElementById("dyn-gr-fill").style.height = red == null ? "0%" : `${Math.min(100, (red / full) * 100)}%`;
    document.getElementById("dyn-gr-val").textContent = red == null ? "—" : red < 0.05 ? "0.0 dB" : `−${red.toFixed(1)} dB`;
    document.getElementById("dyn-gr-l").textContent = chSection === "gate" ? "Gate: redução" : "Redução";
  }

  const DYN_PATH = /^\/ch\/(\d+)\/(gate|dyn)\/([^/]+)$/;
  function onDynParam(path, value) {
    const m = DYN_PATH.exec(path);
    if (!m || !dynData || Number(m[1]) !== dynData.ch) return;
    const d = dynParam(m[2], m[3]);
    if (!d) return;
    // Outro modelo pode ter outros parâmetros: relê o nó.
    if (m[3] === "mdl" && value.kind === "string" && value.text !== d.value) {
      if (!dynWriter.sending) loadDyn(dynData.ch);
      return;
    }
    applyEqValue(d, value);
    const k = `${m[2]}/${m[3]}`;
    if (dPending.has(k) && sameValue(d, dPending.get(k), d.value)) dPending.delete(k);
    if (chSection === m[2]) renderEq();
  }

  // ---------- sends ----------
  // Escolhe um destino (bus ou matriz) e a parte de cima de cada strip vira o envio daquela
  // fonte para ele: on/off, nível e pré/pós. Como no EQ, as mudanças vão direto, sem etapa de
  // confirmação.
  const SRC_GROUPS = { bus: ["ch", "aux"], mtx: ["ch", "aux", "bus", "main"] };
  const PARAM_LABEL = { on: "on/off", lvl: "nível", mode: "pré/pós", pre: "pré/pós" };
  const DEST_RE = /^(bus\/([1-9]|1[0-6])|mtx\/[1-8])$/;
  let sndDest = load("wing-snd-dest", "bus/1");
  // Link direto: http://localhost:3000/#sends/bus/3
  const sndHash = /^#sends(?:\/(\w+\/\d+))?$/.exec(location.hash);
  if (sndHash) { tab = "sends"; if (sndHash[1]) sndDest = sndHash[1]; }
  if (!DEST_RE.test(sndDest)) sndDest = "bus/1";
  let sndRows = null, sndError = null, sndToken = 0, sndRisk = "", sndOnlyOn = load("wing-snd-only-on", "0") === "1";
  const sPending = new Map(); // "ch/5/lvl" -> valor
  const sStrips = new Map(); // "ch/5" -> { row, el, update() }
  const destChips = {};
  let fdrDrag = null;

  const destOf = (d = sndDest) => { const [kind, n] = d.split("/"); return { kind, index: Number(n) }; };
  const destKeyOf = (d = sndDest) => { const x = destOf(d); return x.kind === "bus" ? String(x.index) : `MX${x.index}`; };
  function destLabel(d = sndDest) {
    const x = destOf(d), st = strips[x.kind] && strips[x.kind][x.index - 1];
    return `${x.kind === "bus" ? "BUS" : "MTX"} ${x.index}${st && st.name ? " · " + st.name : ""}`;
  }
  const modeParamOf = (kind) => (kind === "ch" || kind === "aux" ? "mode" : "pre");
  const canEditSends = () => writable() && !!sndRows;
  const fmtLvl = (v) => (v <= -144 ? "-∞" : (v > 0 ? "+" : "") + v.toFixed(1));

  /** Valor na mesa (sem o pendente) de um parâmetro de envio da linha. */
  function rowCurrent(row, param) {
    if (param === "on") return row.on == null ? null : row.on ? 1 : 0;
    if (param === "lvl") return row.lvl;
    if (param === "mode") return row.mode;
    return row.mode == null ? null : row.mode === "PRE" ? 1 : 0; // pre
  }
  const rowKey = (row, param) => `${row.kind}/${row.index}/${param}`;
  const rowValue = (row, param) => sPending.has(rowKey(row, param)) ? sPending.get(rowKey(row, param)) : rowCurrent(row, param);
  /** Modo mostrado (PRE/POST/GRP), com o pendente. */
  function rowMode(row) {
    const mp = modeParamOf(row.kind), v = rowValue(row, mp);
    return mp === "mode" ? v : v == null ? null : v === 1 ? "PRE" : "POST";
  }
  /** Valor vindo da mesa (leitura de volta ou evento da assinatura). */
  function applySendRow(row, param, v) {
    if (param === "on" && v.kind !== "string") row.on = v.value === 1;
    if (param === "lvl" && v.kind !== "string") row.lvl = v.value;
    if (param === "mode" && v.kind === "string") row.mode = v.text;
    if (param === "pre" && v.kind !== "string") row.mode = v.value === 1 ? "PRE" : "POST";
  }
  function setSendPending(row, param, v) {
    if (!canEditSends() || v == null || (typeof v === "number" && !Number.isFinite(v))) return;
    if (param === "lvl") v = Math.round(clamp(v, -144, 10) * 10) / 10;
    const k = rowKey(row, param), cur = rowCurrent(row, param);
    if (v === cur) sPending.delete(k);
    else sPending.set(k, v);
  }

  const sKey = (k) => { const [kind, n, param] = k.split("/"); return { kind, index: Number(n), param, s: sStrips.get(`${kind}/${n}`) }; };
  const sndWriter = writer({
    pending: sPending, status: sndStatus,
    render: () => sStrips.forEach((x) => x.update()),
    canSend: canEditSends, held: () => !!fdrDrag,
    context: () => destLabel(),
    label: (k) => { const x = sKey(k); return `${PREFIX[x.kind]} ${x.index} → ${destLabel()} · ${PARAM_LABEL[x.param]}`; },
    command: (k, v) => {
      const x = sKey(k);
      return oscText(`/${x.kind}/${x.index}/send/${destKeyOf()}/${x.param}`, x.param === "lvl" ? "f" : x.param === "mode" ? "s" : "i", v);
    },
    risk: () => sndRisk,
    extraRisk: (k, v) => {
      const x = sKey(k), cur = x.s && x.s.row.lvl;
      return x.param === "lvl" && typeof cur === "number" && v > Math.max(cur, -60) + 6
        ? `Aumento de mais de 6 dB no envio de ${PREFIX[x.kind]} ${x.index}.` : null;
    },
    post: (k, v) => { const x = sKey(k); return postJson("/api/sends", { src: `${x.kind}/${x.index}`, dest: sndDest, param: x.param, value: v }); },
    apply: (k, readBack) => { const x = sKey(k); if (x.s) applySendRow(x.s.row, x.param, readBack); },
  });

  let sndKeyTimer = null;
  /** Envia depois de uma pausa (teclado: um comando com o valor final). */
  function sendSoon() { clearTimeout(sndKeyTimer); sndKeyTimer = setTimeout(() => sndWriter.flush(), 450); }

  /** Controle de envio (fonte -> destino escolhido) na parte de cima do strip da fonte. */
  function sendCtl(row) {
    const el = document.createElement("div");
    el.className = "sc";
    const mp = modeParamOf(row.kind);
    const modes = mp === "mode" ? ["PRE", "POST", "GRP"] : ["PRE", "POST"];
    const name = () => `${PREFIX[row.kind]} ${row.index}`;
    el.innerHTML = `<button type="button" class="tbtn sc-on"></button>
      <div class="knob"><input class="k-v sc-v" inputmode="decimal" autocomplete="off" spellcheck="false"><span class="k-bar"><i></i></span></div>
      <button type="button" class="tbtn sc-mode full-only"></button>`;
    const q = (c) => el.querySelector(c);
    const onBtn = q(".sc-on"), input = q(".sc-v"), bar = q(".k-bar"), modeBtn = q(".sc-mode");
    input.setAttribute("aria-label", `Nível do envio de ${name()} em dB (arraste para cima/baixo)`);
    modeBtn.title = "Ponto do envio (pré/pós-fader)";
    onBtn.addEventListener("click", () => {
      const v = rowValue(row, "on");
      if (v === 0 || v === 1) { setSendPending(row, "on", v ? 0 : 1); update(); sndWriter.flush(); }
    });
    modeBtn.addEventListener("click", () => {
      const cur = rowMode(row);
      if (!canEditSends() || cur == null) return;
      const box = document.createElement("div");
      box.className = "pick";
      for (const m of modes) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "big" + (m === cur ? " toggle on" : "");
        b.textContent = m;
        b.addEventListener("click", () => {
          closeDialog();
          setSendPending(row, mp, mp === "mode" ? m : m === "PRE" ? 1 : 0);
          update();
          sndWriter.flush();
        });
        box.appendChild(b);
      }
      openPicker(`Envio de ${name()} → ${destLabel()}`, box);
    });
    // Arrastar o valor é relativo (tocar sem mover abre para digitar); Shift = ajuste fino.
    dragEdit(input, {
      axis: "y", min: 0, max: 1, enabled: () => canEditSends() && typeof rowValue(row, "lvl") === "number" && document.activeElement !== input,
      get: () => dbToPos(rowValue(row, "lvl")), perPx: () => 1 / 180,
      start: () => { fdrDrag = { row }; },
      apply: (p) => { setSendPending(row, "lvl", posToDb(p)); update(); sndWriter.preview(); },
      end: () => { fdrDrag = null; },
      commit: () => sndWriter.flush(), tap: focusInput(input),
    });
    const nudge = (step) => {
      const v = rowValue(row, "lvl");
      if (!canEditSends() || typeof v !== "number") return;
      let next = v <= -144 ? (step > 0 ? -60 : -144) : v + step;
      if (next < -90) next = -144;
      setSendPending(row, "lvl", next);
      update();
      sndWriter.preview();
      sendSoon();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); input.blur(); }
      if (e.key === "Escape") { input.value = fmtLvl(rowValue(row, "lvl")); input.blur(); }
      const step = { ArrowUp: 1, ArrowDown: -1, PageUp: 6, PageDown: -6 }[e.key];
      if (step && input.readOnly) { e.preventDefault(); nudge(e.shiftKey ? step / 10 : step); }
    });
    input.addEventListener("blur", () => {
      const v = rowValue(row, "lvl");
      if (typeof v !== "number" || input.value === fmtLvl(v)) return;
      const db = parseDb(input.value);
      if (Number.isNaN(db) || db < -144 || db > 10) {
        toast(`${name()}: digite um nível de -∞ (-inf) a +10 dB`, true);
        input.value = fmtLvl(v);
        return;
      }
      setSendPending(row, "lvl", db);
      update();
      sndWriter.flush();
    });

    function update() {
      const lvl = rowValue(row, "lvl"), on = rowValue(row, "on"), mode = rowMode(row), en = canEditSends();
      bar.style.setProperty("--w", `${dbToPos(typeof lvl === "number" ? lvl : -144) * 100}%`);
      if (document.activeElement !== input) input.value = typeof lvl === "number" ? fmtLvl(lvl) : "—";
      input.readOnly = !en || typeof lvl !== "number";
      onBtn.textContent = on === 1 ? "ON" : on === 0 ? "OFF" : "—";
      onBtn.classList.toggle("on", on === 1);
      onBtn.setAttribute("aria-pressed", String(on === 1));
      onBtn.setAttribute("aria-label", `Envio de ${name()} ${on === 1 ? "ligado" : "desligado"}`);
      onBtn.disabled = !en || on == null;
      modeBtn.textContent = mode ?? "—";
      modeBtn.disabled = !en || mode == null;
      el.classList.toggle("off", on !== 1);
      const changed = ["on", "lvl", mp].some((x) => sPending.has(rowKey(row, x)));
      el.classList.toggle("changed", changed);
      // "Só ligados": esconde o strip da fonte cujo envio está desligado (só na aba SENDS).
      const c = cards[`${row.kind}/${row.index}`];
      if (c) c.el.hidden = tab === "sends" && sndOnlyOn && on !== 1 && !changed && !(fdrDrag && fdrDrag.row === row);
    }
    return { row, el, update };
  }

  /** Põe o controle de envio (ou um aviso) na parte de cima do strip. */
  function mountSend(c) {
    const s = sStrips.get(`${c.st.kind}/${c.st.index}`);
    if (s) { if (s.el.parentElement !== c.sndSlot) c.sndSlot.replaceChildren(s.el); return; }
    const note = document.createElement("span");
    note.className = "t-none";
    note.textContent = sndError ? "—" : !sndRows ? "lendo…" : "sem envio";
    c.sndSlot.replaceChildren(note);
  }

  function buildDestChips() {
    for (const [kind, count] of [["bus", 16], ["mtx", 8]]) {
      const box = document.getElementById(`snd-${kind}`);
      if (box.childElementCount) continue;
      for (let i = 1; i <= count; i++) {
        const d = `${kind}/${i}`;
        const b = document.createElement("button");
        b.type = "button";
        b.className = "big chip";
        b.innerHTML = `<b></b><span></span>`;
        b.addEventListener("click", () => selectSendDest(d));
        box.appendChild(b);
        destChips[d] = b;
      }
    }
    Object.keys(destChips).forEach(updateDestChip);
  }
  function updateDestChip(d) {
    const b = destChips[d];
    if (!b) return;
    const x = destOf(d), st = strips[x.kind] && strips[x.kind][x.index - 1];
    b.style.setProperty("--chip", chColor(st));
    b.querySelector("b").textContent = `${x.kind === "bus" ? "BUS" : "MTX"} ${x.index}`;
    b.querySelector("span").textContent = st && st.name ? st.name : "—";
    b.classList.toggle("sel", d === sndDest);
    b.setAttribute("aria-pressed", String(d === sndDest));
  }
  function scrollToDest() {
    const b = destChips[sndDest];
    if (!b) return;
    const box = document.getElementById("snd-dests");
    box.scrollLeft = b.offsetLeft - box.offsetLeft - (box.clientWidth - b.offsetWidth) / 2;
  }

  /** Mudou nome/cor de um strip: atualiza o envio e a escolha de destino. */
  function onStripForSends(st) {
    if (st.kind === "bus" || st.kind === "mtx") updateDestChip(`${st.kind}/${st.index}`);
    if (tab !== "sends") return;
    const s = sStrips.get(`${st.kind}/${st.index}`);
    if (s) s.update();
    if (`${st.kind}/${st.index}` === sndDest) renderSendsHead();
  }

  const SEND_EVENT = /^\/(ch|aux|bus|main)\/(\d+)\/send\/(\d+|MX\d+)\/(on|lvl|mode|pre)$/;
  function onSendParam(path, value) {
    const m = SEND_EVENT.exec(path);
    if (!m || !sndRows || m[3] !== destKeyOf()) return;
    const s = sStrips.get(`${m[1]}/${m[2]}`);
    if (!s) return;
    applySendRow(s.row, m[4], value);
    const k = rowKey(s.row, m[4]);
    if (sPending.has(k) && sPending.get(k) === rowCurrent(s.row, m[4])) sPending.delete(k);
    if (tab === "sends") s.update();
  }

  function selectSendDest(d) {
    if (d === sndDest && sndRows) return;
    if (sndWriter.sending || fdrDrag) return toast("Aguarde o envio terminar.", true);
    sPending.clear();
    sndStatus.hide();
    sndDest = d;
    save("wing-snd-dest", d);
    Object.keys(destChips).forEach(updateDestChip);
    scrollToDest();
    loadSends();
  }
  function showSends() {
    buildDestChips();
    scrollToDest();
    if (!sPending.size || !sndRows) loadSends();
    else renderSends();
  }

  async function loadSends() {
    const token = ++sndToken, dest = sndDest;
    sndError = null;
    sndRows = null;
    buildSendStrips();
    renderSends();
    try {
      const [res, risk] = await Promise.all([fetch(`/api/sends?dest=${dest}`), riskFor(`/ch/1/send/${destKeyOf(dest)}/lvl`)]);
      const data = await res.json();
      if (token !== sndToken) return;
      if (!res.ok) throw new Error(data.error);
      sndRows = data.rows;
      sndRisk = risk;
    } catch (e) {
      if (token !== sndToken) return;
      sndError = "Não foi possível ler os envios da mesa: " + e.message;
    }
    buildSendStrips();
    renderSends();
  }

  function buildSendStrips() {
    sStrips.clear();
    for (const row of sndRows || []) {
      if (SRC_GROUPS[destOf().kind].includes(row.kind)) sStrips.set(`${row.kind}/${row.index}`, sendCtl(row));
    }
    for (const c of Object.values(cards)) { mountSend(c); c.el.hidden = false; }
  }

  function renderSendsHead() {
    document.getElementById("snd-title").textContent = `Envios para ${destLabel()}`;
  }

  function renderSends() {
    if (tab !== "sends") return;
    buildDestChips();
    renderSendsHead();
    const msg = document.getElementById("snd-msg");
    msg.textContent = sndError ? sndError : !sndRows ? `Lendo os envios para ${destLabel()} na mesa…`
      : !writable() ? "Somente leitura: dá para ver os envios, mas mudanças pedem WING_ALLOW_WRITES=1." : "";
    msg.classList.toggle("err", !!sndError);
    // Aviso de risco sempre visível: não há confirmação antes de enviar.
    document.getElementById("snd-risk").textContent = sndRows && sndRisk && writable() ? "⚠ " + sndRisk : "";
    const filter = document.getElementById("snd-filter");
    filter.textContent = sndOnlyOn ? "Só ligados" : "Todos";
    filter.title = sndOnlyOn ? "Mostrando só envios ligados (toque para mostrar todos)" : "Mostrando todos (toque para só ligados)";
    filter.classList.toggle("on", sndOnlyOn);
    filter.setAttribute("aria-pressed", String(sndOnlyOn));
    sStrips.forEach((s) => s.update());
  }

  document.getElementById("snd-filter").addEventListener("click", () => {
    sndOnlyOn = !sndOnlyOn;
    save("wing-snd-only-on", sndOnlyOn ? "1" : "0");
    renderSends();
  });
  document.getElementById("snd-reload").addEventListener("click", () => {
    if (sndWriter.sending || fdrDrag) return toast("Aguarde o envio terminar.", true);
    sPending.clear();
    sndStatus.hide();
    loadSends();
  });

  // ---------- status ----------
  function renderStatus(s) {
    document.getElementById("host").textContent = "Mesa " + s.host;
    const wasWritable = document.body.classList.contains("writable");
    document.body.classList.toggle("writable", !!s.writesEnabled);
    if (wasWritable !== !!s.writesEnabled) {
      for (const c of Object.values(cards)) if (c.el.isConnected) renderCard(c);
      renderEq();
      renderSends();
      renderOvPins();
    }
    const mode = document.getElementById("mode");
    mode.textContent = s.writesEnabled ? "Escrita liberada" : "Somente leitura";
    mode.className = "pill " + (s.writesEnabled ? "rw" : "ro");
    const t = Date.now();
    const osc = document.getElementById("osc");
    const oscOk = s.lastOscAt && t - s.lastOscAt < 15000;
    osc.textContent = "OSC";
    osc.title = "OSC: " + (oscOk ? "conectado" : "sem resposta");
    osc.className = "pill " + (oscOk ? "ok" : "err");
    const mtr = document.getElementById("mtr");
    const mOk = s.lastMeterAt && t - s.lastMeterAt < 5000;
    mtr.textContent = "Medidores";
    mtr.title = "Medidores: " + (mOk ? "recebendo" : "sem dados");
    mtr.className = "pill " + (mOk ? "ok" : "err");
    const inf = (s.consoleInfo || "") + (s.error ? " · " + s.error : "");
    const infoEl = document.getElementById("info");
    infoEl.textContent = inf;
    infoEl.title = inf;
    infoEl.classList.toggle("has-err", !!s.error);
    document.getElementById("host").title = inf;
  }

  // ---------- SESSÕES: gravação das mixagens (o servidor só lê a mesa e grava em disco) ----------
  const recPill = document.getElementById("rec-pill");
  const recOp = document.getElementById("rec-op");
  const recMsg = document.getElementById("rec-msg");
  let recActive = null, recMoments = [], recBusy = false, recViewId = null, recText = "";
  let recPick = load("wing-rec-moment") || "pre";
  recOp.value = load("wing-rec-op") || "";
  const momentLabel = (id) => (recMoments.find((m) => m.id === id) || { label: id }).label;
  function recNote(text, isError) {
    recMsg.textContent = text;
    recMsg.className = "eq-msg" + (text ? (isError ? " err" : " ok") : "");
  }
  function renderRec() {
    recPill.hidden = !recActive;
    if (recActive) recPill.textContent = ` REC · ${momentLabel(recActive.moment)} · ${fmtDur(Date.now() - recActive.startedAt)}`;
    if (recPanel.hidden) return;
    const on = !!recActive;
    document.getElementById("rec-card").classList.toggle("on", on);
    const state = document.getElementById("rec-state");
    state.classList.toggle("on", on);
    state.textContent = on ? `Gravando · ${fmtDur(Date.now() - recActive.startedAt)}` : "Parada";
    if (on) recOp.value = recActive.operator;
    recOp.disabled = on || recBusy;
    document.getElementById("rec-start").hidden = on;
    document.getElementById("rec-stop").hidden = !on;
    document.getElementById("rec-start").disabled = recBusy;
    document.getElementById("rec-stop").disabled = recBusy;
    const cur = on ? recActive.moment : recPick;
    const box = document.getElementById("rec-moments");
    if (box.childElementCount !== recMoments.length) {
      box.replaceChildren(...recMoments.map((m) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "big";
        b.dataset.moment = m.id;
        b.textContent = m.label;
        b.addEventListener("click", () => pickMoment(m.id));
        return b;
      }));
    }
    box.querySelectorAll("button").forEach((b) => {
      b.classList.toggle("on", b.dataset.moment === cur);
      b.setAttribute("aria-pressed", String(b.dataset.moment === cur));
      b.disabled = recBusy;
    });
  }
  function renderSessions(list, dir) {
    document.getElementById("rec-dir").textContent = dir ? `Arquivos em ${dir}` : "";
    const box = document.getElementById("rec-sessions");
    if (!list.length) {
      const p = document.createElement("div");
      p.className = "rec-empty";
      p.textContent = "Nenhuma sessão gravada ainda.";
      return box.replaceChildren(p);
    }
    box.replaceChildren(...list.map((s) => {
      const row = document.createElement("div");
      row.className = "rec-row";
      const info = document.createElement("div");
      const title = document.createElement("b");
      const d = s.date ? new Date(s.date) : null;
      title.textContent = d ? d.toLocaleString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : s.id;
      const tag = document.createElement("span");
      tag.className = "tag" + (s.active ? "" : " warn");
      tag.textContent = s.active ? "GRAVANDO" : s.ended ? "" : "INTERROMPIDA";
      title.appendChild(tag);
      const sub = document.createElement("div");
      sub.className = "sub";
      const size = s.bytes < 1048576 ? `${Math.max(1, Math.round(s.bytes / 1024))} KB` : `${(s.bytes / 1048576).toFixed(1)} MB`;
      sub.textContent = `${s.operator || "—"} · duração ${fmtDur(s.durationMs)} · ${size}`;
      info.append(title, sub);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "big ghost";
      btn.textContent = "Ver";
      btn.addEventListener("click", () => openSession(s.id));
      row.append(info, btn);
      return row;
    }));
  }
  async function loadSessions() {
    try {
      const data = await (await fetch("/api/sessions")).json();
      recMoments = data.moments;
      recActive = data.active;
      if (!recMoments.some((m) => m.id === recPick)) recPick = recMoments[0].id;
      renderRec();
      renderSessions(data.sessions, data.dir);
    } catch (e) {
      recNote("Falha ao ler as sessões: " + e.message, true);
    }
  }
  async function recPost(action, body) {
    recBusy = true;
    renderRec();
    const { data, error } = await postJson(`/api/sessions/${action}`, body);
    recBusy = false;
    if (error) recNote(error, true);
    await loadSessions();
    return !error && data;
  }
  async function pickMoment(id) {
    if (recBusy) return;
    if (!recActive) {
      recPick = id;
      save("wing-rec-moment", id);
      return renderRec();
    }
    if (id === recActive.moment) return;
    if (await recPost("moment", { moment: id })) recNote(`Momento marcado: ${momentLabel(id)}.`);
  }
  document.getElementById("rec-start").addEventListener("click", async () => {
    const operator = recOp.value.trim();
    if (!operator) { recNote("Escreva o nome de quem está na mesa.", true); return recOp.focus(); }
    save("wing-rec-op", operator);
    if (await recPost("start", { operator, moment: recPick })) recNote(`Gravando. Operador: ${operator}.`);
  });
  document.getElementById("rec-stop").addEventListener("click", async () => {
    if (await recPost("stop", {})) recNote("Gravação encerrada e guardada.");
  });
  document.getElementById("rec-reload").addEventListener("click", loadSessions);
  recPill.addEventListener("click", () => { closeSession(); showTab("rec"); });

  function renderLog() {
    const raw = document.getElementById("rec-raw").checked;
    const meters = document.getElementById("rec-meters").checked;
    document.getElementById("rec-meters").disabled = raw;
    const moments = Object.fromEntries(recMoments.map((m) => [m.id, m.label]));
    document.getElementById("rec-log").textContent = raw ? recText : sessionLog(recText, { moments, meters }).join("\n");
  }
  async function openSession(id) {
    recViewId = id;
    document.getElementById("rec-main").hidden = true;
    document.getElementById("rec-view").hidden = false;
    document.getElementById("rec-vtitle").textContent = id;
    document.getElementById("rec-log").textContent = "Lendo…";
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error((await res.json()).error);
      const text = await res.text();
      if (recViewId !== id) return;
      recText = text;
      renderLog();
    } catch (e) {
      document.getElementById("rec-log").textContent = "Falha ao ler a sessão: " + e.message;
    }
  }
  function closeSession() {
    recViewId = null;
    recText = "";
    document.getElementById("rec-view").hidden = true;
    document.getElementById("rec-main").hidden = false;
  }
  document.getElementById("rec-back").addEventListener("click", () => { closeSession(); loadSessions(); });
  document.getElementById("rec-raw").addEventListener("change", renderLog);
  document.getElementById("rec-meters").addEventListener("change", renderLog);
  setInterval(() => { if (recActive) renderRec(); }, 1000);

  // ---------- alertas ao vivo (o servidor só lê a mesa e avisa; nada é escrito) ----------
  const alertsEl = document.getElementById("alerts");
  const alertPill = document.getElementById("alert-pill");
  let alertState = { active: [], history: [] };
  const AL_HIST_TITLE = "Alertas da sessão";
  const seenAlerts = new Set();
  const AL_LEVEL = { critical: "CRÍTICO", warning: "AVISO" };
  const AL_ACTION = { raised: "Disparou", cleared: "Resolvido", dismissed: "Dispensado" };
  function markAlertStrips() {
    const byCh = {};
    for (const a of alertState.active) if (a.channel && byCh[a.channel] !== "critical") byCh[a.channel] = a.level;
    for (const [key, c] of Object.entries(cards)) {
      if (!key.startsWith("ch/")) continue;
      const lv = byCh[key.slice(3)];
      c.el.classList.toggle("al-crit", lv === "critical");
      c.el.classList.toggle("al-warn", lv === "warning");
    }
  }
  function renderAlerts() {
    const list = alertState.active;
    alertsEl.replaceChildren(...list.map((a) => {
      const el = document.createElement("div");
      el.className = `al ${a.level}${seenAlerts.has(a.id) ? "" : " fresh"}`;
      el.dataset.key = a.key;
      el.setAttribute("role", a.level === "critical" ? "alert" : "status");
      seenAlerts.add(a.id);
      const lv = document.createElement("span");
      lv.className = "al-lv";
      lv.textContent = AL_LEVEL[a.level];
      const txt = document.createElement("div");
      const title = document.createElement("div");
      title.className = "al-t";
      title.textContent = a.title;
      const detail = document.createElement("div");
      detail.className = "al-d";
      detail.textContent = a.detail;
      txt.append(title, detail);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "big ghost al-x";
      btn.textContent = "Dispensar";
      btn.title = "Some da tela; volta se o problema sumir e aparecer de novo";
      btn.addEventListener("click", () => dismissAlert(a.id));
      const steps = document.createElement("details");
      steps.open = a.level === "critical";
      const sum = document.createElement("summary");
      sum.textContent = "O que fazer";
      const ol = document.createElement("ol");
      for (const s of a.steps) { const li = document.createElement("li"); li.textContent = s; ol.appendChild(li); }
      steps.append(sum, ol);
      el.append(lv, txt, btn, steps);
      return el;
    }));
    const crit = list.filter((a) => a.level === "critical").length;
    alertPill.className = "pill alpill" + (crit ? " crit" : list.length ? " warn" : "");
    alertPill.textContent = list.length ? `⚠ ${list.length} ${list.length > 1 ? "alertas" : "alerta"}` : "Sem alertas";
    markAlertStrips();
    if (dlg.root.classList.contains("open") && dlg.title.textContent === AL_HIST_TITLE) showAlertHistory();
  }
  async function dismissAlert(id) {
    const { error } = await postJson("/api/alerts/dismiss", { id });
    if (error) toast(error, true);
  }
  function showAlertHistory() {
    const box = document.createElement("div");
    box.className = "al-hist";
    const note = document.createElement("p");
    note.textContent = `${alertState.active.length} ativo(s) agora. Histórico desde o início da gravação (ou desde que o servidor subiu). ` +
      "Os alertas só avisam: nada é mudado na mesa.";
    box.appendChild(note);
    const hist = [...alertState.history].reverse();
    if (!hist.length) {
      const p = document.createElement("p");
      p.textContent = "Nenhum alerta até agora.";
      box.appendChild(p);
    }
    for (const h of hist) {
      const row = document.createElement("div");
      const time = document.createElement("time");
      time.textContent = new Date(h.t).toLocaleTimeString("pt-BR");
      const act = document.createElement("span");
      act.className = "a-" + h.action;
      act.textContent = AL_ACTION[h.action] || h.action;
      const what = document.createElement("span");
      what.textContent = `${AL_LEVEL[h.level]} · ${h.title}`;
      row.append(time, act, what);
      box.appendChild(row);
    }
    openPicker(AL_HIST_TITLE, box);
  }
  alertPill.addEventListener("click", showAlertHistory);

  // ---------- eventos do servidor ----------
  setMode(uiMode);
  const es = new EventSource("/api/events");
  es.addEventListener("state", (e) => {
    const snap = JSON.parse(e.data);
    kinds = snap.kinds;
    strips = snap.strips;
    lastStatus = snap.status;
    if (!strips[sel.kind] || !strips[sel.kind][sel.index - 1]) sel = { kind: "ch", index: eqCh };
    buildLayers();
    buildChips();
    renderStatus(lastStatus);
    showTab(tab);
  });
  es.addEventListener("strip", (e) => { if (kinds.length) render(JSON.parse(e.data)); });
  es.addEventListener("param", (e) => { const p = JSON.parse(e.data); onEqParam(p.path, p.value); onDynParam(p.path, p.value); onSendParam(p.path, p.value); });
  es.addEventListener("status", (e) => { lastStatus = JSON.parse(e.data); renderStatus(lastStatus); });
  es.addEventListener("alerts", (e) => { alertState = JSON.parse(e.data); renderAlerts(); });
  es.addEventListener("session", (e) => {
    recActive = JSON.parse(e.data);
    if (!recMoments.length || !recPanel.hidden) loadSessions();
    else renderRec();
  });
  es.addEventListener("meters", (e) => {
    const all = JSON.parse(e.data);
    for (const [kind, list] of Object.entries(all)) {
      if (!strips[kind]) continue;
      list.forEach((m, i) => { const st = strips[kind][i]; if (st) { st.meter = m; renderMeter(st); } });
    }
    renderGr();
    renderOvMeters();
    if (lastStatus) { lastStatus.lastMeterAt = Date.now(); renderStatus(lastStatus); }
  });
  setInterval(async () => {
    try { lastStatus = (await (await fetch("/api/state")).json()).status; renderStatus(lastStatus); } catch {}
  }, 3000);
