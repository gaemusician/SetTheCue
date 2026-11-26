// SetTheCue Backup: Export semua / Import. Data disimpan di server; file backup berisi
// setlist, lirik, nama & warna mixer, dan Target waktu. Import menimpa data dengan nama sama.

// Versi 2 menyimpan per band (data.bands); versi 1 (lama) satu set tanpa band.
function countBackup(data) {
  if (data && data.bands && typeof data.bands === "object") {
    let setlists = 0;
    let lyrics = 0;
    for (const b of Object.values(data.bands)) {
      setlists += Object.keys((b && b.setlists) || {}).length;
      lyrics += Object.keys((b && b.lyrics) || {}).length;
    }
    return { bands: Object.keys(data.bands).length, setlists, lyrics };
  }
  return { bands: 0, setlists: Object.keys((data && data.setlists) || {}).length, lyrics: Object.keys((data && data.lyrics) || {}).length };
}

export function initBackup({ send, toast }) {
  const root = document.getElementById("backup-root");
  if (!root) return { onMessage() {} };
  root.innerHTML =
    '<section class="card bk"><div class="card-head"><h2>Backup</h2></div>' +
    '<div class="bk-row">' +
    '<button type="button" id="bk-export"><i class="fa-solid fa-download"></i> Export semua</button>' +
    '<button type="button" id="bk-import"><i class="fa-solid fa-upload"></i> Import</button></div>' +
    '<input type="file" id="bk-file" accept="application/json,.json" hidden />' +
    '<div class="bk-confirm" id="bk-confirm" hidden><span id="bk-info"></span>' +
    '<span class="bk-btns"><button type="button" id="bk-go" class="primary">Timpa</button>' +
    '<button type="button" id="bk-cancel">Batal</button></span></div>' +
    '<p class="bk-note">Export menghasilkan satu file. Import mengembalikannya.</p></section>';

  const $ = (id) => document.getElementById(id);
  let pending = null;

  $("bk-export").onclick = () => send("exportBackup");
  $("bk-import").onclick = () => { $("bk-file").value = ""; $("bk-file").click(); };
  $("bk-cancel").onclick = () => { pending = null; $("bk-confirm").hidden = true; };
  $("bk-go").onclick = () => {
    if (!pending) return;
    send("importBackup", { data: pending });
    pending = null;
    $("bk-confirm").hidden = true;
  };
  $("bk-file").onchange = async () => {
    const f = $("bk-file").files && $("bk-file").files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (data && ["satsitset-backup","setlane-backup","setpilot-backup"].includes(data.app)) data.app = "setthecue-backup";
      if (!data || (data.app !== "setthecue-backup" && data.app !== "setpilot-backup" && data.app !== "setlane-backup")) throw new Error("bukan backup SetTheCue");
      const c = countBackup(data);
      const when = data.createdAt ? new Date(data.createdAt).toLocaleString() : "";
      const old = data.version === 1 ? " Backup lama: isinya masuk ke band yang sedang aktif." : "";
      pending = data;
      $("bk-info").textContent = (c.bands ? c.bands + " band, " : "") + c.setlists + " setlist, " + c.lyrics + " lirik" + (when ? " (" + when + ")" : "") + ". Timpa data dengan nama sama?" + old;
      $("bk-confirm").hidden = false;
    } catch (e) {
      toast("File backup tidak valid: " + e.message, true);
    }
  };

  return {
    onMessage(msg) {
      if (msg.type === "backup") {
        const d = msg.data || {};
        const blob = new Blob([JSON.stringify(d, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "setthecue-backup-" + new Date().toISOString().slice(0, 10) + ".json";
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        const c = countBackup(d);
        toast("Backup dibuat: " + c.bands + " band, " + c.setlists + " setlist, " + c.lyrics + " lirik");
      } else if (msg.type === "backupDone") {
        toast("Backup dikembalikan: " + msg.bands + " band, " + msg.setlists + " setlist, " + msg.lyrics + " lirik");
      }
    },
  };
}
