// Mixer channel names + colors, saved per band in <data dir>/bands/<band>/mixer-prefs.json.
// Keyed by the track's name in Ableton, so labels survive track re-ordering.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { bandDir } from "./bands.js";

const file = (band) => join(bandDir(band), "mixer-prefs.json");

export async function loadPrefs(band) {
  try {
    return JSON.parse(await readFile(file(band), "utf8"));
  } catch {
    return {};
  }
}

export async function savePrefs(prefs, band) {
  await mkdir(bandDir(band), { recursive: true });
  await writeFile(file(band), JSON.stringify(prefs, null, 2), "utf8");
}
