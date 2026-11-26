# Third-party software

SetTheCue bundles and builds on the following open-source projects. We're grateful
to their authors.

## AbletonOSC

- **What:** The MIDI Remote Script that exposes Ableton Live's API over OSC.
  SetTheCue's connection to Live is entirely powered by AbletonOSC.
- **Where in this repo:** [`remote-script/SetTheCue/`](remote-script/SetTheCue/)
  (vendored from commit `0ca68214bd62c9b5cb641ca34006cfd70ba94430`; folder
  renamed to `SetTheCue` so it appears as "SetTheCue" in Live — source otherwise
  unmodified).
- **Author:** Daniel John Jones and contributors
- **Homepage:** https://github.com/ideoforms/AbletonOSC
- **License:** MIT — see [`remote-script/SetTheCue/LICENSE.md`](remote-script/SetTheCue/LICENSE.md)

## Runtime / build dependencies

JavaScript dependencies (osc, ws, sortablejs, Electron, Inter & Space Grotesk
fonts, Font Awesome) are declared in [`package.json`](package.json) and carry
their own licenses; see the section below and `THIRD-PARTY-LICENSES.txt`.

## SetPilot (upstream)

- **What:** The project SetTheCue is derived from.
- **Author:** AshHenbrey
- **Homepage:** https://github.com/AshHenbrey/setpilot
- **License:** AGPL-3.0-or-later — see [`LICENSE`](LICENSE)

## Bundled front-end assets

These files are redistributed in `public/vendor/`. Their full license texts are in
[`public/vendor/licenses/`](public/vendor/licenses/).

- **Font Awesome Free** — Icons: CC BY 4.0, Fonts: SIL OFL 1.1, Code: MIT (Fonticons, Inc.) — https://fontawesome.com/license/free
- **Inter (font)** — SIL Open Font License 1.1 (The Inter Project Authors) — https://github.com/rsms/inter
- **Space Grotesk (font)** — SIL Open Font License 1.1 (The Space Grotesk Project Authors) — https://github.com/floriankarsten/space-grotesk
- **SortableJS** — MIT License — https://github.com/SortableJS/Sortable
