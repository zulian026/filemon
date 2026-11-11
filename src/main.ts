import { invoke, convertFileSrc } from "@tauri-apps/api/core";

type Entry = {
  name: string;
  path: string;
  is_dir: boolean;
  is_symlink: boolean;
  size: number | null;
  modified: number | null;
  extension: string | null;
  hidden: boolean;
};

type Drive = {
  name: string;
  mount: string;
  total: number;
  free: number;
  fs: string;
  removable: boolean;
};

type Properties = {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  items: number | null;
  modified: number | null;
  permissions: string;
  kind: string;
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const state = {
  path: "",
  history: [] as string[],
  histIndex: -1,
  entries: [] as Entry[],
  filtered: [] as Entry[],
  selection: new Set<string>(),
  clipboard: null as { mode: "copy" | "cut"; paths: string[] } | null,
  view: (localStorage.getItem("filemon-view") as "details" | "icons") || "details",
  sortKey: (localStorage.getItem("filemon-sort") as "name" | "size" | "modified" | "type") || "name",
  sortDir: 1,
  showHidden: localStorage.getItem("filemon-hidden") === "1",
  searching: false,
  searchQuery: "",
  drives: [] as Drive[],
  previewOpen: false,
  homeDir: "",
};

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]);
const TEXT_EXTS = new Set(["txt", "md", "rs", "py", "js", "ts", "json", "toml", "html", "css", "sh", "log", "csv"]);

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = -1;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

function fmtDate(epoch: number | null): string {
  if (epoch === null) return "—";
  return new Date(epoch * 1000).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function kindLabel(e: Entry): string {
  if (e.is_dir) return "Folder";
  switch (e.extension) {
    case "png": case "jpg": case "jpeg": case "gif": case "webp": case "svg": case "bmp": return "Image";
    case "mp4": case "mkv": case "webm": case "mov": case "avi": return "Video";
    case "mp3": case "flac": case "wav": case "ogg": case "m4a": return "Audio";
    case "pdf": return "PDF document";
    case "zip": case "tar": case "gz": case "xz": case "7z": case "rar": case "deb": case "rpm": return "Archive";
    case "txt": case "md": case "rs": case "py": case "js": case "ts": case "json": case "toml": case "html": case "css": case "sh": return "Text file";
    case null: return "File";
    default: return `${(e.extension as string).toUpperCase()} file`;
  }
}

const ICONS: Record<string, string> = {
  folder: '<path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 2h6.5A1.5 1.5 0 0 1 16 6.5v6A1.5 1.5 0 0 1 14.5 14h-11A1.5 1.5 0 0 1 2 12.5v-8z"/>',
  file: '<path d="M4 1.5h5.5L13 5v9.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-12a1 1 0 0 1 1-1z"/><path d="M9 1.5V5.5h4"/>',
  image: '<rect x="2" y="3" width="12" height="10" rx="1"/><circle cx="5.5" cy="6.5" r="1.2"/><path d="M2 11l3.5-3 3 3 2.5-2.5L14 11"/>',
  video: '<rect x="2" y="3" width="12" height="10" rx="1"/><path d="M7 6.5l4 1.5-4 1.5z"/>',
  audio: '<path d="M6 12V4.5l6-1.5V11"/><circle cx="4" cy="12" r="2"/><circle cx="10" cy="11" r="2"/>',
  archive: '<rect x="2.5" y="3" width="11" height="3" rx="0.5"/><path d="M3.5 6v6.5A1.5 1.5 0 0 0 5 14h6a1.5 1.5 0 0 0 1.5-1.5V6M8 8.5v3M6.5 10h3"/>',
  doc: '<path d="M4 1.5h5.5L13 5v9.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-12a1 1 0 0 1 1-1z"/><path d="M5.5 8h5M5.5 10.5h5"/>',
  panel: '<rect x="2" y="2.5" width="12" height="11" rx="1"/><path d="M10.5 2.5v11"/>',
  sun: '<circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1"/>',
  moon: '<path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7z"/>',
  folderPlus: '<path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 2h6.5A1.5 1.5 0 0 1 16 6.5v6A1.5 1.5 0 0 1 14.5 14h-11A1.5 1.5 0 0 1 2 12.5v-8z"/><path d="M11 12.5h4M13 10.5v4"/>',
  filePlus: '<path d="M4 1.5h5.5L13 5v9.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-12a1 1 0 0 1 1-1z"/><path d="M9 1.5V5.5h4"/><path d="M10.5 12.5h4M12.5 10.5v4"/>',
  scissors: '<circle cx="4.5" cy="4.5" r="1.8"/><circle cx="4.5" cy="11.5" r="1.8"/><path d="M6 6l8 5M6 10l8-5"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/>',
  paste: '<rect x="3.5" y="3.5" width="9" height="11" rx="1"/><path d="M6 3.5V2.8a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v.7M6.5 8h3M6.5 10.5h3"/>',
  pencil: '<path d="M10.8 2.8l2.4 2.4L6 12.4H3.6V10z"/><path d="M9.2 4.4l2.4 2.4"/>',
  trash: '<path d="M2.5 4h11M6.5 4V2.8h3V4M4 4l.8 10h6.4L12 4M6.5 7v4M9.5 7v4"/>',
  info: '<circle cx="8" cy="8" r="6.5"/><path d="M8 7.5V11M8 4.8v.3"/>',
  list: '<path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.5M2.5 8h.5M2.5 12h.5"/>',
  grid: '<rect x="2.5" y="2.5" width="4.5" height="4.5" rx="0.5"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="0.5"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="0.5"/><rect x="9" y="9" width="4.5" height="4.5" rx="0.5"/>',
};

function iconFor(e: Entry): string {
  if (e.is_dir) return ICONS.folder;
  switch (e.extension) {
    case "png": case "jpg": case "jpeg": case "gif": case "webp": case "svg": case "bmp": return ICONS.image;
    case "mp4": case "mkv": case "webm": case "mov": case "avi": return ICONS.video;
    case "mp3": case "flac": case "wav": case "ogg": case "m4a": return ICONS.audio;
    case "zip": case "tar": case "gz": case "xz": case "7z": case "rar": case "deb": case "rpm": return ICONS.archive;
    case "pdf": case "txt": case "md": case "rs": case "py": case "js": case "ts": case "json": return ICONS.doc;
    default: return ICONS.file;
  }
}

function iconSvg(inner: string, cls = "icon"): string {
  return `<svg class="${cls}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

let toastTimer = 0;
function toast(msg: string, isError = false): void {
  const el = $("toast");
  el.textContent = msg;
  el.classList.toggle("is-error", isError);
  el.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    el.hidden = true;
  }, 3500);
}

function parentOf(path: string): string | null {
  if (path === "/") return null;
  const cut = path.replace(/\/+$/, "");
  const i = cut.lastIndexOf("/");
  if (i <= 0) return "/";
  return cut.slice(0, i);
}

function driveFor(path: string): Drive | null {
  let best: Drive | null = null;
  for (const d of state.drives) {
    if ((path === d.mount || path.startsWith(d.mount.endsWith("/") ? d.mount : d.mount + "/")) && (!best || d.mount.length > best.mount.length)) {
      best = d;
    }
  }
  return best;
}

async function navigate(path: string, push = true): Promise<void> {
  if (push) {
    state.history = state.history.slice(0, state.histIndex + 1);
    state.history.push(path);
    state.histIndex = state.history.length - 1;
  }
  state.path = path;
  state.searching = false;
  state.searchQuery = "";
  ($("search") as HTMLInputElement).value = "";
  state.selection.clear();
  await loadDir();
  updateNavButtons();
}

function updateNavButtons(): void {
  ($("btn-back") as HTMLButtonElement).disabled = state.histIndex <= 0;
  ($("btn-forward") as HTMLButtonElement).disabled = state.histIndex >= state.history.length - 1;
  ($("btn-up") as HTMLButtonElement).disabled = parentOf(state.path) === null;
}

function applyFilterSort(): void {
  let list = state.entries;
  if (!state.showHidden) list = list.filter((e) => !e.hidden);
  const q = state.searchQuery.trim().toLowerCase();
  if (q && !state.searching) list = list.filter((e) => e.name.toLowerCase().includes(q));
  const dir = state.sortDir;
  const key = state.sortKey;
  list = [...list].sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    let cmp = 0;
    if (key === "name") cmp = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    else if (key === "size") cmp = (a.size ?? -1) - (b.size ?? -1);
    else if (key === "modified") cmp = (a.modified ?? 0) - (b.modified ?? 0);
    else cmp = kindLabel(a).localeCompare(kindLabel(b));
    return cmp * dir;
  });
  state.filtered = list;
}

function renderCrumbs(): void {
  const nav = $("crumbs");
  nav.innerHTML = "";
  const parts = state.path.split("/").filter(Boolean);
  const mk = (label: string, path: string) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "crumb";
    b.textContent = label;
    b.addEventListener("click", () => void navigate(path));
    return b;
  };
  nav.appendChild(mk("This PC", "/"));
  let acc = "";
  for (const p of parts) {
    acc += "/" + p;
    const sep = document.createElement("span");
    sep.className = "crumb-sep";
    sep.textContent = "/";
    nav.appendChild(sep);
    nav.appendChild(mk(p, acc));
  }
  $("side-path").textContent = state.path;
}

function renderTable(): void {
  const body = $("file-body");
  body.innerHTML = "";
  for (const e of state.filtered) {
    const tr = document.createElement("tr");
    tr.dataset.path = e.path;
    if (state.selection.has(e.path)) tr.classList.add("is-selected");
    const nameTd = document.createElement("td");
    // NB: .cell-name is display:flex — it must wrap the content in a div.
    // Putting it on the td itself turns the cell into a flex box, and
    // WebKitGTK then drops that cell's collapsed bottom border, so the row
    // dividers looked cut under the Name column.
    nameTd.innerHTML = `<div class="cell-name">${iconSvg(iconFor(e), "icon file-icon")}<span class="file-name">${escapeHtml(e.name)}</span></div>`;
    const modTd = document.createElement("td");
    modTd.textContent = fmtDate(e.modified);
    const typeTd = document.createElement("td");
    typeTd.textContent = kindLabel(e);
    const sizeTd = document.createElement("td");
    sizeTd.className = "num";
    sizeTd.textContent = e.is_dir ? "—" : fmtSize(e.size ?? 0);
    tr.append(nameTd, modTd, typeTd, sizeTd);
    tr.addEventListener("click", (ev) => onRowClick(ev, e));
    tr.addEventListener("dblclick", () => void openEntry(e));
    tr.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      if (!state.selection.has(e.path)) {
        state.selection.clear();
        state.selection.add(e.path);
        renderSelection();
      }
      showContextMenu(ev.clientX, ev.clientY, e);
    });
    body.appendChild(tr);
  }
}

function renderGrid(): void {
  const wrap = $("grid-wrap");
  wrap.innerHTML = "";
  for (const e of state.filtered) {
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = "tile";
    if (state.selection.has(e.path)) tile.classList.add("is-selected");
    tile.innerHTML = `${iconSvg(iconFor(e), "icon tile-icon")}<span class="tile-name">${escapeHtml(e.name)}</span>`;
    tile.addEventListener("click", (ev) => onRowClick(ev, e));
    tile.addEventListener("dblclick", () => void openEntry(e));
    tile.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      if (!state.selection.has(e.path)) {
        state.selection.clear();
        state.selection.add(e.path);
        renderSelection();
      }
      showContextMenu(ev.clientX, ev.clientY, e);
    });
    wrap.appendChild(tile);
  }
}

function renderSelection(): void {
  document.querySelectorAll("#file-body tr").forEach((tr) => {
    tr.classList.toggle("is-selected", state.selection.has((tr as HTMLTableRowElement).dataset.path ?? ""));
  });
  document.querySelectorAll("#grid-wrap .tile").forEach((t, i) => {
    t.classList.toggle("is-selected", state.selection.has(state.filtered[i]?.path ?? ""));
  });
  const n = state.selection.size;
  const has = n > 0;
  for (const id of ["act-cut", "act-copy", "act-rename", "act-delete", "act-props"]) {
    ($ (id) as HTMLButtonElement).disabled = !has;
  }
  ($("act-rename") as HTMLButtonElement).disabled = n !== 1;
  ($("act-props") as HTMLButtonElement).disabled = n !== 1;
  ($("act-paste") as HTMLButtonElement).disabled = state.clipboard === null;
  if (n === 0) {
    $("status-selection").textContent = "Nothing selected";
  } else {
    let bytes = 0;
    let files = 0;
    for (const p of state.selection) {
      const e = state.entries.find((x) => x.path === p);
      if (e && e.size !== null) {
        bytes += e.size;
        files++;
      }
    }
    $("status-selection").textContent = files > 0 ? `${n} selected · ${fmtSize(bytes)}` : `${n} selected`;
  }
  void updatePreview();
}

function renderStatus(): void {
  const total = state.entries.length;
  const shown = state.filtered.length;
  $("status-count").textContent = state.searching
    ? `${shown} results for “${state.searchQuery}”`
    : shown === total
      ? `${total} items`
      : `${shown} of ${total} items`;
  const d = driveFor(state.path);
  if (d) {
    $("status-drive").textContent = `${fmtSize(d.free)} free of ${fmtSize(d.total)} on ${d.mount}`;
    $("side-free").textContent = `${fmtSize(d.free)} free`;
  } else {
    $("status-drive").textContent = "—";
    $("side-free").textContent = "—";
  }
}

function render(): void {
  applyFilterSort();
  renderCrumbs();
  renderTable();
  renderGrid();
  renderStatus();
  renderSelection();
  $("table-wrap").hidden = state.view !== "details";
  $("grid-wrap").hidden = state.view !== "icons";
  $("view-details").classList.toggle("is-active", state.view === "details");
  $("view-icons").classList.toggle("is-active", state.view === "icons");
}

function showState(which: "loading" | "empty" | "error" | "full"): void {
  $("loading").hidden = which !== "loading";
  $("empty").hidden = which !== "empty";
  $("error").hidden = which !== "error";
  $("table-wrap").hidden = which !== "full" || state.view !== "details";
  $("grid-wrap").hidden = which !== "full" || state.view !== "icons";
}

async function loadDir(): Promise<void> {
  showState("loading");
  try {
    const entries = await invoke<Entry[]>("list_dir", { path: state.path });
    state.entries = entries;
    render();
    ($("empty") as HTMLElement).querySelector("h2")!.textContent = "This folder is empty";
    ($("empty") as HTMLElement).querySelector("p")!.textContent = "Nothing here yet. Create a folder or paste files into it.";
    showState(state.filtered.length === 0 ? "empty" : "full");
    renderStatus();
  } catch (err) {
    $("error-text").textContent = String(err);
    showState("error");
    renderCrumbs();
    renderStatus();
  }
}

function onRowClick(ev: MouseEvent, e: Entry): void {
  if (ev.ctrlKey || ev.metaKey) {
    if (state.selection.has(e.path)) state.selection.delete(e.path);
    else state.selection.add(e.path);
  } else if (ev.shiftKey && state.selection.size > 0) {
    const idx = state.filtered.findIndex((x) => x.path === e.path);
    const anchor = state.filtered.findIndex((x) => state.selection.has(x.path));
    const [a, b] = [Math.min(idx, anchor), Math.max(idx, anchor)];
    for (let i = a; i <= b; i++) state.selection.add(state.filtered[i].path);
  } else {
    state.selection.clear();
    state.selection.add(e.path);
  }
  renderSelection();
}

async function openEntry(e: Entry): Promise<void> {
  if (e.is_dir) {
    await navigate(e.path);
    return;
  }
  try {
    await invoke("open_path", { path: e.path });
  } catch (err) {
    toast(`Could not open ${e.name}: ${err}`, true);
  }
}

function selectedEntries(): Entry[] {
  return state.entries.filter((e) => state.selection.has(e.path));
}

async function doCopyCut(mode: "copy" | "cut"): Promise<void> {
  const paths = [...state.selection];
  if (paths.length === 0) return;
  state.clipboard = { mode, paths };
  renderSelection();
  toast(mode === "copy" ? `${paths.length} item${paths.length > 1 ? "s" : ""} copied` : `${paths.length} item${paths.length > 1 ? "s" : ""} cut`);
}

async function doPaste(): Promise<void> {
  const cb = state.clipboard;
  if (!cb) return;
  try {
    const n = await invoke<number>(cb.mode === "copy" ? "copy_paths" : "move_paths", { paths: cb.paths, dest: state.path });
    if (cb.mode === "cut") state.clipboard = null;
    toast(`${n} item${n === 1 ? "" : "s"} pasted`);
    await loadDir();
  } catch (err) {
    toast(`Paste failed: ${err}`, true);
  }
}

function askDelete(): void {
  const items = selectedEntries();
  if (items.length === 0) return;
  $("delete-text").textContent =
    items.length === 1
      ? `“${items[0].name}” will be moved to the Trash. You can restore it from there.`
      : `${items.length} items will be moved to the Trash. You can restore them from there.`;
  ($("dlg-delete") as HTMLDialogElement).showModal();
}

async function doDelete(): Promise<void> {
  const paths = [...state.selection];
  try {
    const n = await invoke<number>("delete_paths", { paths });
    state.selection.clear();
    toast(`${n} item${n === 1 ? "" : "s"} moved to Trash`);
    await loadDir();
  } catch (err) {
    toast(`Delete failed: ${err}`, true);
  }
}

function askRename(): void {
  const items = selectedEntries();
  if (items.length !== 1) return;
  const input = $("rename-input") as HTMLInputElement;
  input.value = items[0].name;
  $("rename-error").hidden = true;
  ($("dlg-rename") as HTMLDialogElement).showModal();
  input.focus();
  input.select();
}

async function doRename(): Promise<void> {
  const items = selectedEntries();
  if (items.length !== 1) return;
  const name = ($("rename-input") as HTMLInputElement).value;
  try {
    await invoke("rename_path", { path: items[0].path, new_name: name });
    toast(`Renamed to ${name}`);
    await loadDir();
  } catch (err) {
    const el = $("rename-error");
    el.textContent = String(err);
    el.hidden = false;
    ($("dlg-rename") as HTMLDialogElement).showModal();
  }
}

let newKind: "folder" | "file" = "folder";
function askNew(kind: "folder" | "file"): void {
  newKind = kind;
  $("new-title").textContent = kind === "folder" ? "New folder" : "New file";
  ($("new-input") as HTMLInputElement).value = kind === "folder" ? "New folder" : "New file";
  $("new-error").hidden = true;
  ($("dlg-new") as HTMLDialogElement).showModal();
  const input = $("new-input") as HTMLInputElement;
  input.focus();
  input.select();
}

async function doNew(): Promise<void> {
  const name = ($("new-input") as HTMLInputElement).value;
  try {
    await invoke(newKind === "folder" ? "new_folder" : "new_file", { parent: state.path, name });
    toast(newKind === "folder" ? "Folder created" : "File created");
    await loadDir();
  } catch (err) {
    const el = $("new-error");
    el.textContent = String(err);
    el.hidden = false;
    ($("dlg-new") as HTMLDialogElement).showModal();
  }
}

async function showProperties(): Promise<void> {
  const items = selectedEntries();
  if (items.length !== 1) return;
  try {
    const p = await invoke<Properties>("get_properties", { path: items[0].path });
    $("props-title").textContent = p.name;
    const body = $("props-body");
    body.innerHTML = "";
    const rows: [string, string][] = [
      ["Type", p.kind],
      ["Location", p.path.slice(0, p.path.length - p.name.length) || "/"],
      ["Size", p.is_dir ? `${fmtSize(p.size)} (${p.items ?? 0} items)` : fmtSize(p.size)],
      ["Modified", fmtDate(p.modified)],
      ["Permissions", p.permissions],
    ];
    for (const [k, v] of rows) {
      const div = document.createElement("div");
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = v;
      div.append(dt, dd);
      body.appendChild(div);
    }
    ($("dlg-props") as HTMLDialogElement).showModal();
  } catch (err) {
    toast(`Could not read properties: ${err}`, true);
  }
}

async function updatePreview(): Promise<void> {
  if (!state.previewOpen) return;
  const body = $("preview-body");
  const items = selectedEntries();
  if (items.length !== 1) {
    $("preview-title").textContent = "Preview";
    body.innerHTML = `<p class="preview-note">Select one file to preview it here.</p>`;
    return;
  }
  const e = items[0];
  $("preview-title").textContent = e.name;
  if (e.is_dir) {
    try {
      const p = await invoke<Properties>("get_properties", { path: e.path });
      body.innerHTML = `<dl class="detail-grid"><div><dt>Type</dt><dd>Folder</dd></div><div><dt>Size</dt><dd>${fmtSize(p.size)}</dd></div><div><dt>Items</dt><dd>${p.items ?? 0}</dd></div><div><dt>Modified</dt><dd>${fmtDate(p.modified)}</dd></div></dl>`;
    } catch {
      body.innerHTML = `<p class="preview-note">Folder</p>`;
    }
    return;
  }
  if (e.extension && IMAGE_EXTS.has(e.extension)) {
    const url = convertFileSrc(e.path);
    const img = document.createElement("img");
    img.className = "preview-img";
    img.src = url;
    img.alt = `Preview of ${e.name}`;
    img.onerror = () => {
      body.innerHTML = `<p class="preview-note">Could not preview this image.</p>`;
    };
    body.innerHTML = "";
    body.appendChild(img);
    return;
  }
  if (e.extension && TEXT_EXTS.has(e.extension) && (e.size ?? 0) < 200_000) {
    try {
      const text = await invoke<string>("read_text", { path: e.path });
      const pre = document.createElement("pre");
      pre.className = "preview-text";
      pre.textContent = text;
      body.innerHTML = "";
      body.appendChild(pre);
      return;
    } catch {
      /* fall through to summary */
    }
  }
  body.innerHTML = `<dl class="detail-grid"><div><dt>Type</dt><dd>${kindLabel(e)}</dd></div><div><dt>Size</dt><dd>${fmtSize(e.size ?? 0)}</dd></div><div><dt>Modified</dt><dd>${fmtDate(e.modified)}</dd></div></dl>`;
}

function setPreview(open: boolean): void {
  state.previewOpen = open;
  $("preview").hidden = !open;
  $("preview-toggle").setAttribute("aria-pressed", String(open));
  $("preview-toggle").classList.toggle("is-active", open);
  if (open) void updatePreview();
}

function showContextMenu(x: number, y: number, target: Entry | null): void {
  const menu = $("ctx-menu");
  menu.innerHTML = "";
  const items: { label: string; disabled?: boolean; action: () => void | Promise<void> }[] = [];
  if (target) {
    items.push({ label: "Open", action: () => void openEntry(target) });
    items.push({ label: "Copy", action: () => void doCopyCut("copy") });
    items.push({ label: "Cut", action: () => void doCopyCut("cut") });
    items.push({ label: "Rename", disabled: state.selection.size !== 1, action: askRename });
    items.push({ label: "Delete", action: askDelete });
    items.push({ label: "Properties", disabled: state.selection.size !== 1, action: () => void showProperties() });
  } else {
    items.push({ label: "New folder", action: () => askNew("folder") });
    items.push({ label: "New file", action: () => askNew("file") });
    items.push({ label: "Paste", disabled: state.clipboard === null, action: () => void doPaste() });
  }
  for (const item of items) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ctx-item";
    b.textContent = item.label;
    b.disabled = !!item.disabled;
    b.setAttribute("role", "menuitem");
    b.addEventListener("click", () => {
      menu.hidden = true;
      void item.action();
    });
    menu.appendChild(b);
  }
  menu.hidden = false;
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;
}

function hideContextMenu(): void {
  $("ctx-menu").hidden = true;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function runSearch(): Promise<void> {
  const q = ($("search") as HTMLInputElement).value.trim();
  if (!q) {
    state.searching = false;
    state.searchQuery = "";
    await loadDir();
    return;
  }
  state.searching = true;
  state.searchQuery = q;
  showState("loading");
  try {
    state.entries = await invoke<Entry[]>("search_files", { root: state.path, query: q });
    render();
    showState(state.filtered.length === 0 ? "empty" : "full");
    if (state.filtered.length === 0) {
      ($("empty") as HTMLElement).querySelector("h2")!.textContent = "No results";
      ($("empty") as HTMLElement).querySelector("p")!.textContent = `Nothing under this folder matches “${q}”.`;
    }
    renderStatus();
  } catch (err) {
    toast(`Search failed: ${err}`, true);
    await loadDir();
  }
}

function renderSidebar(): void {
  const quick = $("quick-list");
  quick.innerHTML = "";
  const homeDir = state.homeDir;
  const places: [string, string][] = [
    ["Home", homeDir],
    ["Desktop", `${homeDir}/Desktop`],
    ["Documents", `${homeDir}/Documents`],
    ["Downloads", `${homeDir}/Downloads`],
    ["Pictures", `${homeDir}/Pictures`],
    ["Music", `${homeDir}/Music`],
    ["Videos", `${homeDir}/Videos`],
  ];
  for (const [label, path] of places) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "nav-item";
    b.innerHTML = `${iconSvg(ICONS.folder)}${label}`;
    b.addEventListener("click", () => void navigate(path));
    quick.appendChild(b);
  }
  const dl = $("drive-list");
  dl.innerHTML = "";
  for (const d of state.drives) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "nav-item";
    b.innerHTML = `${iconSvg(ICONS.archive)}<span>${escapeHtml(d.name)}</span><span class="nav-meta">${fmtSize(d.free)} free</span>`;
    b.title = `${d.mount} · ${d.fs} · ${fmtSize(d.free)} free of ${fmtSize(d.total)}`;
    b.addEventListener("click", () => void navigate(d.mount));
    dl.appendChild(b);
  }
}

async function init(): Promise<void> {
  // Outside the Tauri shell (plain browser, link checkers) the invoke bridge
  // does not exist. Say so in the error state instead of throwing on load.
  if (!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
    $("error-text").textContent = "FileMon runs inside its desktop app. Open it from the installed app, not a browser.";
    showState("error");
    renderCrumbs();
    return;
  }
  const home = await invoke<string>("get_home");
  state.homeDir = home;
  state.drives = await invoke<Drive[]>("get_drives");
  renderSidebar();

  ($("sort-key") as HTMLSelectElement).value = state.sortKey;
  ($("show-hidden") as HTMLInputElement).checked = state.showHidden;

  $("btn-back").addEventListener("click", () => {
    if (state.histIndex > 0) {
      state.histIndex--;
      state.path = state.history[state.histIndex];
      state.selection.clear();
      void loadDir();
      updateNavButtons();
    }
  });
  $("btn-forward").addEventListener("click", () => {
    if (state.histIndex < state.history.length - 1) {
      state.histIndex++;
      state.path = state.history[state.histIndex];
      state.selection.clear();
      void loadDir();
      updateNavButtons();
    }
  });
  $("btn-up").addEventListener("click", () => {
    const p = parentOf(state.path);
    if (p !== null) void navigate(p);
  });
  $("error-retry").addEventListener("click", () => void loadDir());
  $("empty-new-folder").addEventListener("click", () => askNew("folder"));

  const search = $("search") as HTMLInputElement;
  search.addEventListener("input", () => {
    if (state.searching) return;
    state.searchQuery = search.value;
    render();
    showState(state.filtered.length === 0 ? "empty" : "full");
  });
  search.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      void runSearch();
    }
    if (ev.key === "Escape") {
      search.value = "";
      if (state.searching) void navigate(state.path, false);
      else {
        state.searchQuery = "";
        render();
        showState(state.filtered.length === 0 ? "empty" : "full");
      }
    }
  });

  $("act-new-folder").addEventListener("click", () => askNew("folder"));
  $("act-new-file").addEventListener("click", () => askNew("file"));
  $("act-cut").addEventListener("click", () => void doCopyCut("cut"));
  $("act-copy").addEventListener("click", () => void doCopyCut("copy"));
  $("act-paste").addEventListener("click", () => void doPaste());
  $("act-rename").addEventListener("click", askRename);
  $("act-delete").addEventListener("click", askDelete);
  $("act-props").addEventListener("click", () => void showProperties());

  ($("show-hidden") as HTMLInputElement).addEventListener("change", (ev) => {
    state.showHidden = (ev.target as HTMLInputElement).checked;
    localStorage.setItem("filemon-hidden", state.showHidden ? "1" : "0");
    render();
    showState(state.filtered.length === 0 ? "empty" : "full");
  });
  ($("sort-key") as HTMLSelectElement).addEventListener("change", (ev) => {
    state.sortKey = (ev.target as HTMLSelectElement).value as typeof state.sortKey;
    localStorage.setItem("filemon-sort", state.sortKey);
    render();
  });
  $("view-details").addEventListener("click", () => {
    state.view = "details";
    localStorage.setItem("filemon-view", "details");
    render();
    showState(state.filtered.length === 0 ? "empty" : "full");
  });
  $("view-icons").addEventListener("click", () => {
    state.view = "icons";
    localStorage.setItem("filemon-view", "icons");
    render();
    showState(state.filtered.length === 0 ? "empty" : "full");
  });
  document.querySelectorAll("#file-table th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => {
      const key = (th as HTMLElement).dataset.sort as typeof state.sortKey;
      if (state.sortKey === key) state.sortDir *= -1;
      else {
        state.sortKey = key;
        state.sortDir = 1;
      }
      ($("sort-key") as HTMLSelectElement).value = key;
      localStorage.setItem("filemon-sort", key);
      render();
    });
  });

  $("preview-toggle").addEventListener("click", () => setPreview(!state.previewOpen));
  $("preview-close").addEventListener("click", () => setPreview(false));

  const themeBtn = $("theme-toggle");
  const applyThemeLabel = () => {
    const light = document.documentElement.dataset.theme === "light";
    themeBtn.innerHTML = iconSvg(light ? ICONS.moon : ICONS.sun);
    themeBtn.title = light ? "Switch to dark mode" : "Switch to light mode";
    themeBtn.setAttribute("aria-label", themeBtn.title);
  };
  applyThemeLabel();
  // Re-apply the stored theme through __setTheme so the inline custom
  // properties match the attribute (see index.html: WebKitGTK restyle).
  (window as any).__setTheme(document.documentElement.dataset.theme || "dark");
  themeBtn.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    (window as any).__setTheme(next);
    applyThemeLabel();
  });

  $("file-area").addEventListener("contextmenu", (ev) => {
    if ((ev.target as HTMLElement).closest("tr, .tile")) return;
    ev.preventDefault();
    showContextMenu(ev.clientX, ev.clientY, null);
  });
  document.addEventListener("click", (ev) => {
    if (!(ev.target as HTMLElement).closest("#ctx-menu")) hideContextMenu();
  });
  document.addEventListener("keydown", (ev) => {
    const inField = (ev.target as HTMLElement).closest("input, select, textarea, dialog");
    if (ev.key === "Escape") hideContextMenu();
    if (inField) return;
    if (ev.altKey && ev.key === "ArrowLeft") {
      ev.preventDefault();
      $("btn-back").click();
    } else if (ev.altKey && ev.key === "ArrowRight") {
      ev.preventDefault();
      $("btn-forward").click();
    } else if (ev.altKey && ev.key === "ArrowUp") {
      ev.preventDefault();
      $("btn-up").click();
    } else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "c") {
      void doCopyCut("copy");
    } else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "x") {
      void doCopyCut("cut");
    } else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "v") {
      void doPaste();
    } else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "f") {
      ev.preventDefault();
      search.focus();
    } else if (ev.key === "Delete") {
      askDelete();
    } else if (ev.key === "F2") {
      ev.preventDefault();
      askRename();
    } else if (ev.key === "Enter" && state.selection.size === 1) {
      const e = selectedEntries()[0];
      if (e) void openEntry(e);
    } else if (ev.key === "Backspace") {
      const p = parentOf(state.path);
      if (p !== null) void navigate(p);
    }
  });

  ($("rename-confirm") as HTMLButtonElement).addEventListener("click", (ev) => {
    ev.preventDefault();
    void doRename();
  });
  ($("new-confirm") as HTMLButtonElement).addEventListener("click", (ev) => {
    ev.preventDefault();
    void doNew();
  });
  ($("delete-confirm") as HTMLButtonElement).addEventListener("click", (ev) => {
    ev.preventDefault();
    void doDelete();
  });
  for (const id of ["dlg-rename", "dlg-new"]) {
    ($(id) as HTMLDialogElement).addEventListener("click", (ev) => {
      if (ev.target === $(id)) ($(id) as HTMLDialogElement).close();
    });
  }

  await navigate(home);
}

void init();
