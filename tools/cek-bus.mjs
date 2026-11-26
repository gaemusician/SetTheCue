import { OscClient } from "../src/ableton/osc-client.js";

const osc = new OscClient();
osc.on("error", () => {});
const log = (...a) => console.log(a.join(" "));
const ask = async (label, addr, args = [], timeout = 2000) => {
  try {
    return await osc.request(addr, args, { timeout });
  } catch {
    log(`  ✗ tidak ada balasan: ${label} (${addr})`);
    return null;
  }
};
const finish = (code = 0) => { try { osc.close(); } catch {} process.exit(code); };

try {
  await osc.open();
} catch {
  log("❌ Port OSC tidak bisa dibuka. Tutup SetTheCue dulu (Cmd+Q), lalu jalankan lagi.");
  finish(1);
}

const tempo = await ask("tempo", "/live/song/get/tempo");
if (!tempo) { log("❌ Ableton / AbletonOSC tidak menjawab. Pastikan Ableton terbuka dan SetTheCue terpilih di Control Surface."); finish(1); }
log(`✓ Ableton menjawab. Tempo ${tempo[0]}`);

const met = await ask("metronom", "/live/song/get/metronome");
log(met ? `✓ Metronom terbaca: ${met[0]}` : "✗ Metronom tidak terbaca");

const namesReply = await ask("nama track", "/live/song/get/track_names", [], 4000);
const names = namesReply || [];
log(`✓ ${names.length} track (tidak termasuk Return/Master)`);

log("\nGroup Track yang ditemukan:");
const groups = [];
for (let i = 0; i < names.length; i++) {
  const f = await ask("is_foldable", "/live/track/get/is_foldable", [i], 1500);
  if (f && Boolean(f[1])) groups.push(i);
}
if (!groups.length) log("  (tidak ada track yang berupa Group)");

for (const i of groups) {
  const v = await ask("volume", "/live/track/get/volume", [i], 1500);
  const m = await ask("mute", "/live/track/get/mute", [i], 1500);
  const s = await ask("solo", "/live/track/get/solo", [i], 1500);
  const p = await ask("meter", "/live/track/get/output_meter_level", [i], 1500);
  log(`  #${i}  "${names[i]}"  volume=${v ? Number(v[1]).toFixed(4) : "?"}  mute=${m ? m[1] : "?"}  solo=${s ? s[1] : "?"}  meter=${p ? Number(p[1]).toFixed(3) : "?"}`);
}

if (groups.length) {
  log("\nUji listener (12 detik): geser satu fader group, tekan M atau S, dan nyalakan/matikan metronom di Ableton sekarang.");
  const seen = new Set();
  osc.on("message", (m) => {
    const a = m.address;
    if (/^\/live\/track\/get\/(volume|mute|solo)$/.test(a) && groups.includes(Number(m.args[0]))) {
      const key = `${a}|${m.args[0]}|${m.args[1]}`;
      if (!seen.has(key)) { seen.add(key); log(`  ↳ ${a.split("/").pop()} track #${m.args[0]} = ${m.args[1]}`); }
    } else if (a === "/live/song/get/metronome") {
      log(`  ↳ metronom = ${m.args[0]}`);
    }
  });
  for (const i of groups) for (const prop of ["volume", "mute", "solo"]) osc.send(`/live/track/start_listen/${prop}`, { type: "i", value: i });
  osc.send("/live/song/start_listen/metronome");
  await new Promise((r) => setTimeout(r, 12000));
  for (const i of groups) for (const prop of ["volume", "mute", "solo"]) osc.send(`/live/track/stop_listen/${prop}`, { type: "i", value: i });
  osc.send("/live/song/stop_listen/metronome");
  log(seen.size ? "✓ Listener bekerja." : "✗ Tidak ada perubahan yang tertangkap (geser fader / tekan M saat uji berjalan, atau listener tidak didukung).");
}

log("\nSelesai.");
finish(0);
