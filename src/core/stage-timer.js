// Stage timer: how long we have been on stage. Wall-clock based (independent of Ableton's
// transport), shared by every connected window/device, and saved to the SetTheCue data folder
// so it keeps counting if the app is closed and reopened mid-show.

import { EventEmitter } from "node:events";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const STALE_MS = 12 * 60 * 60 * 1000; // a timer left running for 12h+ is from another day: start fresh

function dataDir() {
  if (process.env.SETTHECUE_DATA_DIR) return process.env.SETTHECUE_DATA_DIR;
  const h = homedir();
  if (process.platform === "darwin") return join(h, "Library", "Application Support", "setthecue");
  if (process.platform === "win32") return join(process.env.APPDATA || join(h, "AppData", "Roaming"), "setthecue");
  return join(process.env.XDG_CONFIG_HOME || join(h, ".config"), "setthecue");
}
const file = () => join(dataDir(), "stage-timer.json");

export class StageTimer extends EventEmitter {
  constructor() {
    super();
    this.running = false;
    this.startedAt = 0; // epoch ms of the current run segment
    this.accMs = 0; // time banked from earlier segments (before the last pause)
    this.targetMs = 0; // Target waktu (0 = belum diatur)
  }

  async load() {
    try {
      const s = JSON.parse(await readFile(file(), "utf8"));
      this.running = Boolean(s.running);
      this.startedAt = Number(s.startedAt) || 0;
      this.accMs = Number(s.accMs) || 0;
      this.targetMs = Number(s.targetMs) || 0;
      if (this.running && Date.now() - this.startedAt > STALE_MS) {
        this.running = false;
        this.startedAt = 0;
        this.accMs = 0;
      }
    } catch {
      /* no saved timer */
    }
    this.emit("state", this.snapshot());
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.startedAt = Date.now();
    this._changed();
  }
  pause() {
    if (!this.running) return;
    this.accMs += Date.now() - this.startedAt;
    this.running = false;
    this.startedAt = 0;
    this._changed();
  }
  reset() {
    this.running = false;
    this.startedAt = 0;
    this.accMs = 0;
    this._changed();
  }

  setTarget(ms) {
    const v = Math.round(Number(ms));
    this.targetMs = Number.isFinite(v) && v > 0 ? Math.min(v, 24 * 3600 * 1000) : 0;
    this._changed();
  }

  elapsedMs() {
    return this.accMs + (this.running ? Math.max(0, Date.now() - this.startedAt) : 0);
  }

  // serverNow lets every client correct for its own clock being a little off
  snapshot() {
    return { running: this.running, startedAt: this.startedAt, accMs: this.accMs, targetMs: this.targetMs, serverNow: Date.now() };
  }

  _changed() {
    this.emit("state", this.snapshot());
    this._save().catch(() => {});
  }
  async _save() {
    await mkdir(dataDir(), { recursive: true });
    await writeFile(file(), JSON.stringify({ running: this.running, startedAt: this.startedAt, accMs: this.accMs, targetMs: this.targetMs }), "utf8");
  }
}
