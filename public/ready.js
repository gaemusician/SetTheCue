// SetTheCue Ready check: dua simbol status sebelum naik panggung.
// Ketuk simbol untuk melihat penjelasannya (di HP tidak ada hover).

export function computeChecks({ abletonConnected, snapshot }) {
  const connected = Boolean(abletonConnected);
  const list = snapshot && snapshot.setlist ? snapshot.setlist : [];
  const songs = snapshot && snapshot.songs ? snapshot.songs.length : 0;
  const missing = (snapshot && snapshot.missing) || [];
  const ableton = connected
    ? { ok: true, text: "Ableton terhubung" }
    : { ok: false, text: "Ableton belum terhubung. Buka Ableton dan pastikan AbletonOSC aktif." };
  let locator;
  if (!connected) locator = { ok: false, text: "Locator belum bisa dicek karena Ableton belum terhubung." };
  else if (songs === 0) locator = { ok: false, text: "Belum ada locator lagu di Ableton." };
  else if (list.length === 0) locator = { ok: false, text: "Set List masih kosong." };
  else if (missing.length) locator = { ok: false, text: "Tidak ada lagi di Ableton: " + missing.join(", ") + ". Susun ulang Set List untuk menghapus peringatan." };
  else locator = { ok: true, text: "Locator cocok dengan Set List (" + list.length + " lagu)" };
  return [
    { id: "ableton", icon: "fa-plug", ok: ableton.ok, text: ableton.text, level: ableton.ok ? "ok" : "bad" },
    { id: "locator", icon: "fa-list-check", ok: locator.ok, text: locator.text, level: locator.ok ? "ok" : "warn" },
  ];
}

export function initReady({ getState, toast }) {
  const root = document.getElementById("ready-root");
  if (!root) return { refresh() {} };
  root.innerHTML =
    '<div class="rc"><span class="rc-title">Ready check</span><span class="rc-icons" id="rc-icons"></span>' +
    '<span class="rc-count" id="rc-count"></span></div>';
  const icons = document.getElementById("rc-icons");
  const count = document.getElementById("rc-count");

  function refresh() {
    const checks = computeChecks(getState());
    icons.innerHTML = "";
    for (const c of checks) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "rc-ic " + c.level;
      b.title = c.text;
      b.setAttribute("aria-label", c.text);
      b.innerHTML =
        '<i class="fa-solid ' + c.icon + '"></i>' +
        '<span class="rc-bd"><i class="fa-solid ' + (c.ok ? "fa-check" : "fa-exclamation") + '"></i></span>';
      b.onclick = () => toast(c.text, !c.ok);
      icons.appendChild(b);
    }
    const okCount = checks.filter((c) => c.ok).length;
    count.textContent = okCount + " dari " + checks.length + " siap";
    count.className = "rc-count " + (okCount === checks.length ? "all" : "some");
  }
  refresh();
  return { refresh };
}
