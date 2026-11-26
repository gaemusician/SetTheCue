// SetTheCue stage timer widget. The server holds the state (so every window and device agrees);
// this draws it and sends Mulai / Jeda / Reset / Target waktu.
// Target waktu: berapa lama jatah tampil. Sisa waktu = target - waktu di panggung.
// Spare = Sisa waktu - sisa durasi lagu di Set List (hanya informasi, tidak mengubah pemutaran).

const pad = (n) => String(n).padStart(2, "0");

export function fmtElapsed(ms) {
  const s = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${pad(m)}:${pad(s % 60)}`;
}

export function fmtDur(sec) {
  const s = Math.round(Math.abs(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}
export const fmtSigned = (sec) => (sec < 0 ? "\u2212" : "+") + fmtDur(sec);

// "30" = 30 menit, "30:00" = 30 menit 0 detik, "1:30:00" = 1 jam 30 menit. Kosong = hapus target.
export function parseTarget(text) {
  const t = String(text ?? "").trim();
  if (!t) return 0;
  if (!/^\d+(:\d{1,2}){0,2}$/.test(t)) return null;
  const p = t.split(":").map(Number);
  const sec = p.length === 1 ? p[0] * 60 : p.length === 2 ? p[0] * 60 + p[1] : p[0] * 3600 + p[1] * 60 + p[2];
  return sec * 1000;
}

export function initTimer({ send, toast, getSetRemainingSec }) {
  const root = document.getElementById("timer-root");
  if (!root) return { onMessage() {} };

  let st = { running: false, startedAt: 0, accMs: 0, targetMs: 0 };
  let skew = 0; // this device's clock minus the server's clock
  let resetArmed = 0;
  let editing = false;

  root.innerHTML =
    '<div class="tm" id="tm"><span class="tm-label">Di panggung</span>' +
    '<span class="tm-time" id="tm-time">0:00:00</span>' +
    '<span class="tm-btns"><button type="button" class="tm-btn main" id="tm-go">Mulai</button>' +
    '<button type="button" class="tm-btn" id="tm-reset" hidden>Reset</button></span></div>' +
    '<div class="tm-extra" id="tm-extra">' +
    '<div class="tm-tile target" id="tm-target" role="button" tabindex="0"><span class="k">Target waktu</span><span class="v" id="tm-target-v">Atur</span></div>' +
    '<div class="tm-tile" id="tm-left" hidden><span class="k">Sisa waktu</span><span class="v" id="tm-left-v">\u2014</span></div>' +
    '<div class="tm-tile" id="tm-spare" hidden><span class="k">Spare</span><span class="v" id="tm-spare-v">\u2014</span></div></div>';
  const box = document.getElementById("tm");
  const timeEl = document.getElementById("tm-time");
  const go = document.getElementById("tm-go");
  const reset = document.getElementById("tm-reset");
  const target = document.getElementById("tm-target");
  const left = document.getElementById("tm-left");
  const spare = document.getElementById("tm-spare");

  const elapsed = () => st.accMs + (st.running ? Math.max(0, Date.now() - skew - st.startedAt) : 0);

  function render() {
    const state = st.running ? "run" : st.accMs > 0 ? "paused" : "idle";
    box.className = "tm " + state;
    timeEl.textContent = fmtElapsed(elapsed());
    go.textContent = state === "run" ? "Jeda" : state === "paused" ? "Lanjut" : "Mulai";
    reset.hidden = state === "idle";
    if (Date.now() >= resetArmed && reset.classList.contains("warn")) {
      reset.classList.remove("warn");
      reset.textContent = "Reset";
    }

    const tgt = st.targetMs || 0;
    const tv = document.getElementById("tm-target-v");
    if (tv && !editing) tv.textContent = tgt ? fmtDur(tgt / 1000) : "Atur";
    left.hidden = spare.hidden = !tgt;
    if (tgt) {
      const leftSec = (tgt - elapsed()) / 1000;
      document.getElementById("tm-left-v").textContent = leftSec < 0 ? fmtSigned(leftSec) : fmtDur(leftSec);
      left.className = "tm-tile" + (leftSec < 0 ? " neg" : "");
      const songs = typeof getSetRemainingSec === "function" ? getSetRemainingSec() : null;
      const sv = document.getElementById("tm-spare-v");
      if (songs == null) {
        sv.textContent = "\u2014";
        spare.className = "tm-tile";
      } else {
        const sp = leftSec - songs;
        sv.textContent = fmtSigned(sp);
        spare.className = "tm-tile spare " + (sp < 0 ? "neg" : "pos");
      }
    }
  }

  go.onclick = () => send(st.running ? "timerPause" : "timerStart");
  reset.onclick = () => {
    if (Date.now() < resetArmed) {
      resetArmed = 0;
      send("timerReset");
    } else {
      resetArmed = Date.now() + 3000;
      reset.classList.add("warn");
      reset.textContent = "Yakin?";
    }
    render();
  };

  // Ketuk Target waktu untuk mengisi (menit atau mm:ss); kosongkan untuk menghapus.
  function editTarget() {
    if (editing) return;
    editing = true;
    const v = document.getElementById("tm-target-v");
    const inp = document.createElement("input");
    inp.type = "text";
    inp.inputMode = "numeric";
    inp.className = "tm-input";
    inp.placeholder = "mm:ss";
    inp.value = st.targetMs ? fmtDur(st.targetMs / 1000) : "";
    v.replaceWith(inp);
    inp.focus();
    inp.select();
    const finish = (save) => {
      if (!editing) return;
      editing = false;
      if (save) {
        const ms = parseTarget(inp.value);
        if (ms === null) toast && toast("Tulis menit atau mm:ss, misalnya 30 atau 30:00", true);
        else if (ms !== (st.targetMs || 0)) send("timerTarget", { ms });
      }
      const span = document.createElement("span");
      span.className = "v";
      span.id = "tm-target-v";
      inp.replaceWith(span);
      render();
    };
    inp.onkeydown = (e) => {
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") finish(false);
    };
    inp.onblur = () => finish(true);
  }
  target.onclick = editTarget;
  target.onkeydown = (e) => { if ((e.key === "Enter" || e.key === " ") && e.target === target) { e.preventDefault(); editTarget(); } };

  setInterval(render, 250);
  render();

  const apply = (s) => {
    st = s;
    skew = Date.now() - (s.serverNow || Date.now());
    render();
  };
  return {
    onMessage(msg) {
      if (msg.type === "hello" && msg.timer) apply(msg.timer);
      else if (msg.type === "timer" && msg.state) apply(msg.state);
    },
  };
}
