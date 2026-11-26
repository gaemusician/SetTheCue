// Profil band. Tiap band punya folder sendiri di <data dir>/bands/<Nama Band>/:
//   setlists/*.json   urutan lagu tersimpan
//   lyrics/*.txt      lirik (per band, jadi judul lagu yang sama tidak saling menimpa)
//   mixer-prefs.json  nama & warna channel mixer
//   timer-target.json Target waktu
//   band.json         setlist terakhir yang dipakai (dimuat otomatis saat band dipilih)
// Band yang sedang aktif diingat di <data dir>/active-band.json.

import { readFile, writeFile, readdir, mkdir, rename, copyFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { FIRST_BAND_NAME } from "../config.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MAX_BANDS = 50;

export function dataDir() {
  if (process.env.SETTHECUE_DATA_DIR) return process.env.SETTHECUE_DATA_DIR;
  const h = homedir();
  if (process.platform === "darwin") return join(h, "Library", "Application Support", "setthecue");
  if (process.platform === "win32") return join(process.env.APPDATA || join(h, "AppData", "Roaming"), "setthecue");
  return join(process.env.XDG_CONFIG_HOME || join(h, ".config"), "setthecue");
}
const bandsRoot = () => join(dataDir(), "bands");
const activeFile = () => join(dataDir(), "active-band.json");

let active = null;
export const activeBand = () => active;

export function safeBandName(name) {
  const s = String(name ?? "")
    .replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 60);
  if (!s) throw new Error("Nama band kosong");
  return s;
}

/** Folder sebuah band (default: band aktif). */
export function bandDir(name = active) {
  if (!name) throw new Error("Belum ada band aktif");
  return join(bandsRoot(), name);
}

export async function listBands() {
  try {
    const items = await readdir(bandsRoot(), { withFileTypes: true });
    return items
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  } catch {
    return [];
  }
}

// Cari nama band yang sudah ada tanpa membedakan huruf besar/kecil (macOS & Windows tidak membedakan).
async function findBand(name) {
  const want = safeBandName(name).toLowerCase();
  return (await listBands()).find((b) => b.toLowerCase() === want) || null;
}

export async function createBand(name) {
  const safe = safeBandName(name);
  if (await findBand(safe)) throw new Error(`Band “${safe}” sudah ada`);
  if ((await listBands()).length >= MAX_BANDS) throw new Error("Terlalu banyak band");
  await mkdir(join(bandDir(safe), "setlists"), { recursive: true });
  await mkdir(join(bandDir(safe), "lyrics"), { recursive: true });
  return safe;
}

/** Pastikan band ada (dipakai saat import backup). Mengembalikan nama yang tersimpan. */
export async function ensureBand(name) {
  return (await findBand(name)) || (await createBand(name));
}

export async function selectBand(name) {
  const found = await findBand(name);
  if (!found) throw new Error(`Band “${name}” tidak ditemukan`);
  active = found;
  await mkdir(dataDir(), { recursive: true });
  await writeFile(activeFile(), JSON.stringify({ name: found }, null, 2), "utf8");
  return found;
}

/** Hapus band = pindahkan ke bands/.dihapus/ (masih bisa dikembalikan manual). */
export async function deleteBand(name) {
  const found = await findBand(name);
  if (!found) throw new Error(`Band “${name}” tidak ditemukan`);
  if ((await listBands()).length <= 1) throw new Error("Tidak bisa menghapus satu-satunya band");
  if (found === active) throw new Error("Pindah ke band lain dulu");
  const trash = join(bandsRoot(), ".dihapus");
  await mkdir(trash, { recursive: true });
  await rename(bandDir(found), join(trash, `${found}-${new Date().toISOString().replace(/[:.]/g, "-")}`));
  return found;
}

// ---- data kecil per band ----------------------------------------------------

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}
async function writeJson(file, data) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data, null, 2), "utf8");
}

export async function getLastSetlist(band = active) {
  const s = await readJson(join(bandDir(band), "band.json"), {});
  return typeof s.lastSetlist === "string" ? s.lastSetlist : "";
}
export async function setLastSetlist(name, band = active) {
  const file = join(bandDir(band), "band.json");
  const s = await readJson(file, {});
  await writeJson(file, { ...s, lastSetlist: name || "" });
}

export async function loadTarget(band = active) {
  const t = await readJson(join(bandDir(band), "timer-target.json"), {});
  return Number(t.targetMs) > 0 ? Number(t.targetMs) : 0;
}
export async function saveTarget(ms, band = active) {
  await writeJson(join(bandDir(band), "timer-target.json"), { targetMs: Number(ms) > 0 ? Number(ms) : 0 });
}

// ---- deteksi band dari session Ableton --------------------------------------
// Petunjuknya nama lagu (locator) di session. Berlapis:
//  1. "learned": session ini pernah kamu pilihkan band-nya (dari pilihan manual, Save, atau Load).
//  2. "auto": hampir semua lagu session ada di SATU band saja (lagu dari setlist & lirik band).
//  3. "unsure"/"unknown": kandidat seri atau session baru. Band tidak diganti, kamu diminta memilih,
//     dan pilihanmu diingat untuk lain waktu. Judul kembar antar band tidak membuatnya salah tebak.

const MIN_SCORE = 0.6; // minimal porsi lagu session yang dikenal band itu
const MIN_MARGIN = 0.2; // jarak minimal dari band peringkat dua
const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

export function sessionSignature(names) {
  const list = [...new Set((names || []).map(norm).filter(Boolean))].sort();
  return list.length ? createHash("sha1").update(list.join("|")).digest("hex").slice(0, 16) : "";
}

async function bandSongSet(band) {
  const set = new Set();
  const dir = bandDir(band);
  try {
    for (const f of await readdir(join(dir, "setlists"))) {
      if (!f.endsWith(".json")) continue;
      const d = await readJson(join(dir, "setlists", f), {});
      for (const n of Array.isArray(d.order) ? d.order : []) set.add(norm(n));
    }
  } catch {}
  try {
    for (const f of await readdir(join(dir, "lyrics"))) if (f.endsWith(".txt")) set.add(norm(f.slice(0, -4)));
  } catch {}
  set.delete("");
  return set;
}

/** Ingat: session dengan tanda ini milik band ini (dan bukan milik band lain). */
export async function learnSession(sig, band = active) {
  if (!sig || !band) return;
  for (const b of await listBands()) {
    const file = join(bandDir(b), "band.json");
    const s = await readJson(file, {});
    const cur = Array.isArray(s.sessions) ? s.sessions : [];
    if (b === band) {
      if (!cur.includes(sig)) await writeJson(file, { ...s, sessions: [sig, ...cur].slice(0, 20) });
    } else if (cur.includes(sig)) {
      await writeJson(file, { ...s, sessions: cur.filter((x) => x !== sig) });
    }
  }
}

/** @returns {Promise<{state:"learned"|"auto"|"unsure"|"unknown"|"none", band?:string, score?:number}>} */
export async function detectBand(names) {
  const bands = await listBands();
  const sig = sessionSignature(names);
  if (!sig || bands.length === 0) return { state: "none" };
  for (const b of bands) {
    const s = await readJson(join(bandDir(b), "band.json"), {});
    if (Array.isArray(s.sessions) && s.sessions.includes(sig)) return { state: "learned", band: b };
  }
  const session = new Set(names.map(norm).filter(Boolean));
  const scores = [];
  for (const b of bands) {
    const songs = await bandSongSet(b);
    let hit = 0;
    for (const n of session) if (songs.has(n)) hit++;
    scores.push({ band: b, score: hit / session.size });
  }
  scores.sort((a, b) => b.score - a.score);
  const [top, second] = scores;
  if (top.score >= MIN_SCORE && top.score - (second ? second.score : 0) >= MIN_MARGIN) return { state: "auto", band: top.band, score: top.score };
  return { state: top.score > 0 ? "unsure" : "unknown" };
}

// ---- start: migrasi data lama + pilih band aktif ----------------------------

async function copyIfMissing(src, dst) {
  try {
    await readFile(dst);
    return; // sudah ada: jangan timpa
  } catch {}
  try {
    await mkdir(dirname(dst), { recursive: true });
    await copyFile(src, dst);
  } catch {
    /* sumber tidak ada */
  }
}

// Data lama (sebelum ada profil band) disalin ke band pertama. Aslinya TIDAK dihapus,
// jadi tetap ada sebagai cadangan di folder lama.
async function migrateLegacy(band) {
  const dir = bandDir(band);
  const old = dataDir();
  const setlistSources = [join(old, "setlists")];
  if (!process.env.SETTHECUE_DATA_DIR) setlistSources.push(join(HERE, "..", "..", "setlists")); // `npm start`
  for (const src of setlistSources) {
    try {
      for (const f of await readdir(src)) if (f.endsWith(".json")) await copyIfMissing(join(src, f), join(dir, "setlists", f));
    } catch {}
  }
  try {
    for (const f of await readdir(join(old, "lyrics"))) if (f.endsWith(".txt")) await copyIfMissing(join(old, "lyrics", f), join(dir, "lyrics", f));
  } catch {}
  await copyIfMissing(join(old, "mixer-prefs.json"), join(dir, "mixer-prefs.json"));
  const timer = await readJson(join(old, "stage-timer.json"), {});
  if (Number(timer.targetMs) > 0) await saveTarget(Number(timer.targetMs), band);
}

export async function initBands() {
  await mkdir(bandsRoot(), { recursive: true });
  if ((await listBands()).length === 0) {
    const first = await createBand(FIRST_BAND_NAME || "Band 1");
    await migrateLegacy(first);
  }
  const names = await listBands();
  const saved = (await readJson(activeFile(), {})).name;
  const pick = names.find((n) => n === saved) || names[0];
  await selectBand(pick);
  return pick;
}
