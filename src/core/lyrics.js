// Lyrics storage — one plain-text file per song in <data dir>/bands/<band>/lyrics/<song>.txt.
// Line format:  [9] sung text   (bar 9, counted from the song's locator; bar 1 = start)
// Lines without [n] are kept as-is (blank lines = spacing). Editable in any text editor.

import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { bandDir } from "./bands.js";

const lyricsDir = (band) => join(bandDir(band), "lyrics");

export function safeName(name) {
  const s = String(name ?? "")
    .replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 120);
  if (!s) throw new Error("Nama lagu kosong");
  return s;
}
const fileFor = (name, band) => join(lyricsDir(band), `${safeName(name)}.txt`);

export async function getLyrics(name, band) {
  try {
    return await readFile(fileFor(name, band), "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return "";
    throw e;
  }
}

export async function putLyrics(name, text, band) {
  await mkdir(lyricsDir(band), { recursive: true });
  await writeFile(fileFor(name, band), String(text ?? ""), "utf8");
}

export async function listLyrics(band) {
  try {
    return (await readdir(lyricsDir(band)))
      .filter((f) => f.endsWith(".txt"))
      .map((f) => f.slice(0, -4))
      .sort();
  } catch {
    return [];
  }
}
