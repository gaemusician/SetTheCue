// SetTheCue mixer panel (client): one column per Ableton Group Track.
// LED, vertical fader (-40..+6 dB), dB value, M, S, name. Top: Metronom + Kunci mix.
// Bottom: Reset mix (tap twice). All state lives on the server; this only renders it.
//
// Ableton stores volume as 0..1. 0.85 = 0 dB, 0.9 = +2, 0.95 = +4, 1.0 = +6 and
// 0.7749 = -3 dB are measured from the user's set; points below -6 dB are ESTIMATES
// (see CURVE) — the fader always sends the exact raw value, so SetTheCue and Live
// always agree on position; only the dB label can differ slightly at the low end.

const MIN_DB = -40;
const MAX_DB = 6;
const FOLD_KEY = "setthecue.mixer.folded";
const CURVE = [
  [0.0, -60], [0.1, -52], [0.2, -38], [0.3, -29], [0.4, -22], [0.5, -16], [0.6, -11], [0.7, -6], // estimated
  [0.7749, -3], [0.85, 0], [0.9, 2], [0.95, 4], [1.0, 6], // measured
];

export function volToDb(v) {
  if (!(v > 0.0005)) return -Infinity;
  if (v >= 1) return 6;
  for (let i = 0; i < CURVE.length - 1; i++) {
    const [v0, d0] = CURVE[i];
    const [v1, d1] = CURVE[i + 1];
    if (v <= v1) return d0 + ((d1 - d0) * (v - v0)) / (v1 - v0);
  }
  return 6;
}
export function dbToVol(db) {
  if (db <= CURVE[0][1]) return 0;
  if (db >= 6) return 1;
  for (let i = 0; i < CURVE.length - 1; i++) {
    const [v0, d0] = CURVE[i];
    const [v1, d1] = CURVE[i + 1];
    if (db <= d1) return v0 + ((v1 - v0) * (db - d0)) / (d1 - d0);
  }
  return 1;
}
const dbFrac = (db) => (db === -Infinity ? 0 : Math.min(1, Math.max(0, (db - MIN_DB) / (MAX_DB - MIN_DB))));
function fmtDb(v) {
  const d = volToDb(v);
  if (d === -Infinity) return "−∞";
  const r = Math.abs(d) < 0.05 ? 0 : d;
  return (r > 0 ? "+" : "") + r.toFixed(Math.abs(r) < 10 ? 1 : 0);
}

export function initMixer({ send, toast }) {
  const root = document.getElementById("mixer-root");
  if (!root) return { onMessage() {} };

  let st = { connected: false, metronome: false, locked: false, groups: [] };
  let sig = "";
  let folded = false;
  try { folded = localStorage.getItem(FOLD_KEY) === "1"; } catch {}
  const cols = new Map(); // group id -> elements
  const local = new Map(); // group id -> volume while a finger / mouse is on its fader
  const holdUntil = new Map(); // group id -> time until which server echoes are ignored
  const drags = new Map(); // pointerId -> group id
  const pending = new Map(); // group id -> volume waiting to be sent
  let sendTimer = 0;
  let resetArmed = 0;

  root.innerHTML = `
    <div class="mx" id="mx">
      <div class="mx-head">
        <span class="mx-title">Mixer</span>
        <button type="button" class="mx-btn mx-sq" id="mx-met" title="Metronom (M)" aria-label="Metronom"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" style="stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round"><path d="M8 21 10 4h4l2 17z"/><path d="M12 15 16 7"/><path d="M9 21h6"/></svg></button>
        <button type="button" class="mx-btn lock mx-sq" id="mx-lock" title="Kunci mix (L)" aria-label="Kunci mix"><i class="fa-solid fa-lock-open"></i></button>
        <button type="button" class="mx-btn mx-sq" id="mx-fold" title="Lipat / buka"><i class="fa-solid fa-chevron-down"></i></button>
      </div>
      <div class="mx-body" id="mx-body">
        <div class="mx-note" id="mx-note"></div>
        <div class="mx-cols" id="mx-cols"></div>
        <div class="mx-foot"><button type="button" class="mx-btn" id="mx-reset">Reset mix</button></div>
      </div>
    </div>`;
  const $ = (id) => document.getElementById(id);
  const box = $("mx"), body = $("mx-body"), note = $("mx-note"), colsEl = $("mx-cols");

  const busy = (id) => [...drags.values()].includes(id) || (holdUntil.get(id) || 0) > Date.now();

  function flush() {
    for (const [id, value] of pending) send("mixVolume", { id, value });
    pending.clear();
  }
  function queueVolume(id, v) {
    pending.set(id, v);
    if (!sendTimer) {
      flush();
      sendTimer = setTimeout(() => { sendTimer = 0; flush(); }, 40);
    }
  }

  function buildCols() {
    colsEl.innerHTML = "";
    cols.clear();
    colsEl.style.setProperty("--n", Math.max(1, st.groups.length));
    st.groups.forEach((g, idx) => {
      const col = document.createElement("div");
      col.className = "mx-col";
      const led = document.createElement("span");
      led.className = "mx-led";
      const fader = document.createElement("div");
      fader.className = "mx-fader";
      const zero = document.createElement("i");
      zero.className = "mx-zero";
      zero.style.bottom = `${dbFrac(0) * 100}%`;
      const fill = document.createElement("div");
      fill.className = "mx-fill";
      const thumb = document.createElement("div");
      thumb.className = "mx-thumb";
      fader.append(zero, fill, thumb);
      const db = document.createElement("div");
      db.className = "mx-db";
      const ms = document.createElement("div");
      ms.className = "mx-ms";
      const m = document.createElement("button");
      m.type = "button"; m.className = "m"; m.textContent = "M";
      const s = document.createElement("button");
      s.type = "button"; s.className = "s"; s.textContent = "S";
      ms.append(m, s);
      const name = document.createElement("div");
      name.className = "mx-name";
      const num = document.createElement("b");
      num.textContent = idx < 6 ? String(idx + 1) : "";
      const label = document.createElement("span");
      name.append(num, label);
      name.onclick = () => openDialog(g.id);
      col.append(led, fader, db, ms, name);
      colsEl.appendChild(col);

      const gid = g.id;
      const move = (e) => {
        const r = fader.getBoundingClientRect();
        const frac = Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height));
        let v;
        if (frac < 0.02) v = 0;
        else {
          let d = MIN_DB + frac * (MAX_DB - MIN_DB);
          if (Math.abs(d) < 1) d = 0; // easy landing on 0 dB
          v = dbToVol(d);
        }
        local.set(gid, v);
        paint(gid);
        queueVolume(gid, v);
      };
      fader.addEventListener("pointerdown", (e) => {
        if (st.locked) { toast?.("Mix terkunci"); return; }
        fader.setPointerCapture(e.pointerId);
        drags.set(e.pointerId, gid);
        move(e);
      });
      fader.addEventListener("pointermove", (e) => { if (drags.get(e.pointerId) === gid) move(e); });
      const end = (e) => {
        if (drags.get(e.pointerId) !== gid) return;
        drags.delete(e.pointerId);
        holdUntil.set(gid, Date.now() + 500);
        flush();
        setTimeout(() => paint(gid), 520);
      };
      fader.addEventListener("pointerup", end);
      fader.addEventListener("pointercancel", end);
      fader.addEventListener("dblclick", () => {
        if (st.locked) return;
        local.set(gid, 0.85);
        holdUntil.set(gid, Date.now() + 500);
        paint(gid);
        send("mixVolume", { id: gid, value: 0.85 });
      });
      m.onclick = () => send("mixMute", { id: gid, on: !st.groups.find((x) => x.id === gid)?.mute });
      s.onclick = () => send("mixSolo", { id: gid, on: !st.groups.find((x) => x.id === gid)?.solo });
      cols.set(gid, { col, led, fill, thumb, db, m, s, name, label });
    });
  }

  function paint(id) {
    const g = st.groups.find((x) => x.id === id);
    const c = cols.get(id);
    if (!g || !c) return;
    const v = busy(id) && local.has(id) ? local.get(id) : g.volume;
    const f = dbFrac(volToDb(v)) * 100;
    c.fill.style.height = `${f}%`;
    c.thumb.style.bottom = `${f}%`;
    c.db.textContent = fmtDb(v);
    c.led.classList.toggle("on", g.signal);
    c.label.textContent = g.label || g.name;
    c.name.title = (g.label ? g.name + " — " : "") + "Klik untuk ubah nama & warna";
    if (g.color) c.col.style.setProperty("--c", g.color);
    else c.col.style.removeProperty("--c");
    c.m.classList.toggle("on", g.mute);
    c.s.classList.toggle("on", g.solo);
  }

  function render() {
    body.hidden = folded;
    $("mx-fold").firstElementChild.className = "fa-solid " + (folded ? "fa-chevron-up" : "fa-chevron-down");
    box.classList.toggle("locked", st.locked);
    $("mx-met").classList.toggle("on", st.metronome);
    $("mx-lock").classList.toggle("on", st.locked);
    $("mx-lock").firstElementChild.className = "fa-solid " + (st.locked ? "fa-lock" : "fa-lock-open");
    $("mx-lock").title = st.locked ? "Mix terkunci, ketuk untuk membuka (L)" : "Kunci mix (L)";
    $("mx-met").title = st.metronome ? "Metronom nyala (M)" : "Metronom mati (M)";
    const hasGroups = st.connected && st.groups.length > 0;
    note.hidden = hasGroups;
    colsEl.hidden = !hasGroups;
    $("mx-reset").hidden = !hasGroups;
    if (!st.connected) note.textContent = "Mixer menunggu Ableton…";
    else if (!st.groups.length) note.textContent = "Tidak ada Group Track di set ini.";
    const nextSig = st.groups.map((g) => `${g.id}:${g.name}`).join("|");
    if (nextSig !== sig) { sig = nextSig; buildCols(); }
    for (const g of st.groups) paint(g.id);
  }

  // ---- rename + color dialog ----
  const COLORS = [
    ["Biru", "#2f7cff"], ["Hijau", "#30d158"], ["Kuning", "#ffd60a"], ["Oranye", "#ff9f0a"], ["Merah", "#ff453a"],
    ["Pink", "#ff5fa2"], ["Ungu", "#bf5af2"], ["Tosca", "#40c8e0"], ["Abu", "#8e8e93"],
  ];
  const dlg = document.createElement("div");
  dlg.className = "mx-dlg";
  dlg.hidden = true;
  dlg.innerHTML =
    '<div class="mx-dbox"><h3>Ubah channel</h3><div class="mx-orig" id="mx-orig"></div>' +
    '<input id="mx-label" maxlength="24" autocomplete="off" />' +
    '<div class="mx-sw" id="mx-sw"></div>' +
    '<div class="mx-dact"><button type="button" class="mx-btn" id="mx-dreset">Kembalikan</button><span style="flex:1"></span>' +
    '<button type="button" class="mx-btn" id="mx-dcancel">Batal</button><button type="button" class="mx-btn on" id="mx-dok">Simpan</button></div></div>';
  document.body.appendChild(dlg);
  const dInput = dlg.querySelector("#mx-label");
  const sw = dlg.querySelector("#mx-sw");
  let dlgId = null;
  let dlgColor = "";
  COLORS.forEach(([n, hex]) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "mx-swatch";
    b.title = n;
    b.dataset.c = hex;
    b.style.background = hex;
    b.onclick = () => { dlgColor = hex; markSwatch(); };
    sw.appendChild(b);
  });
  function markSwatch() {
    sw.querySelectorAll(".mx-swatch").forEach((b) => b.classList.toggle("sel", b.dataset.c === (dlgColor || COLORS[0][1])));
  }
  function openDialog(id) {
    const g = st.groups.find((x) => x.id === id);
    if (!g) return;
    dlgId = id;
    dlgColor = g.color || "";
    dlg.querySelector("#mx-orig").textContent = "Nama di Ableton: " + g.name;
    dInput.value = g.label || "";
    dInput.placeholder = g.name;
    markSwatch();
    dlg.hidden = false;
    setTimeout(() => { dInput.focus(); dInput.select(); }, 30);
  }
  function closeDialog() { dlg.hidden = true; dlgId = null; }
  function saveDialog(label, color) {
    if (dlgId != null) send("mixStyle", { id: dlgId, label, color });
    closeDialog();
  }
  dlg.querySelector("#mx-dok").onclick = () => saveDialog(dInput.value.trim(), dlgColor);
  dlg.querySelector("#mx-dreset").onclick = () => saveDialog("", "");
  dlg.querySelector("#mx-dcancel").onclick = closeDialog;
  dlg.addEventListener("pointerdown", (e) => { if (e.target === dlg) closeDialog(); });
  dInput.addEventListener("keydown", (e) => { if (e.key === "Enter") saveDialog(dInput.value.trim(), dlgColor); });
  // Window capture runs before every other Esc handler (Esc elsewhere means Stop / close lyrics).
  window.addEventListener("keydown", (e) => {
    if (!dlg.hidden && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeDialog(); }
  }, true);

  $("mx-met").onclick = () => send("mixMetronome", { on: !st.metronome });
  $("mx-lock").onclick = () => send("mixLock", { on: !st.locked });
  $("mx-fold").onclick = () => {
    folded = !folded;
    try { localStorage.setItem(FOLD_KEY, folded ? "1" : "0"); } catch {}
    render();
  };
  $("mx-reset").onclick = () => {
    const btn = $("mx-reset");
    if (Date.now() < resetArmed) {
      resetArmed = 0;
      btn.classList.remove("warn");
      btn.textContent = "Reset mix";
      send("mixReset");
    } else {
      resetArmed = Date.now() + 3000;
      btn.classList.add("warn");
      btn.textContent = "Yakin? Tekan lagi";
      setTimeout(() => {
        if (Date.now() >= resetArmed) { btn.classList.remove("warn"); btn.textContent = "Reset mix"; }
      }, 3100);
    }
  };

  // Shortcuts: M metronom, L kunci, 1-6 mute bus, Shift+1-6 solo bus.
  document.addEventListener("keydown", (e) => {
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.querySelector(".lyr.editing")) return; // lyric marking uses M / U
    if (document.getElementById("modal")?.classList.contains("show")) return;
    if (e.code === "KeyM") { e.preventDefault(); send("mixMetronome", { on: !st.metronome }); return; }
    if (e.code === "KeyL") { e.preventDefault(); send("mixLock", { on: !st.locked }); return; }
    const d = /^Digit([1-6])$/.exec(e.code);
    if (d) {
      const g = st.groups[Number(d[1]) - 1];
      if (!g) return;
      e.preventDefault();
      if (e.shiftKey) send("mixSolo", { id: g.id, on: !g.solo });
      else send("mixMute", { id: g.id, on: !g.mute });
    }
  });

  render();
  return {
    onMessage(msg) {
      if (msg.type === "hello" && msg.mixer) { st = msg.mixer; render(); }
      else if (msg.type === "mixer" && msg.state) { st = msg.state; render(); }
    },
  };
}
