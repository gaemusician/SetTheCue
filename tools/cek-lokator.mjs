import { OscClient } from "../src/ableton/osc-client.js";

const osc = new OscClient();
osc.on("error", () => {});
const log = (...a) => console.log(a.join(" "));
const finish = (code = 0) => { try { osc.close(); } catch {} process.exit(code); };

try {
  await osc.open();
} catch {
  log("❌ Port OSC tidak bisa dibuka. Tutup SetTheCue dulu (Cmd+Q), lalu jalankan lagi.");
  finish(1);
}

let flat;
try {
  flat = await osc.request("/live/song/get/cue_points", [], { timeout: 4000 });
} catch {
  log("❌ Ableton / AbletonOSC tidak menjawab.");
  finish(1);
}
let tempo = null;
try { tempo = (await osc.request("/live/song/get/tempo", [], { timeout: 2000 }))[0]; } catch {}

const cues = [];
for (let i = 0; i + 1 < flat.length; i += 2) {
  const a = flat[i], b = flat[i + 1];
  if (typeof a === "string") cues.push({ name: a, beat: Number(b) });
  else cues.push({ name: String(b), beat: Number(a) });
}
cues.sort((x, y) => x.beat - y.beat);

log(`Tempo sekarang: ${tempo}  |  ${cues.length} locator`);
log("");
log("urutan | beat      | bar (beat/4+1) | nama");
cues.forEach((c, i) => {
  log(`${String(i + 1).padStart(6)} | ${c.beat.toFixed(2).padStart(9)} | ${(c.beat / 4 + 1).toFixed(2).padStart(14)} | ${c.name}`);
});
log("");
log("Selesai.");
finish(0);
