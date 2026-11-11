# FileMon — File Manager for Linux

A Windows Explorer-style file manager for Linux, built with Tauri v2 and Rust.

Browse folders, search, copy, move, rename, delete to Trash, and preview files — with a navigation pane, breadcrumbs, details and icon views, and a light mode.

## Features

- **Explorer shell** — sidebar with Quick access and drives, breadcrumbs, back/forward/up navigation with history
- **Two views** — details table (name, date modified, type, size, sortable) and icon grid
- **File operations** — copy, cut, paste, rename, new folder, new file, delete to the freedesktop Trash (restorable), properties
- **Search** — instant filter of the current folder, Enter searches recursively below it
- **Preview pane** — image preview and text preview of the selected file, folder summary otherwise
- **Keyboard** — Alt+Left/Right to go back/forward, Alt+Up, Backspace up, Ctrl+C/X/V, Delete, F2 rename, Ctrl+F search, Enter open
- **Design** — Hallmark Rim theme, remapped to the family system: true-black-flat, lime `#c6f24e` accent, system fonts, square surfaces, light mode included

## Install

Download the latest release for your distro:

- **AppImage** — download, `chmod +x`, run
- **.deb** (Debian/Ubuntu) — `sudo dpkg -i filemon_*.deb`
- **.rpm** (Fedora/openSUSE) — `sudo rpm -i filemon-*.rpm`
- **Binary** — extract and run `./filemon`

Or build from source:

```bash
npm install
npm run tauri build
```

The binary lands in `src-tauri/target/release/filemon`.

## Tech

- Frontend: TypeScript + Vite, no framework
- Backend: Rust, Tauri v2 — `src-tauri/src/fsops.rs` holds the filesystem logic
- Design: Hallmark v2.0.0, Rim theme (see `src/styles.css` stamp)

## License

MIT
