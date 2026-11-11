import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type Entry = {
  name: string;
  path: string;
  is_dir: boolean;
  is_symlink: boolean;
  size: number | null;
  modified: number | null;
  extension: string | null;
  hidden: boolean;
  original_path?: string | null;
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

type Tab = {
  id: number;
  path: string;
  history: string[];
  histIndex: number;
  view: "details" | "icons";
  sortKey: "name" | "size" | "modified" | "type";
  sortDir: number;
  isTrash: boolean;
};

const state = {
  tabs: [] as Tab[],
  activeTab: 0,
  nextTabId: 1,
  /* Path, history, view and sort live on the active tab. These accessors
     delegate to it, so the rest of the code keeps using state.path etc. */
  get path(): string {
    return state.tabs[state.activeTab]?.path ?? "";
  },
  set path(v: string) {
    if (state.tabs[state.activeTab]) state.tabs[state.activeTab].path = v;
  },
  get history(): string[] {
    return state.tabs[state.activeTab]?.history ?? [];
  },
  set history(v: string[]) {
    if (state.tabs[state.activeTab]) state.tabs[state.activeTab].history = v;
  },
  get histIndex(): number {
    return state.tabs[state.activeTab]?.histIndex ?? -1;
  },
  set histIndex(v: number) {
    if (state.tabs[state.activeTab]) state.tabs[state.activeTab].histIndex = v;
  },
  get view(): "details" | "icons" {
    return state.tabs[state.activeTab]?.view ?? "details";
  },
  set view(v: "details" | "icons") {
    if (state.tabs[state.activeTab]) state.tabs[state.activeTab].view = v;
  },
  get sortKey(): "name" | "size" | "modified" | "type" {
    return state.tabs[state.activeTab]?.sortKey ?? "name";
  },
  set sortKey(v: "name" | "size" | "modified" | "type") {
    if (state.tabs[state.activeTab]) state.tabs[state.activeTab].sortKey = v;
  },
  get sortDir(): number {
    return state.tabs[state.activeTab]?.sortDir ?? 1;
  },
  set sortDir(v: number) {
    if (state.tabs[state.activeTab]) state.tabs[state.activeTab].sortDir = v;
  },
  get isTrash(): boolean {
    return state.tabs[state.activeTab]?.isTrash ?? false;
  },
  set isTrash(v: boolean) {
    if (state.tabs[state.activeTab]) state.tabs[state.activeTab].isTrash = v;
  },
  entries: [] as Entry[],
  filtered: [] as Entry[],
  selection: new Set<string>(),
  clipboard: null as { mode: "copy" | "cut"; paths: string[] } | null,
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
  undo: '<path d="M6.5 3.5L3 7l3.5 3.5"/><path d="M3 7h6a4 4 0 0 1 0 8H7"/>',
};

function isImageEntry(e: Entry): boolean {
  if (e.is_dir) return false;
  switch (e.extension) {
    case "png": case "jpg": case "jpeg": case "gif": case "webp": case "svg": case "bmp":
      return true;
    default:
      return false;
  }
}

function iconFor(e: Entry): string {
  if (e.is_dir) return ICONS.folder;
  if (isImageEntry(e)) return ICONS.image;
  switch (e.extension) {
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
  state.isTrash = false;
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
  if (state.isTrash) {
    ($("btn-back") as HTMLButtonElement).disabled = true;
    ($("btn-forward") as HTMLButtonElement).disabled = true;
    ($("btn-up") as HTMLButtonElement).disabled = true;
    return;
  }
  ($("btn-back") as HTMLButtonElement).disabled = state.histIndex <= 0;
  ($("btn-forward") as HTMLButtonElement).disabled = state.histIndex >= state.history.length - 1;
  ($("btn-up") as HTMLButtonElement).disabled = parentOf(state.path) === null;
}

/* ---- Tabs ---- */

function cur(): Tab {
  return state.tabs[state.activeTab];
}

function tabTitle(t: Tab): string {
  if (t.isTrash) return "Trash";
  if (t.path === "/") return "This PC";
  const name = t.path.replace(/\/+$/, "").split("/").pop() ?? "";
  return name || "This PC";
}

function saveTabs(): void {
  try {
    localStorage.setItem(
      "filemon-tabs",
      JSON.stringify(
        state.tabs.map((t) => ({
          path: t.path,
          view: t.view,
          sortKey: t.sortKey,
          sortDir: t.sortDir,
          isTrash: t.isTrash,
        })),
      ),
    );
    localStorage.setItem("filemon-active-tab", String(state.activeTab));
  } catch {
    /* storage unavailable — tabs still work for this session */
  }
}

function restoreTabs(home: string): void {
  let saved: { path: string; view: Tab["view"]; sortKey: Tab["sortKey"]; sortDir: number; isTrash?: boolean }[] = [];
  try {
    const raw = JSON.parse(localStorage.getItem("filemon-tabs") ?? "[]");
    if (Array.isArray(raw)) saved = raw;
  } catch {
    saved = [];
  }
  // First run (or pre-tabs install): one tab at Home, keeping the stored
  // global view/sort as its defaults.
  const view = (localStorage.getItem("filemon-view") as Tab["view"]) || "details";
  const sortKey = (localStorage.getItem("filemon-sort") as Tab["sortKey"]) || "name";
  const list = saved.filter((t) => typeof t?.path === "string" && t.path.startsWith("/"));
  const seeds = list.length > 0 ? list : [{ path: home, view, sortKey, sortDir: 1, isTrash: false }];
  state.tabs = seeds.map((t) => ({
    id: state.nextTabId++,
    path: t.path,
    history: [t.path],
    histIndex: 0,
    view: t.view === "icons" ? "icons" : "details",
    sortKey: (["name", "size", "modified", "type"].includes(t.sortKey) ? t.sortKey : "name") as Tab["sortKey"],
    sortDir: t.sortDir === -1 ? -1 : 1,
    isTrash: t.isTrash === true,
  }));
  const active = Number(localStorage.getItem("filemon-active-tab") ?? "0");
  state.activeTab = active >= 0 && active < state.tabs.length ? active : 0;
}

function renderTabs(): void {
  const bar = $("tab-bar");
  bar.innerHTML = "";
  state.tabs.forEach((t, i) => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "tab" + (i === state.activeTab ? " is-active" : "");
    el.setAttribute("role", "tab");
    el.setAttribute("aria-selected", String(i === state.activeTab));
    el.title = t.path;
    const label = document.createElement("span");
    label.className = "tab-label";
    label.textContent = tabTitle(t);
    const x = document.createElement("span");
    x.className = "tab-close";
    x.textContent = "×";
    x.title = "Close tab (Ctrl+W)";
    x.addEventListener("click", (ev) => {
      ev.stopPropagation();
      void closeTab(i);
    });
    el.append(label, x);
    el.addEventListener("click", () => void switchTab(i));
    el.addEventListener("auxclick", (ev) => {
      if (ev.button === 1) {
        ev.preventDefault();
        void closeTab(i);
      }
    });
    // Dropping files onto a tab moves/copies them into that tab's folder.
    attachDropTarget(el, () => t.path);
    bar.appendChild(el);
  });
  const plus = document.createElement("button");
  plus.type = "button";
  plus.className = "tab-new";
  plus.textContent = "+";
  plus.title = "New tab (Ctrl+T)";
  plus.setAttribute("aria-label", "New tab");
  plus.addEventListener("click", () => void newTab());
  bar.appendChild(plus);
  saveTabs();
}

async function switchTab(i: number): Promise<void> {
  if (i === state.activeTab || i < 0 || i >= state.tabs.length) return;
  state.activeTab = i;
  state.selection.clear();
  state.searching = false;
  state.searchQuery = "";
  ($("search") as HTMLInputElement).value = "";
  ($("sort-key") as HTMLSelectElement).value = state.sortKey;
  renderTabs();
  await loadDir();
  updateNavButtons();
}

/** New tab at `path` (default: the current folder), inheriting view/sort. */
function newTab(path = state.path): void {
  const src = cur();
  state.tabs.push({
    id: state.nextTabId++,
    path,
    history: [path],
    histIndex: 0,
    view: src.view,
    sortKey: src.sortKey,
    sortDir: src.sortDir,
    isTrash: false,
  });
  void switchTab(state.tabs.length - 1);
}

async function closeTab(i: number): Promise<void> {
  if (state.tabs.length === 1) {
    // Last tab: replace it with a fresh one at Home instead of closing the window.
    const t = state.tabs[0];
    t.isTrash = false;
    t.path = state.homeDir;
    t.history = [state.homeDir];
    t.histIndex = 0;
    renderTabs();
    await loadDir();
    updateNavButtons();
    return;
  }
  state.tabs.splice(i, 1);
  if (i < state.activeTab) {
    state.activeTab--;
    renderTabs();
  } else if (i === state.activeTab) {
    state.activeTab = Math.min(i, state.tabs.length - 1);
    state.selection.clear();
    renderTabs();
    await loadDir();
    updateNavButtons();
  } else {
    renderTabs();
  }
}

function openInNewTab(path: string): void {
  newTab(path);
}

/** Switch the active tab to the Trash (the freedesktop Trash, not a folder). */
async function openTrash(): Promise<void> {
  state.isTrash = true;
  state.selection.clear();
  state.searching = false;
  state.searchQuery = "";
  ($("search") as HTMLInputElement).value = "";
  await loadDir();
  updateNavButtons();
}

async function doRestore(): Promise<void> {
  const paths = [...state.selection];
  if (paths.length === 0) return;
  try {
    const n = await invoke<number>("restore_trash", { paths });
    state.selection.clear();
    toast(`${n} item${n === 1 ? "" : "s"} restored`);
    await loadDir();
  } catch (err) {
    toast(`Restore failed: ${err}`, true);
  }
}

async function doDeletePermanent(): Promise<void> {
  const paths = [...state.selection];
  if (paths.length === 0) return;
  // The confirm button preventDefaults the form submit (which would close
  // the dialog), so dismiss it here: confirming ends the dialog's job.
  ($("dlg-delete") as HTMLDialogElement).close();
  try {
    const n = await invoke<number>("delete_trash", { paths });
    state.selection.clear();
    toast(`${n} item${n === 1 ? "" : "s"} permanently deleted`);
    await loadDir();
  } catch (err) {
    toast(`Delete failed: ${err}`, true);
  }
}

async function doEmptyTrash(): Promise<void> {
  // The confirm button preventDefaults the form submit (which would close
  // the dialog), so dismiss it here: confirming ends the dialog's job.
  ($("dlg-delete") as HTMLDialogElement).close();
  try {
    const n = await invoke<number>("empty_trash");
    state.selection.clear();
    toast(n === 0 ? "Trash is already empty" : `Trash emptied (${n} item${n === 1 ? "" : "s"})`);
    await loadDir();
  } catch (err) {
    toast(`Empty Trash failed: ${err}`, true);
  }
}

/** Move files to the Trash (drop target of the sidebar Trash item). */
async function trashPaths(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  try {
    const n = await invoke<number>("delete_paths", { paths });
    state.selection.clear();
    toast(`${n} item${n === 1 ? "" : "s"} moved to Trash`);
    await loadDir();
  } catch (err) {
    toast(`Delete failed: ${err}`, true);
  }
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
  if (state.isTrash) {
    const b = document.createElement("span");
    b.className = "crumb";
    b.textContent = "Trash";
    nav.appendChild(b);
    $("side-path").textContent = "Trash";
    return;
  }
  const parts = state.path.split("/").filter(Boolean);
  const mk = (label: string, path: string) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "crumb";
    b.textContent = label;
    b.dataset.path = path;
    b.addEventListener("click", () => void navigate(path));
    attachDropTarget(b, () => b.dataset.path ?? null);
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
    // Trashed items cannot be dragged out (Restore is the way back); that
    // also keeps the .trashinfo from being orphaned by a move.
    tr.draggable = !state.isTrash;
    tr.addEventListener("dragstart", (ev) => onDragStart(ev, e, tr));
    tr.addEventListener("dragend", () => onDragEnd(tr));
    if (e.is_dir) attachDropTarget(tr, () => e.path);
    const nameTd = document.createElement("td");
    // NB: .cell-name is display:flex — it must wrap the content in a div.
    // Putting it on the td itself turns the cell into a flex box, and
    // WebKitGTK then drops that cell's collapsed bottom border, so the row
    // dividers looked cut under the Name column.
    nameTd.innerHTML = `<div class="cell-name">${iconSvg(iconFor(e), "icon file-icon" + (e.is_dir ? " is-dir" : ""))}<div class="cell-name-text"><span class="file-name">${escapeHtml(e.name)}</span>${state.isTrash && e.original_path ? `<span class="file-sub" title="${escapeHtml(e.original_path)}">${escapeHtml(e.original_path)}</span>` : ""}</div></div>`;
    const modTd = document.createElement("td");
    modTd.textContent = fmtDate(e.modified);
    const typeTd = document.createElement("td");
    typeTd.textContent = kindLabel(e);
    const sizeTd = document.createElement("td");
    sizeTd.className = "num";
    sizeTd.textContent = e.is_dir ? "—" : fmtSize(e.size ?? 0);
    tr.append(nameTd, modTd, typeTd, sizeTd);
    tr.addEventListener("click", (ev) => onRowClick(ev, e));
    tr.addEventListener("dblclick", (ev) => {
      if (ev.ctrlKey || ev.metaKey) void openEntry(e, true);
      else void openEntry(e);
    });
    tr.addEventListener("auxclick", (ev) => {
      if (ev.button === 1 && e.is_dir) {
        ev.preventDefault();
        void openEntry(e, true);
      }
    });
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
    tile.draggable = !state.isTrash;
    tile.addEventListener("dragstart", (ev) => onDragStart(ev, e, tile));
    tile.addEventListener("dragend", () => onDragEnd(tile));
    if (e.is_dir) attachDropTarget(tile, () => e.path);
    // Image files show a real thumbnail over the generic icon. The icon
    // stays underneath as the fallback: a broken or unsupported image just
    // drops its <img> and the icon shows through.
    const iconWrap = document.createElement("span");
    iconWrap.className = "tile-thumb-wrap";
    iconWrap.innerHTML = iconSvg(iconFor(e), "icon tile-icon" + (e.is_dir ? " is-dir" : ""));
    if (isImageEntry(e)) {
      const img = document.createElement("img");
      img.className = "tile-thumb";
      img.alt = "";
      img.loading = "lazy";
      img.src = convertFileSrc(e.path);
      img.addEventListener("error", () => img.remove());
      iconWrap.appendChild(img);
    }
    const nameEl = document.createElement("span");
    nameEl.className = "tile-name";
    nameEl.textContent = e.name;
    tile.append(iconWrap, nameEl);
    if (state.isTrash && e.original_path) tile.title = e.original_path;
    tile.addEventListener("click", (ev) => onRowClick(ev, e));
    tile.addEventListener("dblclick", (ev) => {
      if (ev.ctrlKey || ev.metaKey) void openEntry(e, true);
      else void openEntry(e);
    });
    tile.addEventListener("auxclick", (ev) => {
      if (ev.button === 1 && e.is_dir) {
        ev.preventDefault();
        void openEntry(e, true);
      }
    });
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

/* ---- Drag & drop ---- */

const DND_MIME = "application/x-filemon-paths";
// Paths of the drag currently in flight (module state, not app state).
// Needed because dataTransfer.getData is blocked during dragover.
let dragPaths: string[] | null = null;
let currentDropTarget: HTMLElement | null = null;

function markDropTarget(el: HTMLElement | null): void {
  if (currentDropTarget === el) return;
  currentDropTarget?.classList.remove("drop-target");
  currentDropTarget = el;
  el?.classList.add("drop-target");
}

function isInternalDrag(ev: DragEvent): boolean {
  if (dragPaths !== null) return true;
  return Array.from(ev.dataTransfer?.types ?? []).includes(DND_MIME);
}

function dropPaths(ev: DragEvent): string[] | null {
  const raw = ev.dataTransfer?.getData(DND_MIME);
  if (raw) {
    try {
      const p: unknown = JSON.parse(raw);
      if (Array.isArray(p)) return p as string[];
    } catch {
      /* fall through to module state */
    }
  }
  return dragPaths;
}

function onDragStart(ev: DragEvent, e: Entry, el: HTMLElement): void {
  // Explorer behaviour: dragging an unselected item drags just it (and selects it).
  if (!state.selection.has(e.path)) {
    state.selection.clear();
    state.selection.add(e.path);
    renderSelection();
  }
  dragPaths = [...state.selection];
  if (ev.dataTransfer) {
    ev.dataTransfer.setData(DND_MIME, JSON.stringify(dragPaths));
    ev.dataTransfer.setData("text/plain", dragPaths.join("\n"));
    ev.dataTransfer.effectAllowed = "copyMove";
  }
  el.classList.add("dragging");
}

function onDragEnd(el: HTMLElement): void {
  dragPaths = null;
  el.classList.remove("dragging");
  markDropTarget(null);
}

/** Make an element a drop target for a folder: crumbs, sidebar items, folder rows/tiles. */
function attachDropTarget(el: HTMLElement, getDest: () => string | null): void {
  el.addEventListener("dragover", (ev) => {
    if (!isInternalDrag(ev)) return;
    ev.preventDefault();
    ev.stopPropagation();
    ev.dataTransfer!.dropEffect = ev.ctrlKey ? "copy" : "move";
    markDropTarget(el);
  });
  el.addEventListener("drop", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    markDropTarget(null);
    const dest = getDest();
    const paths = dropPaths(ev);
    if (!dest || !paths) return;
    void performDrop(paths, dest, ev.ctrlKey);
  });
}

async function performDrop(paths: string[], dest: string, copy: boolean): Promise<void> {
  const parentOfPath = (p: string): string => {
    const i = p.lastIndexOf("/");
    return i <= 0 ? "/" : p.slice(0, i);
  };
  // A folder cannot be dropped into itself or one of its subfolders
  // (copy_dir_recursive would recurse forever on that).
  if (paths.some((p) => dest === p || dest.startsWith(p + "/"))) {
    toast("Cannot move a folder into itself", true);
    return;
  }
  const moving = paths.filter((p) => parentOfPath(p) !== dest);
  if (moving.length === 0) return; // already in this folder — silent no-op
  await runTransfer(moving, dest, copy);
}

/* ---- Transfer progress ---- */

type TransferProgress = {
  done_bytes: number;
  total_bytes: number;
  current: string;
  done_files: number;
  total_files: number;
};

type TransferOutcome = { done: number; cancelled: boolean };

let transferRunning = false;
let transferStart = 0;
let transferTimer = 0;

/**
 * Copy/move with a progress panel. Fast transfers never show the panel
 * (400 ms grace); slow ones show file, bytes and a Cancel button.
 * Returns the outcome, or null when the transfer itself errored.
 */
async function runTransfer(paths: string[], dest: string, copy: boolean): Promise<TransferOutcome | null> {
  transferRunning = true;
  transferStart = Date.now();
  ($("transfer-title") as HTMLElement).textContent = copy ? "Copying…" : "Moving…";
  ($("transfer-cancel") as HTMLButtonElement).disabled = false;
  transferTimer = window.setTimeout(() => {
    if (transferRunning) $("transfer-panel").hidden = false;
  }, 400);
  try {
    const outcome = await invoke<TransferOutcome>("start_transfer", { paths, dest, copy });
    if (outcome.cancelled) toast("Transfer cancelled");
    else toast(`${outcome.done} item${outcome.done === 1 ? "" : "s"} ${copy ? "copied" : "moved"}`);
    state.selection.clear();
    await loadDir();
    return outcome;
  } catch (err) {
    toast(`Transfer failed: ${err}`, true);
    await loadDir();
    return null;
  } finally {
    transferRunning = false;
    window.clearTimeout(transferTimer);
    $("transfer-panel").hidden = true;
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
  // Trash mode swaps the file-action buttons for Restore / Delete permanently.
  for (const id of ["act-new-folder", "act-new-file", "act-cut", "act-copy", "act-paste", "act-rename", "act-delete", "act-props"]) {
    ($(id) as HTMLButtonElement).hidden = state.isTrash;
  }
  ($("act-restore") as HTMLButtonElement).hidden = !state.isTrash;
  ($("act-delete-permanent") as HTMLButtonElement).hidden = !state.isTrash;
  ($("act-restore") as HTMLButtonElement).disabled = !has;
  ($("act-delete-permanent") as HTMLButtonElement).disabled = !has;
  ($("act-empty-trash") as HTMLButtonElement).hidden = !state.isTrash;
  ($("act-empty-trash") as HTMLButtonElement).disabled = state.entries.length === 0;
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
  renderTabs();
  renderTable();
  renderGrid();
  renderStatus();
  renderSelection();
  updateTrashNav();
  $("table-wrap").hidden = state.view !== "details";
  $("grid-wrap").hidden = state.view !== "icons";
  $("view-details").classList.toggle("is-active", state.view === "details");
  $("view-icons").classList.toggle("is-active", state.view === "icons");
  // In Trash the Date column is the deletion date, not the modification date.
  const dateTh = document.querySelector('#file-table th[data-sort="modified"]');
  if (dateTh) dateTh.textContent = state.isTrash ? "Date deleted" : "Date modified";
  const dateOpt = document.querySelector('#sort-key option[value="modified"]');
  if (dateOpt) dateOpt.textContent = state.isTrash ? "Date deleted" : "Date modified";
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
    const entries = state.isTrash
      ? await invoke<Entry[]>("list_trash")
      : await invoke<Entry[]>("list_dir", { path: state.path });
    state.entries = entries;
    render();
    const emptyEl = $("empty") as HTMLElement;
    if (state.isTrash) {
      emptyEl.querySelector("h2")!.textContent = "Trash is empty";
      emptyEl.querySelector("p")!.textContent = "Deleted items will appear here. You can restore them or delete them permanently.";
      ($("empty-new-folder") as HTMLButtonElement).hidden = true;
    } else {
      emptyEl.querySelector("h2")!.textContent = "This folder is empty";
      emptyEl.querySelector("p")!.textContent = "Nothing here yet. Create a folder or paste files into it.";
      ($("empty-new-folder") as HTMLButtonElement).hidden = false;
    }
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

async function openEntry(e: Entry, newTab = false): Promise<void> {
  if (e.is_dir) {
    // A trashed folder has no inside to browse: Restore is the way back.
    if (state.isTrash) return;
    if (newTab) openInNewTab(e.path);
    else await navigate(e.path);
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
  const outcome = await runTransfer(cb.paths, state.path, cb.mode === "copy");
  // A cancelled cut keeps its clipboard: the files never all moved.
  if (outcome && !outcome.cancelled && cb.mode === "cut") state.clipboard = null;
}

async function doCompress(): Promise<void> {
  const paths = [...state.selection];
  if (paths.length === 0) return;
  try {
    const name = await invoke<string>("compress_paths", { paths, dest: state.path });
    toast(`Archive created: ${name}`);
    await loadDir();
  } catch (err) {
    toast(`Compress failed: ${err}`, true);
  }
}

async function doExtract(): Promise<void> {
  const [path] = [...state.selection];
  if (!path) return;
  try {
    const folder = await invoke<string>("extract_archive", { path, dest: state.path });
    toast(`Extracted to ${folder}`);
    await loadDir();
  } catch (err) {
    toast(`Extract failed: ${err}`, true);
  }
}

function askDelete(): void {
  const items = selectedEntries();
  if (items.length === 0) return;
  if (state.isTrash) {
    // In Trash, Delete means delete permanently, not "move to Trash" again.
    deleteMode = "permanent";
    ($("delete-title") as HTMLElement).textContent = "Delete permanently?";
    $("delete-text").textContent =
      items.length === 1
        ? `“${items[0].name}” will be permanently deleted. This cannot be undone.`
        : `${items.length} items will be permanently deleted. This cannot be undone.`;
    ($("dlg-delete") as HTMLDialogElement).showModal();
    return;
  }
  deleteMode = "trash";
  ($("delete-title") as HTMLElement).textContent = "Move to Trash?";
  $("delete-text").textContent =
    items.length === 1
      ? `“${items[0].name}” will be moved to the Trash. You can restore it from there.`
      : `${items.length} items will be moved to the Trash. You can restore them from there.`;
  ($("dlg-delete") as HTMLDialogElement).showModal();
}

function askEmptyTrash(): void {
  deleteMode = "empty";
  ($("delete-title") as HTMLElement).textContent = "Empty Trash?";
  $("delete-text").textContent = `All ${state.entries.length} item${state.entries.length === 1 ? "" : "s"} in the Trash will be permanently deleted. This cannot be undone.`;
  ($("dlg-delete") as HTMLDialogElement).showModal();
}

// Which confirm the delete dialog is asking for (see askDelete / askEmptyTrash).
let deleteMode: "trash" | "permanent" | "empty" = "trash";

async function doDelete(): Promise<void> {
  const paths = [...state.selection];
  // The confirm button preventDefaults the form submit (which would close
  // the dialog), so dismiss it here: confirming ends the dialog's job.
  ($("dlg-delete") as HTMLDialogElement).close();
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
    ($("dlg-rename") as HTMLDialogElement).close();
    toast(`Renamed to ${name}`);
    await loadDir();
  } catch (err) {
    // Dialog stays open (the confirm button preventDefaults the form submit),
    // so the user can correct the name in place.
    const el = $("rename-error");
    el.textContent = String(err);
    el.hidden = false;
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
    ($("dlg-new") as HTMLDialogElement).close();
    toast(newKind === "folder" ? "Folder created" : "File created");
    await loadDir();
  } catch (err) {
    // Dialog stays open (the confirm button preventDefaults the form submit),
    // so the user can correct the name in place.
    const el = $("new-error");
    el.textContent = String(err);
    el.hidden = false;
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
  if (state.isTrash) {
    if (target) {
      items.push({ label: "Restore", action: () => void doRestore() });
      items.push({ label: "Delete permanently", action: askDelete });
    } else {
      items.push({ label: "Empty Trash", disabled: state.entries.length === 0, action: askEmptyTrash });
    }
  } else if (target) {
    items.push({ label: "Open", action: () => void openEntry(target) });
    if (target.is_dir) items.push({ label: "Open in new tab", action: () => void openInNewTab(target.path) });
    items.push({ label: "Copy", action: () => void doCopyCut("copy") });
    items.push({ label: "Cut", action: () => void doCopyCut("cut") });
    items.push({ label: "Compress to ZIP", action: () => void doCompress() });
    if (state.selection.size === 1 && (target.extension ?? "").toLowerCase() === "zip") {
      items.push({ label: "Extract here", action: () => void doExtract() });
    }
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
  if (state.isTrash) {
    // The name filter above already works in Trash; the everywhere search
    // needs a real folder root, so it is not available here.
    if (q) toast("Search is not available in Trash — filter by name instead");
    return;
  }
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

function updateTrashNav(): void {
  document.querySelectorAll("#trash-list .nav-item").forEach((b) => {
    b.classList.toggle("is-active", state.isTrash);
  });
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
    attachDropTarget(b, () => path);
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
    attachDropTarget(b, () => d.mount);
    dl.appendChild(b);
  }
  // Trash: a virtual location (the freedesktop Trash), not a folder.
  // Dropping files onto it deletes them — same as dragging to the Recycle Bin.
  const tl = $("trash-list");
  tl.innerHTML = "";
  const trashBtn = document.createElement("button");
  trashBtn.type = "button";
  trashBtn.className = "nav-item" + (state.isTrash ? " is-active" : "");
  trashBtn.innerHTML = `${iconSvg(ICONS.trash)}Trash`;
  trashBtn.addEventListener("click", () => void openTrash());
  trashBtn.addEventListener("dragover", (ev) => {
    if (!isInternalDrag(ev)) return;
    ev.preventDefault();
    ev.dataTransfer!.dropEffect = "move";
    markDropTarget(trashBtn);
  });
  trashBtn.addEventListener("drop", (ev) => {
    ev.preventDefault();
    markDropTarget(null);
    const paths = dropPaths(ev);
    if (paths) void trashPaths(paths);
  });
  tl.appendChild(trashBtn);
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
  restoreTabs(home);

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
  $("act-restore").addEventListener("click", () => void doRestore());
  $("act-delete-permanent").addEventListener("click", askDelete);
  $("act-empty-trash").addEventListener("click", askEmptyTrash);

  ($("show-hidden") as HTMLInputElement).addEventListener("change", (ev) => {
    state.showHidden = (ev.target as HTMLInputElement).checked;
    localStorage.setItem("filemon-hidden", state.showHidden ? "1" : "0");
    render();
    showState(state.filtered.length === 0 ? "empty" : "full");
  });
  ($("sort-key") as HTMLSelectElement).addEventListener("change", (ev) => {
    state.sortKey = (ev.target as HTMLSelectElement).value as typeof state.sortKey;
    saveTabs();
    render();
  });
  $("view-details").addEventListener("click", () => {
    state.view = "details";
    saveTabs();
    render();
    showState(state.filtered.length === 0 ? "empty" : "full");
  });
  $("view-icons").addEventListener("click", () => {
    state.view = "icons";
    saveTabs();
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
      saveTabs();
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
  // Drop onto the file area background = the current folder.
  // (Rows/tiles stop propagation, so this only fires for empty space.)
  const fileArea = $("file-area");
  fileArea.addEventListener("dragover", (ev) => {
    if (!isInternalDrag(ev)) return;
    if ((ev.target as HTMLElement).closest("tbody tr, .tile")) return;
    ev.preventDefault();
    ev.dataTransfer!.dropEffect = ev.ctrlKey ? "copy" : "move";
    markDropTarget(fileArea);
  });
  fileArea.addEventListener("drop", (ev) => {
    ev.preventDefault();
    markDropTarget(null);
    if (state.isTrash) return;
    const paths = dropPaths(ev);
    if (!paths) return;
    void performDrop(paths, state.path, ev.ctrlKey);
  });
  // Files dragged in from another app arrive as Tauri's built-in
  // tauri://drag-* window events (no Rust code needed — drag-drop is on by
  // default). They are copied into the current folder, never moved: the
  // source app's intent is unknowable, so copy is the safe default.
  void listen<{ paths: string[]; position: { x: number; y: number } }>("tauri://drag-drop", (ev) => {
    $("drop-overlay").hidden = true;
    if (state.isTrash) return;
    void performDrop(ev.payload.paths, state.path, true);
  });
  void listen("tauri://drag-enter", () => {
    ($("drop-overlay-path") as HTMLElement).textContent = state.path;
    $("drop-overlay").hidden = false;
  });
  void listen("tauri://drag-leave", () => {
    $("drop-overlay").hidden = true;
  });
  void listen<TransferProgress>("transfer-progress", (ev) => {
    const p = ev.payload;
    if (!transferRunning) return;
    if (Date.now() - transferStart > 400) $("transfer-panel").hidden = false;
    const bar = $("transfer-bar") as HTMLProgressElement;
    bar.max = Math.max(p.total_bytes, 1);
    bar.value = p.done_bytes;
    $("transfer-file").textContent = p.current;
    $("transfer-count").textContent = `${p.done_files} of ${p.total_files} files`;
    $("transfer-bytes").textContent = `${fmtSize(p.done_bytes)} of ${fmtSize(p.total_bytes)}`;
  });
  $("transfer-cancel").addEventListener("click", () => {
    ($("transfer-cancel") as HTMLButtonElement).disabled = true;
    void invoke("cancel_transfer");
  });
  // Never let the webview navigate away when a file is dropped on it.
  window.addEventListener("dragover", (ev) => ev.preventDefault());
  window.addEventListener("drop", (ev) => ev.preventDefault());
  document.addEventListener("click", (ev) => {
    if (!(ev.target as HTMLElement).closest("#ctx-menu")) hideContextMenu();
  });
  document.addEventListener("keydown", (ev) => {
    const inField = (ev.target as HTMLElement).closest("input, select, textarea, dialog");
    if (ev.key === "Escape") hideContextMenu();
    // Tab shortcuts work even from the search box.
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "t") {
      ev.preventDefault();
      newTab();
      return;
    }
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "w") {
      ev.preventDefault();
      void closeTab(state.activeTab);
      return;
    }
    if (ev.ctrlKey && ev.key === "Tab") {
      ev.preventDefault();
      void switchTab((state.activeTab + (ev.shiftKey ? state.tabs.length - 1 : 1)) % state.tabs.length);
      return;
    }
    if (ev.ctrlKey && (ev.key === "PageUp" || ev.key === "PageDown")) {
      ev.preventDefault();
      void switchTab(
        (state.activeTab + (ev.key === "PageUp" ? state.tabs.length - 1 : 1)) % state.tabs.length,
      );
      return;
    }
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
    if (deleteMode === "permanent") void doDeletePermanent();
    else if (deleteMode === "empty") void doEmptyTrash();
    else void doDelete();
  });
  for (const id of ["dlg-rename", "dlg-new", "dlg-delete"]) {
    ($(id) as HTMLDialogElement).addEventListener("click", (ev) => {
      if (ev.target === $(id)) ($(id) as HTMLDialogElement).close();
    });
  }

  // Restore the active tab's folder (or the Trash); fall back to Home if
  // the restored folder no longer exists.
  if (state.isTrash) {
    state.selection.clear();
    await loadDir();
    updateNavButtons();
  } else {
    await navigate(state.path, false);
    if (!($("error") as HTMLElement).hidden) {
      state.path = home;
      state.history = [home];
      state.histIndex = 0;
      await loadDir();
      updateNavButtons();
    }
  }
}

void init();
