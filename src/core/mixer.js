// SetTheCue mixer — bridges Ableton Group Tracks (buses) to the UI, in both directions.
// Reads volume/mute/solo from Live on connect, listens for changes made in Live, and
// sends changes made in SetTheCue. A short "suppress" window after each send stops
// Live's echo of our own value from making a fader jump back while it is dragged.
// Replies are matched by address AND track id, so listener traffic is never mistaken
// for the answer to a query.

import { EventEmitter } from "node:events";

const POLL_MS = 8000; // safety-net re-read (listeners do the real work)
const SUPPRESS_MS = 400; // ignore Live's echo of a value we just sent
const METER_MS = 300; // signal-LED poll
const LED_ON = 0.01; // meter level that counts as "signal present"
const LED_HOLD_MS = 300; // keep the LED lit this long after the last signal
const RETRY_MS = 5000;
const PROPS = ["volume", "mute", "solo"];
const int = (n) => ({ type: "i", value: n });

export class Mixer extends EventEmitter {
  /** @param {import("../ableton/osc-client.js").OscClient} osc */
  constructor(osc) {
    super();
    this.osc = osc;
    this.groups = [];
    this.metronome = false;
    this.locked = false;
    this.connected = false;
    this._wanted = false;
    this._starting = false;
    this._gen = 0;
    this._byId = new Map();
    this._initial = new Map();
    this._suppress = new Map();
    this._metSuppress = 0;
    this._namesSig = "";
    this._timers = [];
    this._emitTimer = null;
    this._metering = false;
    this._retry = null;
    this._onMsg = (m) => this._handle(m);
    this.prefs = {}; // by Ableton track name -> { label, color }
  }

  // ---- lifecycle ----------------------------------------------------------

  async start() {
    this._wanted = true;
    if (this.connected || this._starting) return;
    this._starting = true;
    const gen = ++this._gen;
    this.osc.on("message", this._onMsg);
    try {
      await this._build(gen);
      if (gen !== this._gen) return;
      this.connected = true;
      this._timers.push(setInterval(() => this._poll().catch(() => {}), POLL_MS));
      this._timers.push(setInterval(() => this._meters().catch(() => {}), METER_MS));
      this._timers.push(setInterval(() => this._ledDecay(), 100));
      this._schedule();
    } catch (e) {
      this._teardown();
      if (this._wanted) this._retry = setTimeout(() => this.start().catch(() => {}), RETRY_MS);
      throw e;
    } finally {
      this._starting = false;
    }
  }

  stop() {
    this._wanted = false;
    clearTimeout(this._retry);
    this._teardown();
    this.emit("state", this.snapshot());
  }

  _teardown() {
    this._gen++;
    for (const t of this._timers) clearInterval(t);
    this._timers = [];
    this.osc.off("message", this._onMsg);
    this._unlisten();
    this.groups = [];
    this._byId.clear();
    this._initial.clear();
    this._suppress.clear();
    this.connected = false;
  }

  _unlisten() {
    try {
      for (const g of this.groups) for (const p of PROPS) this.osc.send(`/live/track/stop_listen/${p}`, int(g.id));
      this.osc.send("/live/song/stop_listen/metronome");
    } catch {
      /* socket may be gone */
    }
  }

  // ---- reading ------------------------------------------------------------

  _ask(address, args, match = () => true, timeout = 1500) {
    return new Promise((resolve, reject) => {
      const on = (m) => {
        if (m.address === address && match(m.args)) done(resolve, m.args);
      };
      const done = (fn, v) => {
        clearTimeout(timer);
        this.osc.off("message", on);
        fn(v);
      };
      const timer = setTimeout(() => done(reject, new Error(`timeout ${address}`)), timeout);
      this.osc.on("message", on);
      this.osc.send(address, ...args);
    });
  }

  async _readGroup(g) {
    for (const p of PROPS) {
      const r = await this._ask(`/live/track/get/${p}`, [g.id], (a) => Number(a[0]) === g.id);
      this._apply(g, p, r[1]);
    }
  }

  async _build(gen) {
    const names = await this._ask("/live/song/get/track_names", [], () => true, 4000);
    this._namesSig = names.join("|");
    const groups = [];
    for (let i = 0; i < names.length; i++) {
      if (gen !== this._gen) return;
      const f = await this._ask("/live/track/get/is_foldable", [i], (a) => Number(a[0]) === i);
      if (Boolean(f[1])) {
        groups.push({ id: i, name: String(names[i]), volume: 0.85, mute: false, solo: false, signal: false, _loud: 0 });
      }
    }
    this._unlisten();
    this.groups = groups;
    this._byId = new Map(groups.map((g) => [g.id, g]));
    this._suppress.clear();
    for (const g of groups) await this._readGroup(g);
    this._initial = new Map(groups.map((g) => [g.id, { volume: g.volume, mute: g.mute, solo: g.solo }]));
    try {
      const met = await this._ask("/live/song/get/metronome", []);
      this.metronome = Boolean(met[0]);
    } catch {
      /* optional */
    }
    for (const g of groups) for (const p of PROPS) this.osc.send(`/live/track/start_listen/${p}`, int(g.id));
    this.osc.send("/live/song/start_listen/metronome");
    this._schedule();
  }

  async _poll() {
    if (!this.connected) return;
    const gen = this._gen;
    const names = await this._ask("/live/song/get/track_names", [], () => true, 3000);
    if (names.join("|") !== this._namesSig) {
      await this._build(gen); // tracks added / renamed / removed in Live
      return;
    }
    for (const g of this.groups) await this._readGroup(g);
    const met = await this._ask("/live/song/get/metronome", []);
    if (Date.now() >= this._metSuppress) this.metronome = Boolean(met[0]);
    this._schedule();
  }

  async _meters() {
    if (!this.connected || this._metering) return;
    this._metering = true;
    try {
      for (const g of this.groups) {
        try {
          const r = await this._ask("/live/track/get/output_meter_level", [g.id], (a) => Number(a[0]) === g.id, 400);
          if (Number(r[1]) >= LED_ON) {
            g._loud = Date.now();
            if (!g.signal) { g.signal = true; this._schedule(); }
          }
        } catch {
          /* skip this round */
        }
      }
    } finally {
      this._metering = false;
    }
  }

  _ledDecay() {
    const now = Date.now();
    for (const g of this.groups) {
      if (g.signal && now - g._loud > LED_HOLD_MS) { g.signal = false; this._schedule(); }
    }
  }

  // ---- changes coming from Live -------------------------------------------

  _apply(g, prop, raw) {
    if ((this._suppress.get(g.id + prop) || 0) > Date.now()) return;
    const v = prop === "volume" ? Number(raw) : Boolean(raw);
    if (g[prop] !== v) { g[prop] = v; this._schedule(); }
  }

  _handle(m) {
    if (m.address === "/live/song/get/metronome") {
      if (Date.now() >= this._metSuppress && this.metronome !== Boolean(m.args[0])) {
        this.metronome = Boolean(m.args[0]);
        this._schedule();
      }
      return;
    }
    const mm = /^\/live\/track\/get\/(volume|mute|solo)$/.exec(m.address);
    if (!mm) return;
    const g = this._byId.get(Number(m.args[0]));
    if (g) this._apply(g, mm[1], m.args[1]);
  }

  // ---- commands coming from SetTheCue --------------------------------------

  _send(g, prop, value) {
    this._suppress.set(g.id + prop, Date.now() + SUPPRESS_MS);
    g[prop] = value;
    this.osc.send(`/live/track/set/${prop}`, int(g.id), prop === "volume" ? value : int(value ? 1 : 0));
    this._schedule();
  }
  _group(id) {
    return this.connected ? this._byId.get(Number(id)) : null;
  }

  setVolume(id, value) {
    const g = this._group(id);
    if (!g || this.locked) return false;
    this._send(g, "volume", Math.min(1, Math.max(0, Number(value) || 0)));
    return true;
  }
  setMute(id, on) {
    const g = this._group(id);
    if (!g || this.locked) return false;
    this._send(g, "mute", Boolean(on));
    return true;
  }
  setSolo(id, on) {
    const g = this._group(id);
    if (!g || this.locked) return false;
    this._send(g, "solo", Boolean(on));
    return true;
  }
  setMetronome(on) {
    if (!this.connected) return false;
    this.metronome = Boolean(on);
    this._metSuppress = Date.now() + SUPPRESS_MS;
    this.osc.send("/live/song/set/metronome", int(on ? 1 : 0));
    this._schedule();
    return true;
  }
  setLocked(on) {
    this.locked = Boolean(on);
    this._schedule();
    return true;
  }
  /** Back to the values read from Live when we connected. */
  reset() {
    if (!this.connected || this.locked) return false;
    for (const g of this.groups) {
      const init = this._initial.get(g.id);
      if (!init) continue;
      for (const p of PROPS) this._send(g, p, init[p]);
    }
    return true;
  }

  // ---- state --------------------------------------------------------------

  // ---- channel names + colors (cosmetic, kept only in SetTheCue) -------------

  loadPrefs(obj) {
    const out = {};
    if (obj && typeof obj === "object") {
      for (const [k, v] of Object.entries(obj)) {
        const label = typeof v?.label === "string" ? v.label.trim().slice(0, 24) : "";
        const color = /^#[0-9a-f]{6}$/i.test(v?.color || "") ? v.color : "";
        if (label || color) out[k] = { label, color };
      }
    }
    this.prefs = out;
    this._schedule();
  }

  setStyle(id, style = {}) {
    const g = this._byId.get(Number(id));
    if (!g) return false;
    const cur = this.prefs[g.name] || { label: "", color: "" };
    const label = "label" in style ? String(style.label ?? "").trim().slice(0, 24) : cur.label;
    const color = "color" in style ? (/^#[0-9a-f]{6}$/i.test(style.color || "") ? style.color : "") : cur.color;
    if (label || color) this.prefs[g.name] = { label, color };
    else delete this.prefs[g.name];
    this.emit("prefs", this.prefs);
    this._schedule();
    return true;
  }

  _schedule() {
    if (this._emitTimer) return;
    this._emitTimer = setTimeout(() => {
      this._emitTimer = null;
      this.emit("state", this.snapshot());
    }, 30);
  }

  snapshot() {
    return {
      connected: this.connected,
      metronome: this.metronome,
      locked: this.locked,
      groups: this.groups.map(({ id, name, volume, mute, solo, signal }) => {
        const p = this.prefs[name] || {};
        return { id, name, label: p.label || "", color: p.color || "", volume, mute, solo, signal };
      }),
    };
  }
}
