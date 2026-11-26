// SetTheCue server — serves the web remote and bridges it to the engine.
// One engine drives Ableton; every connected browser (the app window, phones,
// tablets) is a thin client that renders state snapshots and sends commands over
// WebSocket, so any device on the LAN becomes a remote.

import http from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname, extname, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { networkInterfaces } from "node:os";
import { WebSocketServer } from "ws";
import QRCode from "qrcode";

import { APP_NAME } from "./config.js";
import { AbletonAdapter } from "./ableton/ableton-adapter.js";
import { SetlistEngine } from "./core/engine.js";
import { saveSetlist, loadSetlist, listSetlists, deleteSetlist } from "./core/store.js";
import { getLyrics, putLyrics, listLyrics } from "./core/lyrics.js";
import { Mixer } from "./core/mixer.js";
import { StageTimer } from "./core/stage-timer.js";
import { loadPrefs, savePrefs } from "./core/mixer-prefs.js";
import { initBands, activeBand, listBands, createBand, selectBand, deleteBand, getLastSetlist, setLastSetlist, loadTarget, saveTarget, detectBand, learnSession, sessionSignature } from "./core/bands.js";
import { exportAll, importAll } from "./core/backup.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, "..", "public");
const PORT = Number(process.env.PORT) || 4747;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
};

// --- Ableton + engine -------------------------------------------------------

const adapter = new AbletonAdapter();
const engine = new SetlistEngine(adapter);
const mixer = new Mixer(adapter.osc);
const stageTimer = new StageTimer();
stageTimer.on("state", (state) => broadcast({ type: "timer", state }));
let prefsTimer;
mixer.on("prefs", (p) => {
  clearTimeout(prefsTimer);
  const band = activeBand(); // simpan ke band yang aktif SAAT diubah, walau band diganti sebelum 300 ms
  prefsTimer = setTimeout(() => savePrefs(p, band).catch((e) => console.error("Mixer prefs:", e.message)), 300);
});

// --- Profil band ------------------------------------------------------------
// Setlist, lirik, mixer, dan Target waktu dimuat dari band yang aktif.

// Status deteksi band untuk ditampilkan di app: auto | learned | unsure | unknown | manual | none
let lastDetect = { state: "none" };
let lastSessionSig = null; // tanda session Ableton yang terakhir diperiksa

const bandsMsg = async () => ({ type: "bands", names: await listBands(), active: activeBand(), detect: lastDetect });

const sessionNames = () => engine.songs.map((s) => s.name);

// Ingat: session Ableton yang sedang terbuka ini milik band aktif (dipanggil saat kamu memilih band, Save, atau Load).
async function rememberSession() {
  if (!engine.songs.length) return;
  await learnSession(sessionSignature(sessionNames())).catch(() => {});
  if (lastDetect.state === "unsure" || lastDetect.state === "unknown") {
    lastDetect = { state: "manual" };
    broadcast(await bandsMsg());
  }
}

// Saat Ableton terhubung dengan session BARU: tebak bandnya dari lagu-lagu session.
// Sambung ulang ke session yang sama tidak mengganti band (supaya pilihan manual tidak ditimpa di tengah show).
async function autoDetectBand() {
  if (engine.status !== "idle" || !engine.songs.length) return;
  const sig = sessionSignature(sessionNames());
  if (sig === lastSessionSig) return;
  lastSessionSig = sig;
  if ((await listBands()).length < 2) {
    lastDetect = { state: "none" };
    return;
  }
  const r = await detectBand(sessionNames());
  lastDetect = { state: r.state, ...(r.band ? { band: r.band } : {}) };
  if (r.band && r.band !== activeBand()) {
    await selectBand(r.band);
    await applyBandData();
    broadcast({ type: "setlists", names: await listSetlists() });
    broadcast({ type: "lyricsList", names: await listLyrics() });
    broadcast({ type: "bandChanged", name: activeBand(), auto: true });
    console.log(`🎸 Band terdeteksi dari session: ${activeBand()}`);
  }
  broadcast(await bandsMsg());
}

async function applyBandData() {
  mixer.loadPrefs(await loadPrefs());
  stageTimer.setTarget(await loadTarget());
}

// Pasang setlist band aktif: setlist terakhir yang dipakai, atau urutan locator kalau belum ada.
async function applyBandSetlist() {
  if (!engine.songs.length) return; // Ableton belum terhubung; diterapkan saat terhubung
  let resolved = null;
  let missing = [];
  const last = await getLastSetlist();
  if (last) {
    try {
      ({ resolved, missing } = await loadSetlist(last, engine.songs));
    } catch {
      resolved = null; // file setlist hilang / rusak
    }
  }
  if (resolved) {
    engine.setOrder(resolved.map((s) => s.index));
    engine.setMissing(missing);
    if (missing.length) broadcast({ type: "warning", message: `Missing in Live: ${missing.join(", ")}` });
  } else {
    engine.setOrder([...engine.songs].sort((a, b) => a.timeBeats - b.timeBeats).map((s) => s.index));
  }
}

async function switchBand(ws, name, byUser = false) {
  if (engine.status !== "idle") {
    ws.send(JSON.stringify({ type: "warning", message: "Hentikan lagu dulu sebelum ganti band" }));
    ws.send(JSON.stringify(await bandsMsg()));
    return;
  }
  const before = activeBand();
  const now = await selectBand(name);
  if (byUser) {
    lastDetect = { state: "manual" };
    await rememberSession(); // pilihanmu = jawaban untuk session ini
  }
  if (now !== before) {
    await applyBandData();
    await applyBandSetlist();
    broadcast({ type: "setlists", names: await listSetlists() });
    broadcast({ type: "lyricsList", names: await listLyrics() });
    broadcast({ type: "bandChanged", name: now });
    console.log(`🎸 Band: ${now}`);
  }
  broadcast(await bandsMsg());
}
let abletonConnected = false;
let remoteEnabled = false; // LAN remote off by default; turned on from the app

// localhost (the Electron app itself) is always allowed; LAN clients only when on.
function isLocal(req) {
  const a = (req.socket && req.socket.remoteAddress) || "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}
function lanUrls() {
  return lanAddresses().map((ip) => `http://${ip}:${PORT}`);
}
// LAN URLs plus an SVG QR code for the first one, so a phone can just scan it.
async function remoteInfo() {
  const urls = lanUrls();
  let qr = null;
  if (urls[0]) {
    try {
      qr = await QRCode.toString(urls[0], { type: "svg", margin: 1, errorCorrectionLevel: "M" });
    } catch (e) {
      console.error("QR failed:", e.message);
    }
  }
  return { lanUrls: urls, qr };
}

adapter.osc.on("error", (e) => console.error("OSC error:", e.message));

const HEARTBEAT_MS = 1500; // how often we ping Live
const MISS_LIMIT = 2; // consecutive missed pings before we call it disconnected
const REOPEN_EVERY = 10; // after this many misses (~15s), reopen the OSC socket

let lastSig = null;
let refreshing = false; // reentrancy guard — never let pings overlap
let missCount = 0; // consecutive failed pings

// A fingerprint of the current locators (+ tempo); changes when songs are
// added, removed, renamed, or moved in Live.
function songSig(songs, tempo) {
  return (
    `${tempo}|` +
    songs
      .map((s) => {
        const secs = (s.sections || [])
          .map((x) => `${x.index}@${x.timeBeats}:${x.name}${x.loop ? "L" : ""}`)
          .join("/");
        const flags = `${s.continueAtEnd ? "C" : ""}${s.loop ? "L" : ""}`;
        return `${s.index}:${s.name}:${s.timeBeats}${flags}[${secs}]`;
      })
      .join(",")
  );
}

// Heartbeat + reconnect watchdog. A slow ping can outlast the interval, so we
// guard against overlap; a couple of misses are tolerated before we declare a
// disconnect (avoids flapping on a single dropped UDP reply).
async function refreshAbleton() {
  if (refreshing) return;
  refreshing = true;
  try {
    const { tempo } = await adapter.ping();
    missCount = 0;

    if (!abletonConnected) {
      abletonConnected = true;
      await engine.load(); // full read when Live (re)appears
      lastSig = songSig(engine.songs, engine.tempo);
      await autoDetectBand(); // session baru? pilih band yang cocok
      await applyBandSetlist(); // setlist terakhir band aktif (atau urutan locator)
      engine.startFollow(); // mirror Play/Stop/locator jumps made in Live
      mixer.start().catch((e) => console.error("Mixer:", e.message));
      console.log(`🎚  Ableton connected — ${engine.songs.length} song(s).`);
      broadcastConnection();
      return;
    }
    // Connected: detect locators changed on the fly and push the update.
    const songs = await adapter.getSongs();
    const sig = songSig(songs, tempo);
    if (sig !== lastSig) {
      lastSig = sig;
      engine.applySongs(songs, tempo); // preserves the set list; broadcasts state
      console.log(`🔄 Locators updated — ${songs.length} song(s).`);
    }
  } catch {
    missCount++;
    if (abletonConnected && missCount >= MISS_LIMIT) {
      abletonConnected = false;
      lastSig = null;
      engine.stopFollow();
      mixer.stop();
      engine.onDisconnected(); // don't leave the UI stuck "playing"
      console.log("⚠️  Lost Ableton connection — retrying…");
      broadcastConnection();
    }
    // Sustained failure may mean a wedged socket (sleep/wake, interface change).
    if (missCount % REOPEN_EVERY === 0) {
      try {
        await adapter.reconnect();
        console.log("🔌 Reopened OSC socket.");
      } catch (e) {
        console.error("OSC reopen failed:", e.message);
      }
    }
  } finally {
    refreshing = false;
  }
}

// --- HTTP static server -----------------------------------------------------

const server = http.createServer(async (req, res) => {
  if (!remoteEnabled && !isLocal(req)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("SetTheCue remote is off. Turn it on in the app to connect from this device.");
    return;
  }
  let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  // prevent path traversal
  const filePath = normalize(join(PUBLIC, urlPath));
  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const body = await readFile(filePath);
    res.writeHead(200, { "Content-Type": MIME[extname(filePath)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("Not found");
  }
});

// --- WebSocket bridge -------------------------------------------------------

const wss = new WebSocketServer({ server });

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(data);
  }
}
function broadcastConnection() {
  broadcast({ type: "connection", abletonConnected });
}

engine.on("state", (snapshot) => broadcast({ type: "state", snapshot }));
mixer.on("state", (state) => broadcast({ type: "mixer", state }));

// Throttle progress ticks so we don't flood clients (~10/s is plenty for reels).
let lastTick = 0;
engine.on("tick", ({ beat, endBeat, song }) => {
  const now = Date.now();
  if (now - lastTick < 100) return;
  lastTick = now;
  const span = endBeat - song.timeBeats;
  const progress = span > 0 ? Math.min(1, Math.max(0, (beat - song.timeBeats) / span)) : 0;
  // Progress is disposable: if a client (a phone on weak Wi-Fi) still has unsent data queued,
  // skip it instead of piling up — otherwise its lyrics fall further and further behind.
  const data = JSON.stringify({ type: "progress", progress, beat, songStart: song.timeBeats });
  for (const client of wss.clients) {
    if (client.readyState === 1 && client.bufferedAmount < 16384) client.send(data);
  }
});

async function handleCommand(ws, msg) {
  const { action, payload } = msg;
  switch (action) {
    case "play": engine.play(); break;
    case "playPos": engine.playPos(payload.pos); break;
    case "playSection": engine.playSection(payload.atBeats); break;
    case "releaseLoop": engine.releaseLoop(); break;
    case "stop": engine.stop(); break;
    case "pause": await engine.pause(); break;
    case "resume": engine.resume(); break;
    case "next": engine.goNext(); break;
    case "prev": engine.goPrev(); break;
    case "panic": engine.panic(); break;
    case "setOrder": engine.setOrder(payload.cueIndices); break;
    case "reload":
      if (abletonConnected) {
        await engine.load();
        lastSig = songSig(engine.songs, engine.tempo);
      }
      break;
    case "save":
      await saveSetlist(payload.name, engine.setlist);
      await setLastSetlist(payload.name);
      await rememberSession();
      ws.send(JSON.stringify({ type: "setlists", names: await listSetlists() }));
      break;
    case "load": {
      const { resolved, missing } = await loadSetlist(payload.name, engine.songs);
      engine.setOrder(resolved.map((s) => s.index));
      engine.setMissing(missing);
      await setLastSetlist(payload.name);
      await rememberSession();
      if (missing.length) ws.send(JSON.stringify({ type: "warning", message: `Missing in Live: ${missing.join(", ")}` }));
      break;
    }
    case "listBands":
      ws.send(JSON.stringify(await bandsMsg()));
      break;
    case "selectBand":
      await switchBand(ws, payload.name, true);
      break;
    case "createBand": {
      if (engine.status !== "idle") {
        ws.send(JSON.stringify({ type: "warning", message: "Hentikan lagu dulu sebelum ganti band" }));
        break;
      }
      const name = await createBand(payload.name);
      await switchBand(ws, name, true);
      break;
    }
    case "deleteBand": {
      const names = await listBands();
      const target = names.find((n) => n.toLowerCase() === String(payload.name).toLowerCase());
      if (target && target === activeBand()) {
        const other = names.find((n) => n !== target);
        if (!other) throw new Error("Tidak bisa menghapus satu-satunya band");
        await switchBand(ws, other);
        if (activeBand() !== other) break; // gagal pindah (mis. lagu sedang jalan): jangan hapus
      }
      await deleteBand(payload.name);
      broadcast(await bandsMsg());
      break;
    }
    case "deleteSetlist":
      await deleteSetlist(payload.name);
      broadcast({ type: "setlists", names: await listSetlists() });
      break;
    case "listSetlists":
      ws.send(JSON.stringify({ type: "setlists", names: await listSetlists() }));
      break;
    case "mixVolume":
      if (!mixer.setVolume(payload.id, payload.value) && mixer.locked) ws.send(JSON.stringify({ type: "warning", message: "Mix terkunci" }));
      break;
    case "mixMute":
      if (!mixer.setMute(payload.id, payload.on) && mixer.locked) ws.send(JSON.stringify({ type: "warning", message: "Mix terkunci" }));
      break;
    case "mixSolo":
      if (!mixer.setSolo(payload.id, payload.on) && mixer.locked) ws.send(JSON.stringify({ type: "warning", message: "Mix terkunci" }));
      break;
    case "mixMetronome":
      mixer.setMetronome(payload.on);
      break;
    case "mixLock":
      mixer.setLocked(payload.on);
      break;
    case "mixStyle":
      mixer.setStyle(payload.id, payload);
      break;
    case "timerStart":
      stageTimer.start();
      break;
    case "timerPause":
      stageTimer.pause();
      break;
    case "timerReset":
      stageTimer.reset();
      break;
    case "timerTarget":
      stageTimer.setTarget(payload.ms);
      await saveTarget(stageTimer.targetMs).catch(() => {});
      break;
    case "exportBackup":
      ws.send(JSON.stringify({ type: "backup", data: await exportAll() }));
      break;
    case "importBackup": {
      const r = await importAll(payload.data);
      await applyBandData(); // mixer & Target waktu band aktif, kalau ikut diimpor
      broadcast(await bandsMsg());
      broadcast({ type: "setlists", names: await listSetlists() });
      broadcast({ type: "lyricsList", names: await listLyrics() });
      broadcast({ type: "bandChanged", name: activeBand() });
      ws.send(JSON.stringify({ type: "backupDone", bands: r.bands, setlists: r.setlists, lyrics: r.lyrics }));
      break;
    }
    case "mixReset":
      if (!mixer.reset() && mixer.locked) ws.send(JSON.stringify({ type: "warning", message: "Mix terkunci" }));
      break;
    case "getLyrics":
      ws.send(JSON.stringify({ type: "lyrics", name: payload.name, text: await getLyrics(payload.name) }));
      break;
    case "saveLyrics":
      await putLyrics(payload.name, payload.text);
      broadcast({ type: "lyrics", name: payload.name, text: await getLyrics(payload.name) });
      broadcast({ type: "lyricsList", names: await listLyrics() });
      break;
    case "listLyrics":
      ws.send(JSON.stringify({ type: "lyricsList", names: await listLyrics() }));
      break;
    case "setRemote":
      remoteEnabled = Boolean(payload.on);
      if (!remoteEnabled) {
        for (const client of wss.clients) if (client._isLocal === false) client.close();
      }
      broadcast({ type: "remote", enabled: remoteEnabled, ...(await remoteInfo()) });
      console.log(remoteEnabled ? "📡 Remote enabled" : "📴 Remote disabled");
      break;
    default:
      ws.send(JSON.stringify({ type: "error", message: `Unknown action: ${action}` }));
  }
}

wss.on("connection", async (ws, req) => {
  if (!remoteEnabled && !isLocal(req)) {
    ws.close();
    return;
  }
  ws._isLocal = isLocal(req);
  req.socket.setNoDelay?.(true); // send small packets immediately (lower latency)
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; }); // browser auto-pongs at protocol level
  ws.send(JSON.stringify({
    type: "hello",
    abletonConnected,
    remoteEnabled,
    ...(await remoteInfo()),
    snapshot: engine.snapshot(),
    mixer: mixer.snapshot(),
    timer: stageTimer.snapshot(),
    setlists: await listSetlists(),
    bands: await bandsMsg(),
  }));
  ws.on("message", async (raw) => {
    try {
      await handleCommand(ws, JSON.parse(raw.toString()));
    } catch (err) {
      ws.send(JSON.stringify({ type: "error", message: err.message }));
    }
  });
});

// Prune dead client sockets (a tablet that slept or dropped off Wi-Fi). The
// client reconnects on its own; this just stops us broadcasting into the void.
const wsHeartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);
wss.on("close", () => clearInterval(wsHeartbeat));

// --- Boot -------------------------------------------------------------------

function lanAddresses() {
  const out = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === "IPv4" && !a.internal) out.push(a.address);
    }
  }
  return out;
}

export async function startServer() {
  await stageTimer.load().catch(() => {});
  await initBands(); // migrasi data lama (sekali) + pilih band aktif
  await applyBandData().catch((e) => console.error("Band data:", e.message));
  await adapter.connect();
  await refreshAbleton();
  setInterval(refreshAbleton, HEARTBEAT_MS); // heartbeat + reconnect + locator watchdog

  await new Promise((resolve) => {
    server.listen(PORT, () => {
      console.log(`\n🎛  ${APP_NAME} is running.\n`);
      console.log(`   This device:  http://localhost:${PORT}`);
      console.log(`   Phone/tablet remote: OFF (turn it on in the app to allow LAN devices)`);
      console.log(`\n   ${abletonConnected ? "✅ Ableton connected" : "⚠️  Waiting for Ableton + AbletonOSC…"}\n`);
      resolve();
    });
  });
  return { port: PORT, url: `http://localhost:${PORT}` };
}

// Run directly with `npm start`, but stay quiet when imported (e.g. by Electron).
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  startServer().catch((err) => {
    console.error("Failed to start:", err.message);
    process.exit(1);
  });
}
