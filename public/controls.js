// SetTheCue controls module: shortcut-focus banner + big on-screen transport buttons.
// The keyboard shortcuts themselves live in app.js; this module shows whether they are
// currently live (the window must be focused) and offers the same actions as buttons.

export function initControls({ send }) {
  const focusRoot = document.getElementById("focus-root");
  const tRoot = document.getElementById("transport-root");
  let snap = null;

  // ---- focus banner -------------------------------------------------------
  const hasKeyboard = !window.matchMedia || window.matchMedia("(pointer: fine)").matches;
  let fb, fbText;
  if (focusRoot) {
    focusRoot.innerHTML =
      `<div class="fb off" id="fb"><span class="fb-dot"></span><span id="fb-text"></span>` +
      `<button type="button" id="fb-btn">Aktifkan</button></div>`;
    fb = document.getElementById("fb");
    fbText = document.getElementById("fb-text");
    document.getElementById("fb-btn").onclick = () => { window.focus(); document.body.focus?.(); updateBanner(); };
    focusRoot.hidden = !hasKeyboard; // phones / tablets without a keyboard: no banner
  }
  function typing() {
    const t = document.activeElement;
    return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
  }
  function updateBanner() {
    if (!fb || !hasKeyboard) return;
    const state = !document.hasFocus() ? "off" : typing() ? "paused" : "on";
    fb.className = "fb " + state;
    fbText.textContent =
      state === "on" ? "Shortcut aktif"
      : state === "paused" ? "Shortcut dijeda (sedang mengetik)"
      : "Shortcut nonaktif — jendela SetTheCue tidak aktif";
  }
  window.addEventListener("focus", updateBanner);
  window.addEventListener("blur", updateBanner);
  document.addEventListener("focusin", updateBanner);
  document.addEventListener("focusout", () => setTimeout(updateBanner, 0));
  document.addEventListener("visibilitychange", updateBanner);
  setInterval(updateBanner, 1000); // safety net
  updateBanner();

  // ---- transport buttons --------------------------------------------------
  let mainBtn;
  if (tRoot) {
    tRoot.innerHTML =
      `<div class="tp">` +
      `<button type="button" class="tp-btn" data-a="prev" title="Sebelumnya (←)"><i class="fa-solid fa-backward-step"></i><span>Sebelumnya</span></button>` +
      `<button type="button" class="tp-btn tp-main" data-a="toggle" title="Play / Jeda (Spasi)"><i class="fa-solid fa-play"></i><span>Play</span></button>` +
      `<button type="button" class="tp-btn" data-a="next" title="Berikutnya (→)"><i class="fa-solid fa-forward-step"></i><span>Berikutnya</span></button>` +
      `</div>`;
    mainBtn = tRoot.querySelector(".tp-main");
    tRoot.querySelectorAll(".tp-btn").forEach((b) => {
      b.onclick = () => {
        const a = b.dataset.a;
        if (a === "prev") send("prev");
        else if (a === "next") send("next");
        else if (snap?.status === "playing") send("pause");
        else if (snap?.status === "paused") send("resume");
        else send("play");
        b.blur(); // keep keyboard shortcuts working right after a click
      };
    });
  }
  function renderTransport() {
    if (!mainBtn) return;
    const st = snap?.status;
    const icon = st === "playing" ? "fa-pause" : "fa-play";
    const label = st === "playing" ? "Pause" : st === "paused" ? "Lanjut" : "Play";
    mainBtn.querySelector("i").className = "fa-solid " + icon;
    mainBtn.querySelector("span").textContent = label;
  }
  renderTransport();

  return {
    onMessage(msg) {
      if ((msg.type === "hello" || msg.type === "state") && msg.snapshot) {
        snap = msg.snapshot;
        renderTransport();
      }
    },
  };
}
