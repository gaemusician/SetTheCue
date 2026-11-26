// SetTheCue Band: pilih, tambah, dan hapus profil band. Setiap band punya setlist, lirik,
// nama & warna mixer, dan Target waktu sendiri. Datanya disimpan di server; di sini hanya pemilihnya.

export function initBands({ send, toast, openModal }) {
  const root = document.getElementById("band-root");
  if (!root) return { onMessage() {} };
  root.innerHTML =
    '<div class="bd">' +
    '<div class="bd-sel"><i class="fa-solid fa-guitar"></i><select id="bd-select" aria-label="Band"></select></div>' +
    '<button type="button" class="icon-btn" id="bd-add" title="Band baru"><i class="fa-solid fa-plus"></i></button>' +
    '<button type="button" class="icon-btn" id="bd-del" title="Hapus band ini"><i class="fa-solid fa-trash"></i></button>' +
    '</div><div class="bd-note" id="bd-note" hidden></div>';

  const $ = (id) => document.getElementById(id);
  let names = [];
  let active = null;
  let detect = { state: "none" };

  function render() {
    const sel = $("bd-select");
    sel.textContent = "";
    for (const n of names) {
      const o = document.createElement("option");
      o.value = n;
      o.textContent = n;
      sel.appendChild(o);
    }
    if (active) sel.value = active;
    $("bd-del").disabled = names.length <= 1;
    const note = $("bd-note");
    const T = {
      auto: ["ok", "Band terdeteksi dari session Ableton"],
      learned: ["ok", "Band dikenali dari session ini"],
      unsure: ["warn", "Belum yakin band mana. Pilih band, nanti diingat"],
      unknown: ["warn", "Session baru. Pilih band, nanti diingat"],
    }[detect && detect.state];
    note.hidden = !T;
    if (T) { note.className = "bd-note " + T[0]; note.textContent = T[1]; }
  }

  $("bd-select").onchange = (e) => {
    // jangan ganti band saat lirik sedang diedit: tersimpannya nanti ke band yang salah
    if (document.querySelector("#lyr.editing")) {
      toast("Selesaikan edit lirik dulu", true);
      e.target.value = active;
      return;
    }
    send("selectBand", { name: e.target.value });
  };
  $("bd-add").onclick = async () => {
    const name = await openModal({ title: "Band baru", withInput: true, okLabel: "Buat", placeholder: "Nama band…" });
    if (name) send("createBand", { name });
  };
  $("bd-del").onclick = async () => {
    if (!active) return;
    const ok = await openModal({
      title: "Hapus band?",
      message: `“${active}” beserta setlist, lirik, dan pengaturan mixernya akan dipindahkan ke folder .dihapus. Masih bisa dikembalikan manual.`,
      okLabel: "Hapus",
      danger: true,
    });
    if (ok) send("deleteBand", { name: active });
  };

  return {
    onMessage(msg) {
      const b = msg.type === "hello" ? msg.bands : msg.type === "bands" ? msg : null;
      if (b && Array.isArray(b.names)) {
        names = b.names;
        active = b.active;
        detect = b.detect || { state: "none" };
        render();
      } else if (msg.type === "bandChanged") {
        toast((msg.auto ? "Band terdeteksi: " : "Band: ") + msg.name);
      }
    },
  };
}
