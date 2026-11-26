// SetTheCue lyrics screen (client). Follows the active song and the playhead that
// the server already broadcasts, so lyrics stay in sync with Ableton automatically.
// Bars are counted from the song's locator (bar 1 = song start), assuming 4/4.

const BEATS_PER_BAR = 4;
const SEC_TOL = 0.3; // toleransi bar: baris yang masuk <= 1 beat lebih awal ikut bagian barunya
const LINE_RE = /^\[(\d+(?:\.\d+)?)\]\s?(.*)$/;
const SIZE_KEY = "setthecue.lyrics.size";

export function parseLyrics(text) {
  const lines = String(text || "").replace(/\r/g, "").split("\n").map((raw) => {
    const m = raw.match(LINE_RE);
    return m ? { bar: parseFloat(m[1]), text: m[2] } : { bar: null, text: raw };
  });
  while (lines.length && lines[lines.length - 1].bar == null && !lines[lines.length - 1].text.trim()) lines.pop();
  return lines;
}
const fmtBar = (b) => String(Math.round(b * 100) / 100);
export function serializeLyrics(lines) {
  return lines.map((l) => (l.bar == null ? l.text : `[${fmtBar(l.bar)}] ${l.text}`)).join("\n");
}

export function initLyrics({ send, getSnapshot: appSnapshot, toast }) {
  let latest = null; // snapshot terbaru dari pesan server
  const getSnapshot = () => latest || appSnapshot();
  const root = document.getElementById("lyrics-root");
  const openBtn = document.getElementById("lyrics-btn");
  if (!root) return { onMessage() {} };

  root.innerHTML = `
    <div class="lyr" id="lyr" hidden>
      <div class="lyr-bar">
        <div class="lyr-title" id="lyr-title">—</div>
        <div class="lyr-tools">
          <button id="lyr-smaller" title="Huruf lebih kecil"><i class="fa-solid fa-minus"></i></button>
          <button id="lyr-bigger" title="Huruf lebih besar"><i class="fa-solid fa-plus"></i></button>
          <button id="lyr-edit" title="Edit lirik"><i class="fa-solid fa-pen-to-square"></i></button>
          <button id="lyr-full" title="Layar penuh"><i class="fa-solid fa-expand"></i></button>
          <button id="lyr-close" title="Tutup"><i class="fa-solid fa-xmark"></i></button>
        </div>
      </div>
      <div class="lyr-view" id="lyr-view"></div>
      <div class="lyr-editor" id="lyr-editor" hidden>
        <div class="lyr-ed-bar">
          <span id="lyr-ed-hint"></span>
          <button id="lyr-mode">Mulai tandai</button>
          <button id="lyr-save" class="primary">Simpan</button>
          <button id="lyr-back">Batal</button>
        </div>
        <textarea id="lyr-text" spellcheck="false" placeholder="Tempel lirik di sini, satu baris per baris nyanyian…"></textarea>
        <div id="lyr-mark" hidden></div>
      </div>
    </div>`;

  const $ = (id) => document.getElementById(id);
  const lyr = $("lyr"), view = $("lyr-view"), editor = $("lyr-editor");
  const ta = $("lyr-text"), markBox = $("lyr-mark"), hint = $("lyr-ed-hint");

  let open = false;
  let full = false; // true = whole screen; false = docked inside the page
  let name = null; // song whose lyrics are shown (frozen while editing)
  let text = "";
  let lines = [];
  let rendered = false;
  let lastActive = -2;
  let beat = 0, songStart = 0, hasProgress = false;
  let songStartName = null; // lagu pemilik songStart yang di-broadcast
  let lastExact = false, secSig = "", lineEls = [];
  let instEls = [], lastInstKey = ""; // bagian instrumental: baris titik penghitung bar
  let mode = "view"; // "view" | "text" | "mark"
  let markLines = [], markPtr = 0;
  let size = 56;
  try { size = Number(localStorage.getItem(SIZE_KEY)) || 56; } catch {}
  const applySize = () => lyr.style.setProperty("--lyr-size", `${size}px`);
  applySize();

  // The server only sends the playhead ~10x/s and a phone may get it late. Between messages we keep
  // counting from the last known beat (using the tempo), so lines switch on time instead of on arrival.
  let beatAt = 0; // performance.now() when `beat` last arrived
  // Optional lead in ms for a device that is always a bit late: open lyrics.html?lead=300 once
  // (remembered on that device). 0 = no correction.
  const LEAD_MS = (() => {
    try {
      const q = new URLSearchParams(location.search).get("lead");
      if (q != null) localStorage.setItem("setthecue.lyrics.lead", q);
      return Number(localStorage.getItem("setthecue.lyrics.lead")) || 0;
    } catch { return 0; }
  })();
  function curBeat(lead = 0) {
    const snap = getSnapshot();
    if (!hasProgress || snap?.status !== "playing" || !snap?.tempo) return beat;
    const dt = Math.min(performance.now() - beatAt, 500) + lead;
    return beat + (dt / 60000) * snap.tempo;
  }
  const curBar = (lead = 0) => (curBeat(lead) - songStart) / BEATS_PER_BAR + 1;

  // ---- viewing ----
  function placeholder(msg) {
    view.innerHTML = "";
    const d = document.createElement("div");
    d.className = "lyr-line lyr-empty";
    d.textContent = msg;
    view.appendChild(d);
    rendered = false;
  }
  // ---- nama bagian (locator) di dalam lirik ----
  // Bar tiap baris lirik; baris tanpa waktu ikut bar baris bertanda sebelumnya.
  function effectiveBars() {
    let last = null;
    return lines.map((l) => { if (l.bar != null) last = l.bar; return last; });
  }
  // Perkiraan bar akhir lagu (dipakai hanya sebelum lagu diputar).
  function songEndBar() {
    let m = 0;
    for (const l of lines) if (l.bar != null && l.bar > m) m = l.bar;
    return m ? m + 8 : null;
  }
  // Nama locator dalam satuan bar. Tepat kalau posisi awal lagu sudah diketahui
  // (lagu sedang diputar), kalau belum diperkirakan dari proporsi tiap bagian.
  function sectionBars() {
    const snap = getSnapshot();
    const secs = snap?.sections || [];
    lastExact = false;
    if (!secs.length) return [];
    const exact = hasProgress && songStartName != null && songStartName === snap?.current?.name;
    const endBar = songEndBar();
    const out = [];
    for (const x of secs) {
      const bar = x.relBar != null
        ? x.relBar
        : exact && x.atBeats != null
        ? (x.atBeats - songStart) / BEATS_PER_BAR + 1
        : endBar != null && x.startFrac != null ? 1 + x.startFrac * (endBar - 1) : null;
      if (bar != null && x.name) out.push({ name: x.name, bar });
    }
    lastExact = exact;
    out.sort((a, b) => a.bar - b.bar);
    return out;
  }
  function addSecEl(secs, k) {
    const sec = secs[k];
    view.appendChild(secEl(sec));
    const next = secs[k + 1];
    if (!next) return;
    const from = sec.bar, to = next.bar;
    const hasLyric = lines.some((l) => l.bar != null && l.bar >= from - SEC_TOL && l.bar < to - SEC_TOL);
    const n = Math.round(to - from);
    if (hasLyric || n < 1) return;
    const row = document.createElement("div");
    row.className = "lyr-inst";
    row.style.color = secColor(sec.name);
    const dots = [];
    for (let j = 0; j < Math.min(n, 64); j++) {
      const d = document.createElement("i");
      row.appendChild(d);
      dots.push(d);
    }
    const nEl = document.createElement("span");
    nEl.className = "n";
    nEl.textContent = n + " bar";
    row.appendChild(nEl);
    view.appendChild(row);
    instEls.push({ el: row, from, to, dots, n: nEl });
  }
  function sigNow() {
    return (getSnapshot()?.sections || []).map((x) => x.name + "@" + x.atBeats).join("|");
  }
  const SEC_COLORS = [
    [/pre[\s-]*chorus/i, "#ff9f0a"],
    [/chorus|reff|refrain/i, "#ff375f"],
    [/verse|bait/i, "#30d158"],
    [/interlude|instrumental|solo/i, "#bf5af2"],
    [/breakdown/i, "#ff6b57"],
    [/bridge/i, "#ffd60a"],
    [/outro|ending/i, "#8e9aaf"],
    [/intro/i, "#5ac8fa"],
  ];
  function secColor(name) {
    const n = String(name || "");
    for (const [re, col] of SEC_COLORS) if (re.test(n)) return col;
    return "#ffd60a";
  }
  function secEl(sec) {
    const d = document.createElement("div");
    d.className = "lyr-sec";
    d.textContent = sec.name;
    d.style.color = secColor(sec.name);
    return d;
  }

  function renderView() {
    $("lyr-title").textContent = name || "—";
    setPad();
    if (!name) return placeholder("Belum ada lagu aktif. Tekan Play di Ableton atau SetTheCue.");
    if (!lines.some((l) => l.text.trim())) return placeholder("Belum ada lirik untuk lagu ini. Tekan tombol edit untuk menempel lirik.");
    view.innerHTML = "";
    lineEls = [];
    instEls = [];
    const secs = sectionBars();
    const eff = effectiveBars();
    let si = 0;
    lines.forEach((l, i) => {
      while (si < secs.length && eff[i] != null && secs[si].bar <= eff[i] + SEC_TOL) addSecEl(secs, si++);
      const d = document.createElement("div");
      d.className = "lyr-line";
      d.textContent = l.text || "\u00a0";
      lineEls.push(d);
      view.appendChild(d);
    });
    while (si < secs.length) addSecEl(secs, si++);
    secSig = sigNow();
    rendered = true;
    lastActive = -2;
    updateActive();
  }
  function activeIndex() {
    const cb = curBar(LEAD_MS);
    let idx = -1;
    for (let i = 0; i < lines.length; i++) if (lines[i].bar != null && lines[i].bar <= cb + 1e-6) idx = i;
    return idx;
  }
  // Keep the lit line exactly in the middle of the panel. Own scroll animation: it only
  // moves the lyrics panel (never the page), and re-targets instantly on every change.
  let scrollAnim = 0;
  function centerOn(el) {
    const vr = view.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const target = view.scrollTop + (r.top - vr.top) + r.height / 2 - vr.height / 2;
    cancelAnimationFrame(scrollAnim);
    const start = view.scrollTop;
    const dist = target - start;
    if (Math.abs(dist) < 2) return;
    const t0 = performance.now();
    const dur = 260;
    const step = (now) => {
      const p = Math.min(1, (now - t0) / dur);
      view.scrollTop = start + dist * (1 - Math.pow(1 - p, 3));
      if (p < 1) scrollAnim = requestAnimationFrame(step);
    };
    scrollAnim = requestAnimationFrame(step);
  }
  // Half-panel padding above and below, so even the first and last lines can be centered.
  function setPad() {
    const p = Math.round(view.clientHeight / 2) + "px";
    if (view.style.paddingTop !== p) { view.style.paddingTop = p; view.style.paddingBottom = p; }
  }
  function updateActive() {
    if (!rendered || lineEls.length !== lines.length) return;
    const a = hasProgress ? activeIndex() : -1;
    const cb = curBar();
    const inst = hasProgress ? instEls.find((x) => cb >= x.from - 1e-6 && cb < x.to) : null;
    const pos = inst ? Math.min(inst.dots.length - 1, Math.floor(cb - inst.from + 1e-6)) : -1;
    const key = (inst ? instEls.indexOf(inst) : -1) + ":" + pos;
    if (a === lastActive && key === lastInstKey) return;
    lastActive = a;
    lastInstKey = key;
    instEls.forEach((x) => {
      const on = x === inst;
      x.el.style.display = on ? "" : "none";
      const past = hasProgress && cb >= x.to;
      x.dots.forEach((d, j) => { d.className = on ? (j < pos ? "done" : j === pos ? "now" : "") : past ? "done" : ""; });
      x.n.textContent = on ? Math.max(1, Math.ceil(x.to - cb - 1e-6)) + " bar lagi" : Math.round(x.to - x.from) + " bar";
    });
    let nx = -1;
    for (let i = a + 1; i < lines.length; i++) if (lines[i].text.trim()) { nx = i; break; }
    for (let i = 0; i < lines.length; i++) {
      lineEls[i].className = "lyr-line" + (i === a && !inst ? " cur" : i === nx ? " next" : "");
    }
    const target = inst ? inst.el : lineEls[a >= 0 ? a : nx >= 0 ? nx : 0];
    if (target) centerOn(target);
  }

  function syncSong() {
    if (!open || mode !== "view") return;
    const n = getSnapshot()?.current?.name ?? null;
    if (n === name) return;
    name = n;
    text = "";
    lines = [];
    renderView();
    if (name) send("getLyrics", { name });
  }

  // ---- open / close ----
  function setFull(on) {
    if (window.LYR_STANDALONE) on = true; // the lyrics window always fills itself
    full = on;
    lyr.classList.toggle("full", on);
    try {
      if (on && !window.LYR_STANDALONE) document.documentElement.requestFullscreen?.().catch(() => {});
      else if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    } catch {}
    setPad();
    lastActive = -2;
    if (open) updateActive();
  }
  function openScreen(asFull = false) {
    open = true;
    lyr.hidden = false;
    setFull(asFull);
    name = undefined; // force a fresh load
    syncSong();
    if (name === undefined) { name = null; }
    renderView();
    if (!full) lyr.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  function closeScreen() {
    if (window.LYR_STANDALONE) { window.close(); return; }
    if (mode !== "view") leaveEditor();
    open = false;
    lyr.hidden = true;
    setFull(false);
    if (location.hash === "#lirik") history.replaceState(null, "", location.pathname + location.search);
  }

  // ---- editing ----
  function showMode() {
    const marking = mode === "mark";
    lyr.classList.toggle("editing", mode !== "view");
    ta.hidden = marking;
    markBox.hidden = !marking;
    $("lyr-mode").textContent = marking ? "Edit teks" : "Mulai tandai";
    hint.textContent = marking
      ? "Putar lagunya, tekan M tiap baris mulai dinyanyikan. U = batalkan. Klik baris untuk pindah."
      : "Tempel lirik polos (atau edit). Lalu tekan “Mulai tandai”.";
  }
  function renderMark() {
    markBox.innerHTML = "";
    markLines.forEach((l, i) => {
      const d = document.createElement("div");
      d.className = "mk-line" + (i === markPtr ? " ptr" : "") + (l.bar == null ? " unset" : "");
      const b = document.createElement("span");
      b.className = "b";
      b.textContent = l.bar == null ? "·" : fmtBar(l.bar);
      const t = document.createElement("span");
      t.className = "t";
      t.textContent = l.text || "\u00a0";
      d.append(b, t);
      d.onclick = () => { markPtr = i; renderMark(); };
      markBox.appendChild(d);
    });
    markBox.querySelector(".ptr")?.scrollIntoView({ block: "center" });
  }
  function startEditor() {
    if (!name) return toast("Pilih / putar sebuah lagu dulu");
    mode = "text";
    ta.value = text || "";
    editor.hidden = false;
    showMode();
    ta.focus();
  }
  function leaveEditor() {
    mode = "view";
    lyr.classList.remove("editing");
    editor.hidden = true;
    syncSong(); // catch up if the song changed while editing
  }
  function toggleMark() {
    if (mode === "text") {
      markLines = parseLyrics(ta.value);
      markPtr = markLines.findIndex((l) => l.bar == null && l.text.trim());
      if (markPtr < 0) markPtr = markLines.length;
      mode = "mark";
      showMode();
      renderMark();
    } else if (mode === "mark") {
      ta.value = serializeLyrics(markLines);
      mode = "text";
      showMode();
    }
  }
  function skipBlanks() {
    while (markPtr < markLines.length && !markLines[markPtr].text.trim()) markPtr++;
  }
  function doMark() {
    if (mode !== "mark") return;
    if (!hasProgress) return toast("Putar lagunya dulu, lalu tekan M");
    skipBlanks();
    if (markPtr >= markLines.length) return toast("Semua baris sudah ditandai");
    markLines[markPtr].bar = Math.max(1, Math.round(curBar() * 4) / 4); // nearest beat
    markPtr++;
    skipBlanks();
    renderMark();
  }
  function undoMark() {
    if (mode !== "mark") return;
    let i = Math.min(markPtr, markLines.length) - 1;
    while (i > 0 && !markLines[i].text.trim()) i--;
    if (i < 0) return;
    markLines[i].bar = null;
    markPtr = i;
    renderMark();
  }
  function save() {
    if (mode === "text") markLines = parseLyrics(ta.value);
    const out = serializeLyrics(markLines);
    const untimed = markLines.filter((l) => l.bar == null && l.text.trim()).length;
    send("saveLyrics", { name, text: out });
    text = out;
    lines = parseLyrics(out);
    leaveEditor();
    renderView();
    toast(untimed ? `Tersimpan — ${untimed} baris belum punya waktu` : "Lirik tersimpan");
  }

  // ---- wiring ----
  try { new ResizeObserver(() => { setPad(); lastActive = -2; updateActive(); }).observe(view); } catch {}
  setInterval(() => { if (open && mode === "view") updateActive(); }, 60); // advance between server ticks
  openBtn?.addEventListener("click", () => {
    if (window.LYR_STANDALONE) return;
    window.open("/lyrics.html#lirik", "setthecue-lyrics"); // SetTheCue app: opens / closes the lyrics window
  });
  $("lyr-close").onclick = closeScreen;
  $("lyr-edit").onclick = startEditor;
  $("lyr-mode").onclick = toggleMark;
  $("lyr-save").onclick = save;
  $("lyr-back").onclick = leaveEditor;
  $("lyr-bigger").onclick = () => { size = Math.min(140, size + 6); applySize(); try { localStorage.setItem(SIZE_KEY, size); } catch {} };
  $("lyr-smaller").onclick = () => { size = Math.max(24, size - 6); applySize(); try { localStorage.setItem(SIZE_KEY, size); } catch {} };
  $("lyr-full").onclick = () => setFull(!full);

  // Capture phase: while the lyrics screen is open, Escape closes it instead of
  // reaching SetTheCue's own Escape = Stop shortcut.
  document.addEventListener("keydown", (e) => {
    if (!open) return;
    if (e.key === "Escape") {
      e.preventDefault(); e.stopPropagation();
      if (mode !== "view") leaveEditor(); else if (full) setFull(false); else closeScreen();
      return;
    }
    if (e.target === ta || e.metaKey || e.ctrlKey || e.altKey) return;
    if (mode === "mark" && (e.key === "m" || e.key === "M")) { e.preventDefault(); e.stopPropagation(); doMark(); }
    else if (mode === "mark" && (e.key === "u" || e.key === "U" || e.key === "Backspace")) {
      e.preventDefault(); e.stopPropagation(); undoMark();
    }
  }, true);

  window.addEventListener("hashchange", () => { if (location.hash === "#lirik" && !open) openScreen(true); });
  document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement && full) setFull(false); });
  if (location.hash === "#lirik") openScreen(true); // tablet / vocalist link opens full screen

  return {
    onMessage(msg) {
      if ((msg.type === "hello" || msg.type === "state") && msg.snapshot) latest = msg.snapshot;
      switch (msg.type) {
        case "hello":
          syncSong();
          break;
        case "state":
          if (getSnapshot()?.status === "idle") { hasProgress = false; lastActive = -2; }
          syncSong();
          if (open && mode === "view" && rendered && sigNow() !== secSig) renderView();
          updateActive();
          break;
        case "progress":
          beat = msg.beat;
          beatAt = performance.now();
          songStart = msg.songStart ?? 0;
          hasProgress = true;
          {
            // begitu posisi awal lagu diketahui, pindahkan nama bagian ke posisi tepat
            const prevName = songStartName;
            songStartName = getSnapshot()?.current?.name ?? null;
            if (songStartName !== prevName && open && mode === "view" && rendered && (getSnapshot()?.sections || []).length) renderView();
          }
          if (open && mode === "view") updateActive();
          break;
        case "bandChanged":
          // band lain = folder lirik lain: muat ulang lirik lagu yang sedang tampil
          if (open && mode === "view") { name = undefined; syncSong(); }
          break;
        case "lyrics":
          if (open && mode === "view" && msg.name === name) {
            text = msg.text || "";
            lines = parseLyrics(text);
            renderView();
          }
          break;
      }
    },
  };
}
