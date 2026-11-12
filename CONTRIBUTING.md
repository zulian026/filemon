# Contributing to FileMon

Thanks for helping out. FileMon is a small project — Tauri v2 + Rust backend, Vite + TypeScript frontend — and contributions stay close to how the code already works.

## Setup

Follow [Building from source](README.md#building-from-source): install the Tauri system dependencies, then `npm install`. You need Node.js 18+ and a recent stable Rust toolchain.

## Workflow

1. Fork the repository and create a branch from `main` for your change.
2. Make the change, keeping it focused — one feature or fix per pull request.
3. Run the checks below.
4. Open a pull request against `main` with a short description of what changed, why, and how you tested it. If it fixes an issue, link the issue.

## Checks

```bash
npm run build            # TypeScript (strict) + Vite build; must pass
cd src-tauri
cargo test               # 19 tests: transfer engine, zip, trash, terminal detection, folder sizes; must pass
npm run tauri build      # full release build, if you touched the backend or packaging
```

If you changed filesystem behaviour, add or extend a test in `src-tauri/src/fsops.rs` — the transfer engine, zip handling, trash bookkeeping, terminal detection, and folder-size walk are pure functions, so they are easy to cover without a live system. New backend commands go in `src-tauri/src/lib.rs` with the handler next to the code it calls.

## Style

- Match the existing style of the file you are editing. Rust follows the standard `rustfmt` layout; TypeScript is strict (`tsconfig.json`) and the frontend keeps one icon set in `src/main.ts` (`ICONS`) plus the static SVGs in `index.html`.
- Keep the UI dark and minimal: ground `#000`, surface `#111`, lime `#c6f24e` only on data. No gradients, no glow, no shadows on resting surfaces; colour only on data. New strings are in English.
