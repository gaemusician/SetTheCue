// Backup: satu file JSON berisi semua band. Tiap band: setlist, lirik, nama & warna mixer, Target waktu.
// Versi 2 = per band. Backup versi 1 (sebelum ada band) tetap bisa di-import: isinya masuk ke band aktif.
import { listSetlists, readSetlistRaw, writeSetlistRaw } from "./store.js";
import { listLyrics, getLyrics, putLyrics } from "./lyrics.js";
import { loadPrefs, savePrefs } from "./mixer-prefs.js";
import { listBands, ensureBand, activeBand, loadTarget, saveTarget, safeBandName } from "./bands.js";

export const BACKUP_APP = "setthecue-backup";
const MAX_ITEMS = 500;
const MAX_BANDS = 50;
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

async function exportBand(band) {
  const setlists = {};
  for (const name of await listSetlists(band)) {
    try {
      setlists[name] = await readSetlistRaw(name, band);
    } catch {
      /* file rusak: dilewati */
    }
  }
  const lyrics = {};
  for (const name of await listLyrics(band)) lyrics[name] = await getLyrics(name, band);
  return { setlists, lyrics, mixer: await loadPrefs(band), timerTargetMs: await loadTarget(band) };
}

export async function exportAll() {
  const bands = {};
  for (const band of await listBands()) bands[band] = await exportBand(band);
  return { app: BACKUP_APP, version: 2, createdAt: new Date().toISOString(), activeBand: activeBand(), bands };
}

async function importBand(band, d) {
  const setlists = isObj(d.setlists) ? d.setlists : {};
  const lyrics = isObj(d.lyrics) ? d.lyrics : {};
  if (Object.keys(setlists).length > MAX_ITEMS || Object.keys(lyrics).length > MAX_ITEMS) throw new Error("Backup terlalu besar");
  let nSet = 0;
  let nLyr = 0;
  for (const [name, s] of Object.entries(setlists)) {
    if (!isObj(s) || !Array.isArray(s.order) || !s.order.every((x) => typeof x === "string")) continue;
    await writeSetlistRaw(
      name,
      { name: typeof s.name === "string" ? s.name : name, savedAt: s.savedAt || new Date().toISOString(), order: s.order },
      band,
    );
    nSet++;
  }
  for (const [name, text] of Object.entries(lyrics)) {
    if (typeof text !== "string") continue;
    try {
      await putLyrics(name, text, band);
      nLyr++;
    } catch {
      /* nama tidak valid: dilewati */
    }
  }
  if (isObj(d.mixer)) await savePrefs(d.mixer, band);
  if (Number(d.timerTargetMs) > 0) await saveTarget(Number(d.timerTargetMs), band);
  return { nSet, nLyr };
}

// Data dengan nama yang sama ditimpa; data lain yang sudah ada dibiarkan.
// Semua ditulis ke disk; pemanggil memuat ulang mixer & Target waktu band aktif dari disk.
export async function importAll(data) {
  if (isObj(data) && ["satsitset-backup","setlane-backup","setpilot-backup"].includes(data.app)) data = { ...data, app: BACKUP_APP };
  if (!isObj(data) || (data.app !== BACKUP_APP && data.app !== "setpilot-backup" && data.app !== "setlane-backup")) throw new Error("Ini bukan file backup SetTheCue");
  let setlists = 0;
  let lyrics = 0;
  let bands = 0;
  if (data.version === 1) {
    const r = await importBand(activeBand(), data);
    setlists = r.nSet;
    lyrics = r.nLyr;
    bands = 1;
  } else if (data.version === 2) {
    const entries = Object.entries(isObj(data.bands) ? data.bands : {});
    if (entries.length > MAX_BANDS) throw new Error("Backup terlalu besar");
    for (const [rawName, d] of entries) {
      if (!isObj(d)) continue;
      let name;
      try {
        name = await ensureBand(safeBandName(rawName));
      } catch {
        continue; // nama band tidak valid: dilewati
      }
      const r = await importBand(name, d);
      setlists += r.nSet;
      lyrics += r.nLyr;
      bands++;
    }
  } else {
    throw new Error("Versi backup tidak dikenal");
  }
  return { bands, setlists, lyrics };
}
