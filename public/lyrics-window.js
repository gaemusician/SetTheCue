// Standalone lyrics window: its own WebSocket to the SetTheCue server, then the same lyrics
// screen as before (follows the active song and playhead). Opened from the Lyric button.

import { initLyrics } from "/lyrics.js";

let ws;
let snapshot = null;

const note = document.createElement("div");
note.style.cssText =
  "position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:2000;display:none;" +
  "background:#222;color:#fff;padding:8px 14px;border-radius:10px;font:14px -apple-system,sans-serif;";
document.body.appendChild(note);
let noteTimer;
function toast(message) {
  note.textContent = message;
  note.style.display = "block";
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => (note.style.display = "none"), 2500);
}

function send(action, payload = {}) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ action, payload }));
}

const lyrics = initLyrics({ send, getSnapshot: () => snapshot, toast });

function connect() {
  ws = new WebSocket(`ws://${location.host}`);
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if ((msg.type === "hello" || msg.type === "state") && msg.snapshot) snapshot = msg.snapshot;
    lyrics.onMessage(msg);
    if (msg.type === "warning" || msg.type === "error") toast(msg.message);
  };
  ws.onclose = () => setTimeout(connect, 1000);
}
connect();
