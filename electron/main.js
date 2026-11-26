// SetTheCue desktop shell.
//
// Boots the same server in-process (so Ableton control + the LAN remote keep
// working exactly as with `npm start`) and shows the UI in a native window.
// Phones/tablets can still connect to the printed LAN URL at the same time.

import { app, BrowserWindow, Menu, dialog, ipcMain, screen, shell, session } from "electron";
import { fileURLToPath } from "node:url";
import { startServer } from "../src/server.js";
import { promptAndInstall } from "./install-remote-script.js";
import fs from "node:fs";
import path from "node:path";

const preloadPath = fileURLToPath(new URL("preload.cjs", import.meta.url));

let win;
let midiWin = null;
let serverUrl = null; // base URL of the in-process server, set on boot

// Open (or focus) the MIDI Control settings window — a normal resizable window,
// separate from the tall performance window so it doesn't clutter it.
function openMidiWindow() {
  if (midiWin && !midiWin.isDestroyed()) {
    midiWin.focus();
    return;
  }
  midiWin = new BrowserWindow({
    width: 460,
    height: 520, // starting height; auto-fits to content after load
    minWidth: 460, // fixed width to match the main window
    maxWidth: 460,
    minHeight: 120,
    useContentSize: true, // width/height refer to the web content, not the frame
    title: "SetTheCue — Configure MIDI Control",
    backgroundColor: "#0e0e11",
    parent: win,
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: preloadPath },
  });
  midiWin.setMenuBarVisibility(false);
  midiWin.loadURL(`${serverUrl}/midi.html`);
  midiWin.on("closed", () => {
    midiWin = null;
  });
}

// Lyrics window: opens beside the main window (to its right, or its left if there is no room),
// same height at the moment it opens, fully independent afterwards. The Lyric button calls
// window.open("/lyrics.html#lirik"); that call is caught below and toggles this window.
let lyricWin = null;
function toggleLyricsWindow() {
  if (lyricWin && !lyricWin.isDestroyed()) {
    lyricWin.close();
    return;
  }
  const b = win.getBounds();
  const area = screen.getDisplayMatching(b).workArea;
  const width = 460;
  // Default: always to the RIGHT of the main window, top-aligned, half its height.
  // If the right side has no room, slide in from the screen edge instead of jumping to the left.
  let x = b.x + b.width;
  if (x + width > area.x + area.width) x = Math.max(area.x, area.x + area.width - width);
  const height = Math.max(200, Math.round(b.height / 2));
  lyricWin = new BrowserWindow({
    x,
    y: b.y,
    width,
    height,
    minWidth: 280,
    minHeight: 200,
    title: "SetTheCue — Lyrics",
    backgroundColor: "#0b0b0c",
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  lyricWin.setMenuBarVisibility(false);
  lyricWin.loadURL(`${serverUrl}/lyrics.html#lirik`);
  lyricWin.on("closed", () => {
    lyricWin = null;
  });
}

// Resize whichever window sent the report to its content height, clamped to the
// available screen height. Width stays fixed. Works for both the main window and
// the MIDI Control window (both load the same height-reporting preload).
ipcMain.on("set-content-height", (event, height) => {
  const bw = BrowserWindow.fromWebContents(event.sender);
  if (!bw || bw.isDestroyed()) return;
  const [width] = bw.getContentSize();
  const { height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;
  const next = Math.min(Math.max(height, 120), screenHeight);
  // The window fits its content (no dead space). The now-playing card is a fixed
  // height per song and the set list scrolls internally, so this only changes on
  // real transitions (start/stop, opening the editor) — not when clicking songs.
  if (Math.abs(next - bw.getContentSize()[1]) > 1) bw.setContentSize(width, next, false);
});

// Native menu with an About item that shows the copyright / license popup.
// We keep the standard Edit/View/Window menus so copy-paste, quit, etc. work.
function buildMenu() {
  const isMac = process.platform === "darwin";

  const about = {
    label: "About SetTheCue",
    click: () =>
      dialog.showMessageBox(win, {
        type: "info",
        title: "About SetTheCue",
        message: "SetTheCue",
        detail:
          "Setlist control for Ableton Live.\n\n" +
          "© 2026 SetTheCue\n" +
          "Based on SetPilot by AshHenbrey.\n" +
          "Modified by Gaemusician.\n" +
          "Includes AbletonOSC by Daniel John Jones and contributors (MIT).\n" +
          "Licensed under AGPL-3.0-or-later.\n" +
          "Source code: https://github.com/gaemusician/SetTheCue\n" +
          "",
        buttons: ["OK"],
      }),
  };

  const installItem = {
    label: "Install Ableton Control Surface",
    click: () => promptAndInstall(win, "manual"),
  };

  const midiItem = {
    label: "Configure MIDI Control",
    accelerator: "CmdOrCtrl+,",
    click: () => openMidiWindow(),
  };

  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              about,
              { type: "separator" },
              midiItem,
              installItem,
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ]
      : []),
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    ...(isMac ? [] : [{ role: "help", submenu: [midiItem, installItem, about] }]),
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createWindow() {
  // Saved setlists must go somewhere writable: the packaged app's own files live
  // in a read-only asar, so point the store at the per-user data dir before the
  // server (and its setlist store) boots. store.js reads this env var.
  // Pindahkan data dari folder lama (SetPilot) ke SetTheCue saat pertama kali dijalankan.
  try {
    const oldDir = ["SatSitSet","SetLane","SetPilot"].map((n) => path.join(app.getPath("appData"), n)).find((p) => fs.existsSync(p)) || path.join(app.getPath("appData"), "SetPilot");
    const curDir = app.getPath("userData");
    if (oldDir !== curDir && fs.existsSync(oldDir) && !fs.existsSync(path.join(curDir, "setlists")) && !fs.existsSync(path.join(curDir, "lyrics"))) {
      fs.cpSync(oldDir, curDir, { recursive: true });
    }
  } catch { /* abaikan: aplikasi tetap jalan */ }
  process.env.SETTHECUE_DATA_DIR = app.getPath("userData");

  const { url } = await startServer();
  serverUrl = url; // used to open the MIDI Control window

  // The window only ever shows our own localhost UI (external links open in the
  // system browser), so we can safely grant the permissions it asks for — namely
  // Web MIDI, used to read a footswitch/controller, and the screen wake lock.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, cb) => cb(true));
  session.defaultSession.setPermissionCheckHandler(() => true);

  win = new BrowserWindow({
    width: 460,
    height: 700, // starting height; the window fits to content after load
    minWidth: 460, // fixed width — width can't be dragged
    maxWidth: 460,
    minHeight: 120,
    useContentSize: true, // width/height refer to the web content, not the frame
    backgroundColor: "#0b0717", // matches the app background so there's no flash
    title: "SetTheCue",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath,
    },
  });

  buildMenu();
  win.on("closed", () => {
    if (lyricWin && !lyricWin.isDestroyed()) lyricWin.close();
  });

  win.once("ready-to-show", () => {
    win.show();
    // First-run / update check: offer to install the control surface. Skippable
    // and remembered per version, so it won't nag on every launch.
    promptAndInstall(win, "startup").catch(() => {});
  });
  win.loadURL(url);

  // Keep external links (docs, etc.) in the system browser, not the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/\/lyrics\.html(#|\?|$)/.test(url)) {
      toggleLyricsWindow();
      return { action: "deny" };
    }
    shell.openExternal(url);
    return { action: "deny" };
  });
}

app.whenReady().then(createWindow);

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on("window-all-closed", () => app.quit());