import fs from 'fs';
import os from 'os';
import path from 'path';

const locFile = process.argv[2];
if (!locFile) { console.log('Pakai: node tools/cek-lirik.mjs <file-hasil-cek-lokator>'); process.exit(1); }

// Lirik tersimpan per band: pakai band di argumen ke-2 (node tools/cek-lirik.mjs <file> <band>),
// kalau tidak ada pakai band yang sedang aktif di SetTheCue.
const base = path.join(os.homedir(), 'Library/Application Support/SetTheCue');
let band = process.argv[3];
if (!band) { try { band = JSON.parse(fs.readFileSync(path.join(base, 'active-band.json'), 'utf8')).name; } catch {} }
const dir = band ? path.join(base, 'bands', band, 'lyrics') : path.join(base, 'lyrics');
const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.txt'));

// Baca locator dari hasil cek-lokator
const locs = [];
for (const l of fs.readFileSync(locFile, 'utf8').split('\n')) {
  const m = l.match(/^\s*(\d+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*(.*?)\s*$/);
  if (m) locs.push({ beat: parseFloat(m[2]), name: m[4] });
}

// Kelompokkan per lagu: locator tanpa ">" = judul lagu
const songs = [];
for (const l of locs) {
  if (l.name.startsWith('>')) songs.at(-1)?.sections.push({ beat: l.beat, name: l.name.replace(/^>\s*/, '') });
  else songs.push({ title: l.name, beat: l.beat, sections: [] });
}

const used = new Set();
let masalah = 0;

for (const s of songs) {
  const file = files.find(f => norm(f).includes(norm(s.title)));
  if (!file) { console.log(`- ${s.title}: tidak ada file lirik`); continue; }
  used.add(file);
  const lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n');
  const lyrics = [];
  lines.forEach((t, i) => {
    const m = t.match(/^\[([\d.]+)\]\s*(.*)$/);
    if (m) lyrics.push({ bar: parseFloat(m[1]), text: m[2], no: i + 1 });
  });
  for (const sec of s.sections) {
    const start = (sec.beat - s.beat) / 4 + 1;
    for (const ly of lyrics) {
      if (ly.bar > start - 1 && ly.bar < start - 0.001) {
        masalah++;
        console.log(`${s.title} | ${file} baris ${ly.no}: [${ly.bar}] "${ly.text}"`);
        console.log(`   sebelum bagian "${sec.name}" yang mulai di bar ${start}. Mungkin harus [${start}]\n`);
      }
    }
  }
}

const tanpaLagu = files.filter(f => !used.has(f));
if (tanpaLagu.length) console.log('File lirik tanpa lagu yang cocok di Ableton:', tanpaLagu.join(', '));
console.log(masalah ? `\n${masalah} baris mencurigakan.` : '\nTidak ada baris yang mencurigakan.');
