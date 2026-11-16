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
  device?: string;
  mounted?: boolean;
};

type GitRepoInfo = {
  root: string;
  branch: string;
  is_clean: boolean;
  ahead: number;
  behind: number;
  statuses: Record<string, string>;
  dir_statuses: Record<string, string>;
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

type TagKey = "red" | "orange" | "yellow" | "green" | "blue" | "purple";

interface TagDef {
  key: TagKey;
  label: string;
  color: string;
  lightColor: string;
}

const TAG_DEFS: Record<TagKey, TagDef> = {
  red: { key: "red", label: "Red", color: "#ef4444", lightColor: "#dc2626" },
  orange: { key: "orange", label: "Orange", color: "#f97316", lightColor: "#ea580c" },
  yellow: { key: "yellow", label: "Yellow", color: "#eab308", lightColor: "#ca8a04" },
  green: { key: "green", label: "Green", color: "#22c55e", lightColor: "#16a34a" },
  blue: { key: "blue", label: "Blue", color: "#3b82f6", lightColor: "#2563eb" },
  purple: { key: "purple", label: "Purple", color: "#a855f7", lightColor: "#9333ea" },
};
const ALL_TAGS: TagKey[] = ["red", "orange", "yellow", "green", "blue", "purple"];

type Tab = {
  id: number;
  path: string;
  history: string[];
  histIndex: number;
  view: "details" | "icons";
  sortKey: "name" | "size" | "modified" | "type";
  sortDir: number;
  isTrash: boolean;
  tag?: TagKey | null;
  zoom: 0 | 1 | 2;
  groupBy: "none" | "type" | "date" | "size";
};

/* A pane is one independent browser: its own tabs, listing, selection and
   search state. Single-pane mode is just panes[0]; dual pane adds panes[1].
   The state proxies below delegate to the active pane, so the rest of the
   code keeps using state.tabs / state.path / state.selection as before. */
type ContentMatch = {
  entry: Entry;
  line: number;
  snippet: string;
};

type DupeGroup = {
  size: number;
  entries: Entry[];
};

type AppInfo = {
  name: string;
  exec: string;
  mime_types: string[];
  desktop: string;
};

type ListFilter = {
  kind: string;
  ext: string;
  minSize: number | null; // bytes
  maxSize: number | null; // bytes
  after: string | null; // yyyy-mm-dd
  before: string | null; // yyyy-mm-dd
};

type ClosedTab = {
  path: string;
  view: Tab["view"];
  sortKey: Tab["sortKey"];
  sortDir: number;
  isTrash: boolean;
  tag?: TagKey | null;
  zoom: Tab["zoom"];
  groupBy: Tab["groupBy"];
};

type CompareRow = { entry: Entry; status: "only-here" | "only-there" | "different" };

type CompareResult = {
  only_a: Entry[];
  only_b: Entry[];
  different: Entry[];
  same: number;
};

type Pane = {
  tabs: Tab[];
  activeTab: number;
  nextTabId: number;
  entries: Entry[];
  filtered: Entry[];
  selection: Set<string>;
  searching: boolean;
  searchQuery: string;
  anchor: string | null;
  contentMode: boolean;
  contentMatches: Map<string, { line: number; snippet: string }> | null;
  dupeGroups: DupeGroup[] | null;
  // Group headers the user collapsed in this listing, by group key.
  // Cleared on every loadDir so a new folder starts with all groups open.
  collapsedGroups: Set<string>;
  // Advanced filters (toolbar Filter button), session-only.
  filter: ListFilter;
  // Tabs closed with Ctrl+W / middle-click, newest last (cap 10);
  // Ctrl+Shift+T restores the most recent one.
  closedTabs: ClosedTab[];
  // Folder comparison (dual pane): rows carry which side they belong to,
  // relative to this pane. Null when not comparing.
  compareRows: CompareRow[] | null;
  compareSummary: string | null;
};

function makePane(): Pane {
  return {
    tabs: [],
    activeTab: 0,
    nextTabId: 1,
    entries: [],
    filtered: [],
    selection: new Set<string>(),
    searching: false,
    searchQuery: "",
    anchor: null,
    contentMode: false,
    contentMatches: null,
    dupeGroups: null,
    collapsedGroups: new Set<string>(),
    filter: { kind: "all", ext: "", minSize: null, maxSize: null, after: null, before: null },
    closedTabs: [],
    compareRows: null,
    compareSummary: null,
  };
}

const state = {
  panes: [makePane()],
  activePane: 0,
  get pane(): Pane {
    return state.panes[state.activePane];
  },
  get tabs(): Tab[] {
    return state.pane.tabs;
  },
  set tabs(v: Tab[]) {
    state.pane.tabs = v;
  },
  get activeTab(): number {
    return state.pane.activeTab;
  },
  set activeTab(v: number) {
    state.pane.activeTab = v;
  },
  get nextTabId(): number {
    return state.pane.nextTabId;
  },
  set nextTabId(v: number) {
    state.pane.nextTabId = v;
  },
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
  get zoom(): 0 | 1 | 2 {
    return state.tabs[state.activeTab]?.zoom ?? 1;
  },
  set zoom(v: 0 | 1 | 2) {
    if (state.tabs[state.activeTab]) state.tabs[state.activeTab].zoom = v;
  },
  get groupBy(): "none" | "type" | "date" | "size" {
    return state.tabs[state.activeTab]?.groupBy ?? "none";
  },
  set groupBy(v: "none" | "type" | "date" | "size") {
    if (state.tabs[state.activeTab]) state.tabs[state.activeTab].groupBy = v;
  },
  get isTrash(): boolean {
    return state.tabs[state.activeTab]?.isTrash ?? false;
  },
  set isTrash(v: boolean) {
    if (state.tabs[state.activeTab]) state.tabs[state.activeTab].isTrash = v;
  },
  get tag(): TagKey | null {
    return state.tabs[state.activeTab]?.tag ?? null;
  },
  set tag(v: TagKey | null) {
    if (state.tabs[state.activeTab]) state.tabs[state.activeTab].tag = v;
  },
  get entries(): Entry[] {
    return state.pane.entries;
  },
  set entries(v: Entry[]) {
    state.pane.entries = v;
  },
  get filtered(): Entry[] {
    return state.pane.filtered;
  },
  set filtered(v: Entry[]) {
    state.pane.filtered = v;
  },
  get selection(): Set<string> {
    return state.pane.selection;
  },
  set selection(v: Set<string>) {
    state.pane.selection = v;
  },
  get searching(): boolean {
    return state.pane.searching;
  },
  set searching(v: boolean) {
    state.pane.searching = v;
  },
  get searchQuery(): string {
    return state.pane.searchQuery;
  },
  set searchQuery(v: string) {
    state.pane.searchQuery = v;
  },
  get anchor(): string | null {
    return state.pane.anchor;
  },
  set anchor(v: string | null) {
    state.pane.anchor = v;
  },
  get contentMode(): boolean {
    return state.pane.contentMode;
  },
  set contentMode(v: boolean) {
    state.pane.contentMode = v;
  },
  get contentMatches(): Map<string, { line: number; snippet: string }> | null {
    return state.pane.contentMatches;
  },
  set contentMatches(v: Map<string, { line: number; snippet: string }> | null) {
    state.pane.contentMatches = v;
  },
  get dupeGroups(): DupeGroup[] | null {
    return state.pane.dupeGroups;
  },
  set dupeGroups(v: DupeGroup[] | null) {
    state.pane.dupeGroups = v;
  },
  get compareRows(): CompareRow[] | null {
    return state.pane.compareRows;
  },
  set compareRows(v: CompareRow[] | null) {
    state.pane.compareRows = v;
  },
  get compareSummary(): string | null {
    return state.pane.compareSummary;
  },
  set compareSummary(v: string | null) {
    state.pane.compareSummary = v;
  },
  clipboard: null as { mode: "copy" | "cut"; paths: string[] } | null,
  showHidden: localStorage.getItem("filemon-hidden") === "1",
  dual: localStorage.getItem("filemon-dual") === "1",
  drives: [] as Drive[],
  previewOpen: false,
  homeDir: "",
  pinned: [] as string[],
  gitInfo: null as GitRepoInfo | null,
};

// Computed folder sizes for the current listing (path -> bytes). Filled in
// asynchronously by the folder-size events; cleared on every loadDir so a
// listing never shows a size computed for a previous state of the folder.
const folderSizeCache = new Map<string, number>();

function displaySize(e: Entry): string {
  if (!e.is_dir) return fmtSize(e.size ?? 0);
  const cached = folderSizeCache.get(e.path);
  return cached === undefined ? "—" : fmtSize(cached);
}

async function requestFolderSizesFor(paneIdx: number): Promise<void> {
  const p = state.panes[paneIdx];
  const missing = p.filtered
    .filter((e) => e.is_dir && !folderSizeCache.has(e.path))
    .map((e) => e.path);
  if (missing.length === 0) return;
  try {
    await invoke("folder_sizes", { paths: missing });
  } catch {
    // Sizes stay "—" until the next listing.
  }
}

async function requestFolderSizes(): Promise<void> {
  return requestFolderSizesFor(state.activePane);
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]);
const TEXT_EXTS = new Set(["txt", "md", "rs", "py", "js", "ts", "jsx", "tsx", "json", "toml", "yaml", "yml", "xml", "html", "css", "scss", "sh", "log", "csv", "c", "h", "cpp", "hpp", "go", "java", "rb", "php", "swift", "kt"]);

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
    case "doc": case "docx": case "odt": case "rtf": return "Document";
    case "xls": case "xlsx": case "ods": case "csv": return "Spreadsheet";
    case "ppt": case "pptx": case "odp": return "Presentation";
    case "zip": case "tar": case "gz": case "xz": case "7z": case "rar": case "deb": case "rpm": return "Archive";
    case "exe": case "AppImage": case "bin": case "run": case "msi": case "dmg": return "Application";
    case "rs": case "py": case "js": case "ts": case "jsx": case "tsx": case "c": case "h": case "cpp": case "hpp": case "go": case "java": case "rb": case "php": case "swift": case "kt": case "html": case "css": case "scss": case "json": case "toml": case "yaml": case "yml": case "xml": case "sh": return "Code";
    case "txt": case "md": case "log": return "Text file";
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
  text: '<path d="M4 1.5h5.5L13 5v9.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-12a1 1 0 0 1 1-1z"/><path d="M9 1.5V5.5h4"/><path d="M5.5 8h5M5.5 10.5h5M5.5 12.5h3"/>',
  pdf: '<path d="M4 1.5h5.5L13 5v9.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-12a1 1 0 0 1 1-1z"/><path d="M9 1.5V5.5h4"/><path d="M6 13.5l1-2.5M10 13.5l-1-2.5M6.5 12h3"/>',
  code: '<path d="M5.5 4.5L2.5 8l3 3.5M10.5 4.5L13.5 8l-3 3.5"/>',
  sheet: '<rect x="2.5" y="2.5" width="11" height="11" rx="1"/><path d="M2.5 6h11M2.5 9.5h11M6.5 2.5v11M10.5 2.5v11"/>',
  slides: '<rect x="2" y="3" width="12" height="8" rx="1"/><path d="M6 13.5h4M8 11v2.5"/><circle cx="5" cy="7" r="1"/><path d="M8.5 5.5L11 8.5H8.5"/>',
  exec: '<rect x="2" y="3" width="12" height="10" rx="1"/><path d="M4.5 6l2.5 2-2.5 2M8.5 10H12"/>',
  link: '<path d="M6.5 9.5a3 3 0 0 0 4.2 0l1.8-1.8a3 3 0 0 0-4.2-4.2l-1 1"/><path d="M9.5 6.5a3 3 0 0 0-4.2 0L3.5 8.3a3 3 0 0 0 4.2 4.2l1-1"/>',
  drive: '<rect x="2" y="4.5" width="12" height="7" rx="1"/><path d="M4.5 8h.01M7 8h.01M12 8h.01"/>',
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
  home: '<path d="M2.5 7.5L8 2.5l5.5 5V13a1 1 0 0 1-1 1h-3.5v-3.5h-2V14H3.5a1 1 0 0 1-1-1V7.5z"/>',
  desktop: '<rect x="2" y="3" width="12" height="8" rx="1"/><path d="M8 11v2.5M5.5 13.5h5"/>',
  download: '<path d="M8 2.5v7.5M4.5 7L8 10.5 11.5 7M2.5 13.5h11"/>',
  pin: '<path d="M10 2l4 4-2 2-1-1-3 3v2.5L6.5 11 3 14.5 2 13.5l3.5-3.5-1.5-1.5H6.5l3-3-1-1 2-2z"/>',
  command: '<path d="M2.5 3.5h11a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z"/><path d="M5 6.5l2 1.5-2 1.5M9 9.5h2"/>',
  treemap: '<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="M8 2.5v11M8 8h5.5"/>',
};

function quickIconFor(label: string): string {
  switch (label.toLowerCase()) {
    case "home": return ICONS.home;
    case "desktop": return ICONS.desktop;
    case "documents": return ICONS.doc;
    case "downloads": return ICONS.download;
    case "pictures": return ICONS.image;
    case "music": return ICONS.audio;
    case "videos": return ICONS.video;
    default: return ICONS.folder;
  }
}

function isImageEntry(e: Entry): boolean {
  if (e.is_dir) return false;
  switch (e.extension) {
    case "png": case "jpg": case "jpeg": case "gif": case "webp": case "svg": case "bmp":
      return true;
    default:
      return false;
  }
}

/** Coarse group for the advanced Type filter (mirrors kindLabel's families). */
function filterKindGroup(e: Entry): string {
  if (e.is_dir) return "folders";
  switch (e.extension) {
    case "png": case "jpg": case "jpeg": case "gif": case "webp": case "svg": case "bmp": return "images";
    case "mp4": case "mkv": case "webm": case "mov": case "avi": return "videos";
    case "mp3": case "flac": case "wav": case "ogg": case "m4a": return "audio";
    case "pdf": case "doc": case "docx": case "odt": case "rtf": case "xls": case "xlsx": case "ods": case "csv": case "ppt": case "pptx": case "odp": return "documents";
    case "zip": case "tar": case "gz": case "xz": case "7z": case "rar": case "deb": case "rpm": return "archives";
    case "rs": case "py": case "js": case "ts": case "jsx": case "tsx": case "c": case "h": case "cpp": case "hpp": case "go": case "java": case "rb": case "php": case "swift": case "kt": case "html": case "css": case "scss": case "json": case "toml": case "yaml": case "yml": case "xml": case "sh": return "code";
    default: return "other";
  }
}

function filterActive(p: Pane = state.pane): boolean {
  const f = p.filter;
  return f.kind !== "all" || !!f.ext || f.minSize !== null || f.maxSize !== null || !!f.after || !!f.before;
}

function iconFor(e: Entry): string {
  if (e.is_dir) return e.is_symlink ? ICONS.link : ICONS.folder;
  if (e.is_symlink) return ICONS.link;
  if (isImageEntry(e)) return ICONS.image;
  switch (e.extension) {
    case "mp4": case "mkv": case "webm": case "mov": case "avi": return ICONS.video;
    case "mp3": case "flac": case "wav": case "ogg": case "m4a": return ICONS.audio;
    case "zip": case "tar": case "gz": case "xz": case "7z": case "rar": case "deb": case "rpm": return ICONS.archive;
    case "pdf": return ICONS.pdf;
    case "doc": case "docx": case "odt": case "rtf": return ICONS.doc;
    case "xls": case "xlsx": case "ods": case "csv": return ICONS.sheet;
    case "ppt": case "pptx": case "odp": return ICONS.slides;
    case "exe": case "AppImage": case "bin": case "run": case "msi": case "dmg": return ICONS.exec;
    case "rs": case "py": case "js": case "ts": case "jsx": case "tsx": case "c": case "h": case "cpp": case "hpp": case "go": case "java": case "rb": case "php": case "swift": case "kt": case "html": case "css": case "scss": case "json": case "toml": case "yaml": case "yml": case "xml": case "sh": return ICONS.code;
    case "txt": case "md": case "log": return ICONS.text;
    default: return ICONS.file;
  }
}

function iconForFileName(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (IMAGE_EXTS.has(ext)) return ICONS.image;
  switch (ext) {
    case "mp4": case "mkv": case "webm": case "mov": case "avi": return ICONS.video;
    case "mp3": case "flac": case "wav": case "ogg": case "m4a": return ICONS.audio;
    case "zip": case "tar": case "gz": case "xz": case "7z": case "rar": case "deb": case "rpm": return ICONS.archive;
    case "pdf": return ICONS.pdf;
    case "doc": case "docx": case "odt": case "rtf": return ICONS.doc;
    case "xls": case "xlsx": case "ods": case "csv": return ICONS.sheet;
    case "ppt": case "pptx": case "odp": return ICONS.slides;
    case "exe": case "AppImage": case "bin": case "run": case "msi": case "dmg": return ICONS.exec;
    case "rs": case "py": case "js": case "ts": case "jsx": case "tsx": case "c": case "h": case "cpp": case "hpp": case "go": case "java": case "rb": case "php": case "swift": case "kt": case "html": case "css": case "scss": case "json": case "toml": case "yaml": case "yml": case "xml": case "sh": return ICONS.code;
    case "txt": case "md": case "log": return ICONS.text;
    default: return ICONS.file;
  }
}

// Video extensions, for first-frame thumbnails in the icon grid.
const VIDEO_EXTS = new Set(["mp4", "mkv", "webm", "mov", "avi"]);
// Extensions whose preview pane gets syntax highlighting instead of plain text.
const CODE_EXTS = new Set(["rs", "py", "js", "ts", "jsx", "tsx", "c", "h", "cpp", "hpp", "go", "java", "rb", "php", "swift", "kt", "html", "css", "scss", "json", "toml", "yaml", "yml", "xml", "sh"]);

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
    if (!d.mount || d.mounted === false) continue;
    if ((path === d.mount || path.startsWith(d.mount.endsWith("/") ? d.mount : d.mount + "/")) && (!best || d.mount.length > best.mount.length)) {
      best = d;
    }
  }
  return best;
}

async function navigate(path: string, push = true): Promise<void> {
  state.isTrash = false;
  state.tag = null;
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
  state.anchor = null;
  await loadDir();
  updateNavButtons();
  updateTrashNav();
}

/* ---- Address bar (Ctrl+L) ---- */
// The breadcrumbs swap for an editable path. Enter navigates (a leading ~
// expands to Home, a relative path resolves against the current folder);
// Esc or blur puts the breadcrumbs back.

function showAddressBar(): void {
  const input = $("address-bar") as HTMLInputElement;
  input.value = state.path;
  ($("crumbs") as HTMLElement).hidden = true;
  input.hidden = false;
  input.focus();
  input.select();
}

function hideAddressBar(): void {
  ($("address-bar") as HTMLInputElement).hidden = true;
  ($("crumbs") as HTMLElement).hidden = false;
}

async function goToAddress(): Promise<void> {
  const input = $("address-bar") as HTMLInputElement;
  const raw = input.value.trim();
  hideAddressBar();
  if (!raw || raw === state.path) return;
  let path = raw.replace(/^~/, state.homeDir);
  if (!path.startsWith("/")) path = `${state.path.replace(/\/$/, "")}/${path}`;
  try {
    const p = await invoke<Properties>("get_properties", { path });
    if (!p.is_dir) {
      toast("That path is a file, not a folder", true);
      return;
    }
    await navigate(path);
  } catch {
    toast(`No such folder: ${raw}`, true);
  }
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
  if (t.tag) return `${TAG_DEFS[t.tag]?.label || t.tag} Tag`;
  if (t.isTrash) return "Trash";
  if (t.path === "/") return "This PC";
  const name = t.path.replace(/\/+$/, "").split("/").pop() ?? "";
  return name || "This PC";
}

function saveTabs(paneIdx = state.activePane): void {
  // Per-pane persistence: pane 0 keeps the legacy keys, pane 1 gets -1 keys.
  const p = state.panes[paneIdx];
  const suffix = paneIdx === 0 ? "" : "-1";
  try {
    localStorage.setItem(
      "filemon-tabs" + suffix,
      JSON.stringify(
        p.tabs.map((t) => ({
          path: t.path,
          view: t.view,
          sortKey: t.sortKey,
          sortDir: t.sortDir,
          isTrash: t.isTrash,
          tag: t.tag,
          zoom: t.zoom,
          groupBy: t.groupBy,
        })),
      ),
    );
    localStorage.setItem("filemon-active-tab" + suffix, String(p.activeTab));
  } catch {
    /* storage unavailable — tabs still work for this session */
  }
}

function restoreTabs(home: string, paneIdx = state.activePane): void {
  const p = state.panes[paneIdx];
  let saved: { path: string; view: Tab["view"]; sortKey: Tab["sortKey"]; sortDir: number; isTrash?: boolean; tag?: TagKey | null; zoom?: number; groupBy?: string }[] = [];
  const suffix = paneIdx === 0 ? "" : "-1";
  try {
    const raw = JSON.parse(localStorage.getItem("filemon-tabs" + suffix) ?? "[]");
    if (Array.isArray(raw)) saved = raw;
  } catch {
    saved = [];
  }
  // First run (or pre-tabs install): one tab at Home, keeping the stored
  // global view/sort as its defaults.
  const view = (localStorage.getItem("filemon-view") as Tab["view"]) || "details";
  const sortKey = (localStorage.getItem("filemon-sort") as Tab["sortKey"]) || "name";
  const list = saved.filter((t) => typeof t?.path === "string" && (t.path.startsWith("/") || t.path.startsWith("tag://")));
  const seeds = list.length > 0 ? list : [{ path: home, view, sortKey, sortDir: 1, isTrash: false }];
  p.tabs = seeds.map((t) => ({
    id: p.nextTabId++,
    path: t.path,
    history: [t.path],
    histIndex: 0,
    view: t.view === "icons" ? "icons" : "details",
    sortKey: (["name", "size", "modified", "type"].includes(t.sortKey) ? t.sortKey : "name") as Tab["sortKey"],
    sortDir: t.sortDir === -1 ? -1 : 1,
    isTrash: t.isTrash === true,
    tag: (t.tag && ALL_TAGS.includes(t.tag as TagKey) ? t.tag : null) as TagKey | null,
    zoom: (t.zoom === 0 || t.zoom === 2 ? t.zoom : 1) as Tab["zoom"],
    groupBy: (["type", "date", "size"].includes(t.groupBy ?? "") ? t.groupBy : "none") as Tab["groupBy"],
  }));
  const active = Number(localStorage.getItem("filemon-active-tab" + suffix) ?? "0");
  p.activeTab = active >= 0 && active < p.tabs.length ? active : 0;
}

// ---- Pin folders to Quick access ----
const PINNED_KEY = "filemon-pinned";

function baseName(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : p;
}

function builtinPlaces(): [string, string][] {
  const homeDir = state.homeDir;
  return [
    ["Home", homeDir],
    ["Desktop", `${homeDir}/Desktop`],
    ["Documents", `${homeDir}/Documents`],
    ["Downloads", `${homeDir}/Downloads`],
    ["Pictures", `${homeDir}/Pictures`],
    ["Music", `${homeDir}/Music`],
    ["Videos", `${homeDir}/Videos`],
  ];
}

function isBuiltinPlace(path: string): boolean {
  return builtinPlaces().some(([, p]) => p === path);
}

function isPinned(path: string): boolean {
  return state.pinned.includes(path);
}

function loadPins(): void {
  try {
    const raw = JSON.parse(localStorage.getItem(PINNED_KEY) ?? "[]");
    if (Array.isArray(raw)) {
      state.pinned = [...new Set(raw.filter((p) => typeof p === "string" && p.startsWith("/")))];
    }
  } catch {
    state.pinned = [];
  }
}

function savePins(): void {
  localStorage.setItem(PINNED_KEY, JSON.stringify(state.pinned));
}

function togglePin(path: string): void {
  if (isPinned(path)) {
    state.pinned = state.pinned.filter((p) => p !== path);
  } else if (!isBuiltinPlace(path)) {
    state.pinned = [...state.pinned, path];
  } else {
    return;
  }
  savePins();
  renderSidebar();
}

async function prunePins(): Promise<void> {
  const kept: string[] = [];
  for (const p of state.pinned) {
    try {
      if (await invoke<boolean>("path_exists", { path: p })) kept.push(p);
    } catch {
      kept.push(p);
    }
  }
  if (kept.length !== state.pinned.length) {
    state.pinned = kept;
    savePins();
  }
}

/* ---- Tags & Colors System ---- */

const TAGS_KEY = "filemon-file-tags";

function loadFileTags(): Record<string, TagKey[]> {
  try {
    const raw = JSON.parse(localStorage.getItem(TAGS_KEY) ?? "{}");
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      return raw as Record<string, TagKey[]>;
    }
  } catch {}
  return {};
}

function saveFileTags(map: Record<string, TagKey[]>): void {
  try {
    localStorage.setItem(TAGS_KEY, JSON.stringify(map));
  } catch {}
}

function getTagsForPath(path: string): TagKey[] {
  const map = loadFileTags();
  return map[path] || [];
}

function toggleTagForPaths(paths: string[], tag: TagKey): void {
  if (paths.length === 0) return;
  const map = loadFileTags();
  const allHave = paths.every((p) => (map[p] || []).includes(tag));
  for (const p of paths) {
    const cur = map[p] || [];
    if (allHave) {
      const next = cur.filter((t) => t !== tag);
      if (next.length === 0) delete map[p];
      else map[p] = next;
    } else {
      if (!cur.includes(tag)) map[p] = [...cur, tag];
    }
  }
  saveFileTags(map);
  updateTagsOnView();
  renderSidebar();
  void updatePreview();
  if (state.tag) {
    void loadDir();
  }
}

function clearTagsForPaths(paths: string[]): void {
  const map = loadFileTags();
  for (const p of paths) delete map[p];
  saveFileTags(map);
  updateTagsOnView();
  renderSidebar();
  void updatePreview();
  if (state.tag) {
    void loadDir();
  }
}

function getPathsForTag(tag: TagKey): string[] {
  const map = loadFileTags();
  const res: string[] = [];
  for (const [p, tags] of Object.entries(map)) {
    if (tags.includes(tag)) res.push(p);
  }
  return res;
}

function getTagCounts(): Record<TagKey, number> {
  const map = loadFileTags();
  const counts: Record<TagKey, number> = {
    red: 0,
    orange: 0,
    yellow: 0,
    green: 0,
    blue: 0,
    purple: 0,
  };
  for (const tags of Object.values(map)) {
    for (const t of tags) {
      if (counts[t] !== undefined) counts[t]++;
    }
  }
  return counts;
}

function renamePathInTags(oldPath: string, newPath: string): void {
  const map = loadFileTags();
  let changed = false;
  for (const [p, tags] of Object.entries(map)) {
    if (p === oldPath) {
      map[newPath] = tags;
      delete map[p];
      changed = true;
    } else if (p.startsWith(oldPath.endsWith("/") ? oldPath : oldPath + "/")) {
      const updated = newPath + p.slice(oldPath.length);
      map[updated] = tags;
      delete map[p];
      changed = true;
    }
  }
  if (changed) {
    saveFileTags(map);
    renderSidebar();
  }
}

function removePathFromTags(path: string): void {
  const map = loadFileTags();
  let changed = false;
  for (const p of Object.keys(map)) {
    if (p === path || p.startsWith(path.endsWith("/") ? path : path + "/")) {
      delete map[p];
      changed = true;
    }
  }
  if (changed) {
    saveFileTags(map);
    renderSidebar();
  }
}

function updateTagsOnView(): void {
  const isLight = document.documentElement.dataset.theme === "light";
  document.querySelectorAll<HTMLTableRowElement>("tbody tr").forEach((tr) => {
    const path = tr.dataset.path;
    if (!path) return;
    const existing = tr.querySelector(".file-tags");
    if (existing) existing.remove();
    const tags = getTagsForPath(path);
    if (tags.length > 0) {
      const nameRow = tr.querySelector(".file-name-row");
      if (nameRow) {
        const span = document.createElement("span");
        span.className = "file-tags";
        for (const t of tags) {
          const def = TAG_DEFS[t];
          const dot = document.createElement("span");
          dot.className = "file-tag-dot";
          dot.style.backgroundColor = isLight ? def.lightColor : def.color;
          dot.title = `Tag: ${def.label}`;
          span.appendChild(dot);
        }
        nameRow.appendChild(span);
      }
    }
  });

  document.querySelectorAll<HTMLElement>(".tile").forEach((tile) => {
    const path = tile.dataset.path;
    if (!path) return;
    const existing = tile.querySelector(".tile-tag-dots");
    if (existing) existing.remove();
    const tags = getTagsForPath(path);
    if (tags.length > 0) {
      const dotsWrap = document.createElement("span");
      dotsWrap.className = "tile-tag-dots";
      for (const t of tags) {
        const def = TAG_DEFS[t];
        const dot = document.createElement("span");
        dot.className = "tile-tag-dot";
        dot.style.backgroundColor = isLight ? def.lightColor : def.color;
        dot.title = `Tag: ${def.label}`;
        dotsWrap.appendChild(dot);
      }
      tile.appendChild(dotsWrap);
    }
  });
}

async function openTagView(tag: TagKey): Promise<void> {
  state.isTrash = false;
  state.tag = tag;
  state.path = `tag://${tag}`;
  state.selection.clear();
  ($("search") as HTMLInputElement).value = "";
  await loadDir();
  updateNavButtons();
  updateTrashNav();
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
  state.anchor = null;
  state.searching = false;
  state.searchQuery = "";
  ($("search") as HTMLInputElement).value = "";
  ($("sort-key") as HTMLSelectElement).value = state.sortKey;
  renderTabs();
  await loadDir();
  updateNavButtons();
  updateTrashNav();
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
    tag: null,
    zoom: src.zoom,
    groupBy: src.groupBy,
  });
  void switchTab(state.tabs.length - 1);
}

async function closeTab(i: number): Promise<void> {
  if (state.tabs.length === 1) {
    // Last tab: replace it with a fresh one at Home instead of closing the window.
    const t = state.tabs[0];
    t.isTrash = false;
    t.tag = null;
    t.path = state.homeDir;
    t.history = [state.homeDir];
    t.histIndex = 0;
    renderTabs();
    await loadDir();
    updateNavButtons();
    return;
  }
  // Remember the closed tab so Ctrl+Shift+T can bring it back.
  const gone = state.tabs[i];
  state.pane.closedTabs.push({
    path: gone.path,
    view: gone.view,
    sortKey: gone.sortKey,
    sortDir: gone.sortDir,
    isTrash: gone.isTrash,
    tag: gone.tag,
    zoom: gone.zoom,
    groupBy: gone.groupBy,
  });
  if (state.pane.closedTabs.length > 10) state.pane.closedTabs.shift();
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

/** Ctrl+Shift+T: reopen the most recently closed tab, with its old view/sort. */
async function reopenClosedTab(): Promise<void> {
  const t = state.pane.closedTabs.pop();
  if (!t) {
    toast("No recently closed tab");
    return;
  }
  state.tabs.push({
    id: state.nextTabId++,
    path: t.path,
    history: [t.path],
    histIndex: 0,
    view: t.view,
    sortKey: t.sortKey,
    sortDir: t.sortDir,
    isTrash: t.isTrash,
    tag: t.tag,
    zoom: t.zoom,
    groupBy: t.groupBy,
  });
  await switchTab(state.tabs.length - 1);
}

/* ---- Dual pane ---- */
// The toolbar, crumbs, tab bar and status bar always describe the ACTIVE
// pane. Clicking (mousedown) inside a pane activates it first, so every
// existing handler — clicks, drags, keyboard, context menu — keeps working
// on the pane the user is looking at, with no per-handler pane plumbing.

function setActivePane(i: number): void {
  if (i === state.activePane || i < 0 || i > 1 || (i === 1 && !state.dual)) return;
  state.activePane = i;
  localStorage.setItem("filemon-active-pane", String(i));
  document.querySelectorAll(".pane").forEach((el, idx) => el.classList.toggle("is-active", idx === i));
  ($("search") as HTMLInputElement).value = state.searchQuery;
  ($("sort-key") as HTMLSelectElement).value = state.sortKey;
  const contentBtn = $("search-content");
  contentBtn.setAttribute("aria-pressed", String(state.contentMode));
  contentBtn.classList.toggle("is-active", state.contentMode);
  render();
  updateNavButtons();
  void loadGitInfo();
}

let secondPaneBuilt = false;

function buildSecondPane(): void {
  if (secondPaneBuilt) return;
  secondPaneBuilt = true;
  const src = $("file-area");
  const clone = src.cloneNode(true) as HTMLElement;
  clone.id = "file-area-1";
  clone.querySelectorAll("[id]").forEach((el) => {
    el.id = el.id + "-1";
  });
  const pane = document.createElement("div");
  pane.className = "pane";
  pane.id = "pane-1";
  pane.appendChild(clone);
  $("panes").appendChild(pane);
  pane.addEventListener("mousedown", () => setActivePane(1));
  // The clone's own controls (ids now end in -1).
  ($("empty-new-folder-1") as HTMLButtonElement).addEventListener("click", () => {
    setActivePane(1);
    askNew("folder");
  });
  ($("empty-clear-search-1") as HTMLButtonElement).addEventListener("click", () => {
    setActivePane(1);
    clearSearch();
  });
  ($("error-retry-1") as HTMLButtonElement).addEventListener("click", () => {
    setActivePane(1);
    void loadDirFor(1);
  });
  ($("dupe-delete-1") as HTMLButtonElement).addEventListener("click", () => {
    setActivePane(1);
    void deleteSelectedDupes();
  });
  ($("dupe-done-1") as HTMLButtonElement).addEventListener("click", () => {
    setActivePane(1);
    void exitDupes();
  });
  ($("compare-copy-out-1") as HTMLButtonElement).addEventListener("click", () => {
    setActivePane(1);
    void copyMissing(true);
  });
  ($("compare-copy-in-1") as HTMLButtonElement).addEventListener("click", () => {
    setActivePane(1);
    void copyMissing(false);
  });
  ($("compare-done-1") as HTMLButtonElement).addEventListener("click", () => {
    setActivePane(1);
    void exitCompare();
  });
  clone.querySelectorAll("#file-table-1 th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => {
      setActivePane(1);
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
  // Background context menu + drop target for pane 1 (rows/tiles stop
  // propagation, so this only fires for empty space, like pane 0).
  clone.addEventListener("contextmenu", (ev) => {
    if ((ev.target as HTMLElement).closest("tr, .tile")) return;
    ev.preventDefault();
    setActivePane(1);
    showContextMenu(ev.clientX, ev.clientY, null);
  });
  clone.addEventListener("dragover", (ev) => {
    if (!isInternalDrag(ev)) return;
    if ((ev.target as HTMLElement).closest("tbody tr, .tile")) return;
    ev.preventDefault();
    ev.dataTransfer!.dropEffect = ev.ctrlKey ? "copy" : "move";
    markDropTarget(clone);
  });
  clone.addEventListener("drop", (ev) => {
    ev.preventDefault();
    markDropTarget(null);
    const p = state.panes[1];
    const tab = p.tabs[p.activeTab];
    if (!tab || tab.isTrash) return;
    const paths = dropPaths(ev);
    if (!paths) return;
    void performDrop(paths, tab.path, ev.ctrlKey);
  });
}

async function setDual(on: boolean): Promise<void> {
  if (on === state.dual) return;
  state.dual = on;
  localStorage.setItem("filemon-dual", on ? "1" : "0");
  const btn = $("act-dual") as HTMLButtonElement;
  btn.classList.toggle("is-active", on);
  btn.setAttribute("aria-pressed", String(on));
  if (on) {
    if (state.panes.length === 1) {
      state.panes.push(makePane());
      restoreTabs(state.homeDir, 1);
    }
    buildSecondPane();
    ($("pane-1") as HTMLElement).hidden = false;
    document.querySelectorAll(".pane-head").forEach((el) => ((el as HTMLElement).hidden = false));
    await loadDirFor(1);
    render();
  } else {
    saveTabs(1);
    state.activePane = 0;
    localStorage.setItem("filemon-active-pane", "0");
    ($("pane-1") as HTMLElement).hidden = true;
    document.querySelectorAll(".pane-head").forEach((el) => ((el as HTMLElement).hidden = true));
    document.querySelectorAll(".pane").forEach((el, idx) => el.classList.toggle("is-active", idx === 0));
    render();
    updateNavButtons();
  }
}

/** F5 = copy, F6 = move the active pane's selection into the other pane. */
async function transferToOtherPane(copy: boolean): Promise<void> {
  if (!state.dual) return;
  const other = 1 - state.activePane;
  const tab = state.panes[other].tabs[state.panes[other].activeTab];
  if (!tab || tab.isTrash) {
    toast("The other pane is showing the Trash", true);
    return;
  }
  const paths = [...state.selection];
  if (paths.length === 0) {
    toast("Nothing selected");
    return;
  }
  const outcome = await runTransfer(paths, tab.path, copy);
  if (outcome) await loadDirFor(other);
}

/** Switch the active tab to the Trash (the freedesktop Trash, not a folder). */
async function openTrash(): Promise<void> {
  state.isTrash = true;
  state.selection.clear();
  state.anchor = null;
  state.searching = false;
  state.searchQuery = "";
  ($("search") as HTMLInputElement).value = "";
  await loadDir();
  updateNavButtons();
  updateTrashNav();
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
    for (const p of paths) removePathFromTags(p);
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

/** Size used for ordering: a folder's computed size (or -1 while unknown). */
function effectiveSize(e: Entry): number {
  if (!e.is_dir) return e.size ?? -1;
  return folderSizeCache.get(e.path) ?? -1;
}

function applyFilterSortFor(p: Pane): void {
  // Result modes keep their own order: content matches are relevance order,
  // duplicate groups are size order, compare rows are grouped by side.
  // No name filter, no re-sort.
  if (p.contentMatches || p.dupeGroups || p.compareRows) {
    p.filtered = [...p.entries];
    return;
  }
  let list = p.entries;
  if (!state.showHidden) list = list.filter((e) => !e.hidden);
  const q = p.searchQuery.trim().toLowerCase();
  if (q && !p.searching) list = list.filter((e) => e.name.toLowerCase().includes(q));
  // Advanced filters (toolbar Filter button): type group, extension,
  // size range, modified-date range. A size bound excludes entries whose
  // size is unknown (folders still being measured sort as -1).
  const f = p.filter;
  if (f.kind !== "all" || f.ext || f.minSize !== null || f.maxSize !== null || f.after || f.before) {
    list = list.filter((e) => {
      if (f.kind !== "all" && filterKindGroup(e) !== f.kind) return false;
      if (f.ext && (e.extension ?? "").toLowerCase() !== f.ext.toLowerCase()) return false;
      if (f.minSize !== null || f.maxSize !== null) {
        const sz = e.is_dir ? effectiveSize(e) : (e.size ?? -1);
        if (sz < 0) return false;
        if (f.minSize !== null && sz < f.minSize) return false;
        if (f.maxSize !== null && sz > f.maxSize) return false;
      }
      if (f.after && (e.modified ?? 0) * 1000 < new Date(`${f.after}T00:00:00`).getTime()) return false;
      if (f.before && (e.modified ?? 0) * 1000 > new Date(`${f.before}T23:59:59`).getTime()) return false;
      return true;
    });
  }
  const tab = p.tabs[p.activeTab];
  const dir = tab?.sortDir ?? 1;
  const key = tab?.sortKey ?? "name";
  list = [...list].sort((a, b) => {
    if (key === "size") {
      // True size order: a folder sorts among files by its computed size
      // instead of always grouping first (folders with unknown size sort last).
      return (effectiveSize(a) - effectiveSize(b)) * dir;
    }
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    let cmp = 0;
    if (key === "name") cmp = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    else if (key === "modified") cmp = (a.modified ?? 0) - (b.modified ?? 0);
    else cmp = kindLabel(a).localeCompare(kindLabel(b));
    return cmp * dir;
  });
  p.filtered = list;
}

function applyFilterSort(): void {
  applyFilterSortFor(state.pane);
}

/* ---- Grouping (Appearance: Group by) ---- */

type GroupMode = "none" | "type" | "date" | "size";

type Group = { key: string; label: string; entries: Entry[] };

const GROUP_ORDER: Record<Exclude<GroupMode, "none">, string[]> = {
  type: ["folders", "images", "videos", "audio", "documents", "sheets", "slides", "archives", "apps", "code", "text", "other"],
  date: ["today", "yesterday", "week", "month", "earlier", "unknown"],
  size: ["large", "medium", "small", "tiny", "unknown"],
};

function groupLabelFor(e: Entry, mode: Exclude<GroupMode, "none">): { key: string; label: string } {
  if (mode === "type") {
    if (e.is_dir) return { key: "folders", label: "Folders" };
    switch (kindLabel(e)) {
      case "Image": return { key: "images", label: "Images" };
      case "Video": return { key: "videos", label: "Videos" };
      case "Audio": return { key: "audio", label: "Audio" };
      case "PDF document": case "Document": return { key: "documents", label: "Documents" };
      case "Spreadsheet": return { key: "sheets", label: "Spreadsheets" };
      case "Presentation": return { key: "slides", label: "Presentations" };
      case "Archive": return { key: "archives", label: "Archives" };
      case "Application": return { key: "apps", label: "Applications" };
      case "Code": return { key: "code", label: "Code" };
      case "Text file": return { key: "text", label: "Text files" };
      default: return { key: "other", label: "Other files" };
    }
  }
  if (mode === "date") {
    if (e.modified === null || e.modified === undefined) return { key: "unknown", label: "Unknown date" };
    const day = 86_400_000;
    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const m = e.modified * 1000;
    if (m >= startToday) return { key: "today", label: "Today" };
    if (m >= startToday - day) return { key: "yesterday", label: "Yesterday" };
    if (m >= startToday - 7 * day) return { key: "week", label: "This week" };
    if (m >= startToday - 30 * day) return { key: "month", label: "This month" };
    return { key: "earlier", label: "Earlier" };
  }
  const s = effectiveSize(e);
  if (s < 0) return { key: "unknown", label: "Unknown size" };
  if (s < 100 * 1024) return { key: "tiny", label: "Tiny (under 100 KB)" };
  if (s < 1024 * 1024) return { key: "small", label: "Small (100 KB – 1 MB)" };
  if (s < 100 * 1024 * 1024) return { key: "medium", label: "Medium (1 – 100 MB)" };
  return { key: "large", label: "Large (over 100 MB)" };
}

// Groups the pane's filtered listing by the active tab's group mode.
// Null when grouping is off or a result mode (content/duplicates/compare)
// owns the order. Within a group the entries keep the current sort order.
function groupedEntries(p: Pane): Group[] | null {
  const mode = p.tabs[p.activeTab]?.groupBy ?? "none";
  if (mode === "none" || p.contentMatches || p.dupeGroups || p.compareRows) return null;
  const byKey = new Map<string, Group>();
  for (const e of p.filtered) {
    const { key, label } = groupLabelFor(e, mode);
    let g = byKey.get(key);
    if (!g) {
      g = { key, label, entries: [] };
      byKey.set(key, g);
    }
    g.entries.push(e);
  }
  return GROUP_ORDER[mode].map((k) => byKey.get(k)!).filter(Boolean);
}

function makeGroupHeadRow(p: Pane, g: Group): HTMLTableRowElement {
  const head = document.createElement("tr");
  head.className = "group-head";
  const td = document.createElement("td");
  td.colSpan = 4;
  const collapsed = p.collapsedGroups.has(g.key);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "group-toggle";
  btn.dataset.group = g.key;
  btn.setAttribute("aria-expanded", String(!collapsed));
  btn.textContent = `${collapsed ? "▸" : "▾"} ${g.label} · ${g.entries.length} item${g.entries.length === 1 ? "" : "s"}`;
  btn.addEventListener("click", () => {
    if (p.collapsedGroups.has(g.key)) p.collapsedGroups.delete(g.key);
    else p.collapsedGroups.add(g.key);
    render();
  });
  td.appendChild(btn);
  head.appendChild(td);
  return head;
}

function makeGroupHeadDiv(p: Pane, g: Group): HTMLDivElement {
  const collapsed = p.collapsedGroups.has(g.key);
  const head = document.createElement("div");
  head.className = "group-head";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "group-toggle";
  btn.dataset.group = g.key;
  btn.setAttribute("aria-expanded", String(!collapsed));
  btn.textContent = `${collapsed ? "▸" : "▾"} ${g.label} · ${g.entries.length} item${g.entries.length === 1 ? "" : "s"}`;
  btn.addEventListener("click", () => {
    if (p.collapsedGroups.has(g.key)) p.collapsedGroups.delete(g.key);
    else p.collapsedGroups.add(g.key);
    render();
  });
  head.appendChild(btn);
  return head;
}

function renderCrumbs(): void {
  const nav = $("crumbs");
  nav.innerHTML = "";
  if (state.tag) {
    const tagDef = TAG_DEFS[state.tag];
    const isLight = document.documentElement.dataset.theme === "light";
    const col = isLight ? tagDef.lightColor : tagDef.color;
    nav.innerHTML = `<span class="crumb">Tags</span><span class="crumb-sep">/</span><span class="crumb is-current" style="display:inline-flex;align-items:center;gap:5px;"><span class="nav-tag-dot" style="background:${col}"></span>${escapeHtml(tagDef.label)}</span>`;
    $("side-path").textContent = `Tag: ${tagDef.label}`;
    return;
  }
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

function getGitStatusFor(path: string, isDir: boolean): string | null {
  if (!state.gitInfo) return null;
  return state.gitInfo.statuses[path] || (isDir ? state.gitInfo.dir_statuses[path] : null) || null;
}

function gitTagClass(st: string): string {
  switch (st) {
    case "?": return "git-tag-untracked";
    case "A": return "git-tag-added";
    case "D": return "git-tag-deleted";
    case "R": return "git-tag-renamed";
    case "U": return "git-tag-conflict";
    default: return "git-tag-modified";
  }
}

function gitTagText(st: string): string {
  switch (st) {
    case "?": return "U";
    case "A": return "A";
    case "D": return "D";
    case "R": return "R";
    case "U": return "!";
    default: return "M";
  }
}

function gitDotClass(st: string): string {
  switch (st) {
    case "?": return "is-untracked";
    case "A": return "is-added";
    default: return "is-modified";
  }
}

function gitTitleFor(st: string): string {
  switch (st) {
    case "?": return "Untracked (new file)";
    case "A": return "Staged (added to git)";
    case "D": return "Deleted in working tree";
    case "R": return "Renamed in working tree";
    case "U": return "Merge conflict";
    default: return "Modified in git";
  }
}

function gitBadgeForStatus(st: string): string {
  return `<span class="git-tag ${gitTagClass(st)}" title="${escapeHtml(gitTitleFor(st))}">${gitTagText(st)}</span>`;
}

async function loadGitInfo(): Promise<void> {
  const currentPath = state.path;
  const badge = $("git-badge");
  if (state.isTrash || state.tag) {
    state.gitInfo = null;
    if (badge) badge.hidden = true;
    return;
  }
  try {
    const info = await invoke<GitRepoInfo | null>("get_git_info", { path: currentPath });
    if (state.path !== currentPath) return;
    state.gitInfo = info;
    updateGitBadge();
    updateGitTagsOnView();
  } catch (err) {
    console.error("Failed to fetch git info:", err);
    state.gitInfo = null;
    if (badge) badge.hidden = true;
  }
}

function updateGitBadge(): void {
  const badge = $("git-badge");
  if (!badge) return;
  const info = state.gitInfo;
  if (!info) {
    badge.hidden = true;
    return;
  }
  badge.hidden = false;
  const branchEl = $("git-branch");
  const dotEl = $("git-status-dot");
  const syncEl = $("git-ahead-behind");

  if (branchEl) branchEl.textContent = info.branch;
  if (dotEl) {
    dotEl.classList.toggle("is-dirty", !info.is_clean);
    dotEl.title = info.is_clean ? "Working tree clean" : "Uncommitted changes";
  }
  if (syncEl) {
    const parts: string[] = [];
    if (info.ahead > 0) parts.push(`↑${info.ahead}`);
    if (info.behind > 0) parts.push(`↓${info.behind}`);
    syncEl.textContent = parts.join(" ");
  }

  const modifiedCount = Object.keys(info.statuses).length;
  badge.title = `Git: ${info.branch} · ${info.is_clean ? "Clean" : `${modifiedCount} modified file${modifiedCount > 1 ? "s" : ""}`}${info.ahead ? ` · ${info.ahead} ahead` : ""}${info.behind ? ` · ${info.behind} behind` : ""}\nClick to copy branch, right-click for options`;
}

function updateGitTagsOnView(): void {
  const suf = paneSuffix();
  document.querySelectorAll<HTMLTableRowElement>(`#file-body${suf} tr`).forEach((tr) => {
    const path = tr.dataset.path;
    if (!path) return;
    const isDir = tr.querySelector(".file-icon.is-dir") !== null;
    const gitSt = getGitStatusFor(path, isDir);
    const existing = tr.querySelector(".git-tag");
    if (existing) existing.remove();
    if (gitSt) {
      const nameRow = tr.querySelector(".file-name-row");
      if (nameRow) {
        const span = document.createElement("span");
        span.className = "git-tag " + gitTagClass(gitSt);
        span.title = gitTitleFor(gitSt);
        span.textContent = gitTagText(gitSt);
        nameRow.appendChild(span);
      }
    }
  });

  document.querySelectorAll<HTMLElement>(`#grid-wrap${suf} .tile`).forEach((tile) => {
    const path = tile.dataset.path;
    if (!path) return;
    const isDir = tile.querySelector(".tile-icon.is-dir") !== null;
    const gitSt = getGitStatusFor(path, isDir);
    const existing = tile.querySelector(".tile-git-dot");
    if (existing) existing.remove();
    if (gitSt) {
      const dot = document.createElement("span");
      dot.className = "tile-git-dot " + gitDotClass(gitSt);
      dot.title = gitTitleFor(gitSt);
      tile.appendChild(dot);
    }
  });
}

function makeEntryRow(p: Pane, e: Entry): HTMLTableRowElement {
  const tr = document.createElement("tr");
  tr.dataset.path = e.path;
  if (p.selection.has(e.path)) tr.classList.add("is-selected");
  // Trashed items cannot be dragged out (Restore is the way back); that
  // also keeps the .trashinfo from being orphaned by a move.
  const pIsTrash = p.tabs[p.activeTab]?.isTrash ?? false;
  tr.draggable = !pIsTrash;
  tr.addEventListener("dragstart", (ev) => onDragStart(ev, e, tr));
  tr.addEventListener("dragend", () => onDragEnd(tr));
  if (e.is_dir) attachDropTarget(tr, () => e.path);
  let sub = "";
  if (pIsTrash && e.original_path) {
    sub = `<span class="file-sub" title="${escapeHtml(e.original_path)}">${escapeHtml(e.original_path)}</span>`;
  } else if (p.contentMatches?.has(e.path)) {
    const m = p.contentMatches.get(e.path)!;
    const label = `line ${m.line}: ${m.snippet}`;
    sub = `<span class="file-sub" title="${escapeHtml(label)}">${escapeHtml(label)}</span>`;
  } else if (p.dupeGroups) {
    // Identical names in different folders need their parent shown.
    const parent = parentOf(e.path) ?? "/";
    sub = `<span class="file-sub" title="${escapeHtml(parent)}">${escapeHtml(parent)}</span>`;
  } else if (p.tabs[p.activeTab]?.tag) {
    const parent = parentOf(e.path) ?? "/";
    sub = `<span class="file-sub" title="${escapeHtml(parent)}">${escapeHtml(parent)}</span>`;
  } else if (p.compareRows) {
    const row = p.compareRows.find((r) => r.entry.path === e.path);
    const label =
      row?.status === "only-here"
        ? "Only in this pane"
        : row?.status === "only-there"
          ? "Only in the other pane"
          : "Different — size or content differs";
    sub = `<span class="file-sub" title="${escapeHtml(label)}">${escapeHtml(label)}</span>`;
  }
  const nameTd = document.createElement("td");
  // NB: .cell-name is display:flex — it must wrap the content in a div.
  // Putting it on the td itself turns the cell into a flex box, and
  // WebKitGTK then drops that cell's collapsed bottom border, so the row
  // dividers looked cut under the Name column.
  const kind = filterKindGroup(e);
  const gitSt = getGitStatusFor(e.path, e.is_dir);
  const gitBadgeHtml = gitSt ? gitBadgeForStatus(gitSt) : "";
  const entryTags = getTagsForPath(e.path);
  const isLight = document.documentElement.dataset.theme === "light";
  const tagDotsHtml = entryTags.length > 0
    ? `<span class="file-tags">${entryTags.map((t) => {
        const def = TAG_DEFS[t];
        const col = isLight ? def.lightColor : def.color;
        return `<span class="file-tag-dot" style="background:${col}" title="Tag: ${def.label}"></span>`;
      }).join("")}</span>`
    : "";
  nameTd.innerHTML = `<div class="cell-name">${iconSvg(iconFor(e), "icon file-icon" + (e.is_dir ? " is-dir" : "") + " kind-" + kind)}<div class="cell-name-text"><div class="file-name-row"><span class="file-name">${escapeHtml(e.name)}</span>${gitBadgeHtml}${tagDotsHtml}</div>${sub}</div></div>`;
  const modTd = document.createElement("td");
  modTd.textContent = fmtDate(e.modified);
  const typeTd = document.createElement("td");
  typeTd.textContent = kindLabel(e);
  const sizeTd = document.createElement("td");
  sizeTd.className = "num";
  sizeTd.textContent = displaySize(e);
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
  return tr;
}

function renderTableFor(paneIdx: number): void {
  const p = state.panes[paneIdx];
  const suf = paneIdx === 0 ? "" : "-1";
  const body = $(`file-body${suf}`);
  body.innerHTML = "";
  if (p.dupeGroups) {
    // Grouped: a header row per group, then its files (size order).
    for (const g of p.dupeGroups) {
      const head = document.createElement("tr");
      head.className = "dupe-head";
      const td = document.createElement("td");
      td.colSpan = 4;
      td.textContent = `${g.entries.length} identical files · ${fmtSize(g.size)} each`;
      head.appendChild(td);
      body.appendChild(head);
      for (const e of g.entries) body.appendChild(makeEntryRow(p, e));
    }
    return;
  }
  if (p.compareRows) {
    // Grouped by side: only here, only there, then different.
    const groups: [CompareRow["status"], string][] = [
      ["only-here", "Only in this pane"],
      ["only-there", "Only in the other pane"],
      ["different", "Different"],
    ];
    for (const [status, label] of groups) {
      const rows = p.compareRows.filter((r) => r.status === status);
      if (rows.length === 0) continue;
      const head = document.createElement("tr");
      head.className = "dupe-head";
      const td = document.createElement("td");
      td.colSpan = 4;
      td.textContent = `${label} · ${rows.length}`;
      head.appendChild(td);
      body.appendChild(head);
      for (const r of rows) body.appendChild(makeEntryRow(p, r.entry));
    }
    return;
  }
  const groups = groupedEntries(p);
  if (groups) {
    for (const g of groups) {
      body.appendChild(makeGroupHeadRow(p, g));
      if (p.collapsedGroups.has(g.key)) continue;
      for (const e of g.entries) body.appendChild(makeEntryRow(p, e));
    }
    return;
  }
  for (const e of p.filtered) body.appendChild(makeEntryRow(p, e));
}

function renderTable(): void {
  renderTableFor(state.activePane);
}

// First-frame video thumbnails come from ffmpeg (a subprocess), NOT from a
// <video> element: on this system WebKitGTK's media pipeline crashes the
// Tile thumbnails (images + video first frames) come from the Rust `thumb`
// command, which downscales and caches them on disk under ~/.cache. A
// <video> element is not an option: it crashes this WebKitGTK the moment
// one loads (GStreamer autoaudiosink is missing). SVG has no Rust decoder,
// so those tiles keep loading directly via the asset protocol. Thumbnails
// are fetched lazily when the tile scrolls into view; a missing ffmpeg, an
// undecodable file, or a cache miss that fails just leaves the icon.
const thumbCache = new Map<string, string>();

async function requestThumb(tile: HTMLElement, e: Entry): Promise<void> {
  const wrap = tile.querySelector(".tile-thumb-wrap");
  if (!wrap || tile.dataset.thumb !== "pending") return;
  const cached = thumbCache.get(e.path);
  if (cached === "failed") {
    tile.dataset.thumb = "failed";
    return;
  }
  if (cached) {
    const img = document.createElement("img");
    img.className = "tile-thumb";
    img.alt = "";
    img.src = cached;
    wrap.appendChild(img);
    tile.dataset.thumb = "done";
    return;
  }
  try {
    const b64 = await invoke<string>("thumb", { path: e.path });
    const url = `data:image/png;base64,${b64}`;
    thumbCache.set(e.path, url);
    if (!tile.isConnected || tile.dataset.thumb !== "pending") return;
    const img = document.createElement("img");
    img.className = "tile-thumb";
    img.alt = "";
    img.src = url;
    wrap.appendChild(img);
    tile.dataset.thumb = "done";
  } catch {
    thumbCache.set(e.path, "failed");
    tile.dataset.thumb = "failed";
  }
}

let thumbObserver: IntersectionObserver | null = null;

function thumbObserverFor(): IntersectionObserver {
  if (thumbObserver) return thumbObserver;
  thumbObserver = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        const tile = en.target as HTMLElement;
        thumbObserver!.unobserve(tile);
        const path = tile.dataset.path;
        // Tiles live in either pane; the entry may be in either listing.
        const entry = state.panes.flatMap((p) => p.filtered).find((x) => x.path === path);
        if (entry) void requestThumb(tile, entry);
      }
    },
    { rootMargin: "200px" },
  );
  return thumbObserver;
}

function makeTile(p: Pane, e: Entry): HTMLButtonElement {
  const pIsTrash = p.tabs[p.activeTab]?.isTrash ?? false;
  const tile = document.createElement("button");
  tile.type = "button";
  tile.className = "tile";
  tile.dataset.path = e.path;
  if (p.selection.has(e.path)) tile.classList.add("is-selected");
  tile.draggable = !pIsTrash;
  tile.addEventListener("dragstart", (ev) => onDragStart(ev, e, tile));
  tile.addEventListener("dragend", () => onDragEnd(tile));
  if (e.is_dir) attachDropTarget(tile, () => e.path);
  // Image files show a real thumbnail over the generic icon. The icon
  // stays underneath as the fallback: a broken or unsupported image just
  // drops its <img> and the icon shows through. SVG loads directly (the
  // Rust thumbnailer has no SVG decoder); other images and video get a
  // cached thumbnail, started lazily when the tile becomes visible.
  const kind = filterKindGroup(e);
  const iconWrap = document.createElement("span");
  iconWrap.className = "tile-thumb-wrap";
  iconWrap.innerHTML = iconSvg(iconFor(e), "icon tile-icon" + (e.is_dir ? " is-dir" : "") + " kind-" + kind);
  if (isImageEntry(e) && e.extension === "svg") {
    const img = document.createElement("img");
    img.className = "tile-thumb";
    img.alt = "";
    img.loading = "lazy";
    img.src = convertFileSrc(e.path);
    img.addEventListener("error", () => img.remove());
    iconWrap.appendChild(img);
  } else if ((isImageEntry(e) && e.extension !== "svg") || (e.extension && VIDEO_EXTS.has(e.extension))) {
    tile.dataset.thumb = "pending";
    thumbObserverFor().observe(tile);
  }
  const nameEl = document.createElement("span");
  nameEl.className = "tile-name";
  nameEl.textContent = e.name;
  tile.append(iconWrap, nameEl);
  const gitSt = getGitStatusFor(e.path, e.is_dir);
  if (gitSt) {
    const dot = document.createElement("span");
    dot.className = "tile-git-dot " + gitDotClass(gitSt);
    dot.title = gitTitleFor(gitSt);
    tile.appendChild(dot);
  }
  const entryTags = getTagsForPath(e.path);
  if (entryTags.length > 0) {
    const dotsWrap = document.createElement("span");
    dotsWrap.className = "tile-tag-dots";
    const isLight = document.documentElement.dataset.theme === "light";
    for (const t of entryTags) {
      const def = TAG_DEFS[t];
      const dot = document.createElement("span");
      dot.className = "tile-tag-dot";
      dot.style.backgroundColor = isLight ? def.lightColor : def.color;
      dot.title = `Tag: ${def.label}`;
      dotsWrap.appendChild(dot);
    }
    tile.appendChild(dotsWrap);
  }
  if (pIsTrash && e.original_path) tile.title = e.original_path;
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
  return tile;
}

function applyGridZoomFor(paneIdx: number): void {
  const p = state.panes[paneIdx];
  const suf = paneIdx === 0 ? "" : "-1";
  const wrap = $(`grid-wrap${suf}`);
  wrap.classList.remove("zoom-0", "zoom-1", "zoom-2");
  wrap.classList.add(`zoom-${p.tabs[p.activeTab]?.zoom ?? 1}`);
}

function renderGridFor(paneIdx: number): void {
  const p = state.panes[paneIdx];
  const suf = paneIdx === 0 ? "" : "-1";
  const wrap = $(`grid-wrap${suf}`);
  // Unobserve only this pane's old tiles before clearing them: the
  // observer is shared between panes, and a blanket disconnect() here
  // would drop the other pane's tiles before they ever intersect, so
  // their thumbnails would never load.
  if (thumbObserver) for (const t of wrap.querySelectorAll(".tile")) thumbObserver.unobserve(t);
  wrap.innerHTML = "";
  wrap.classList.remove("is-grouped");
  applyGridZoomFor(paneIdx);
  const groups = groupedEntries(p);
  if (groups) {
    wrap.classList.add("is-grouped");
    for (const g of groups) {
      wrap.appendChild(makeGroupHeadDiv(p, g));
      if (p.collapsedGroups.has(g.key)) continue;
      const section = document.createElement("div");
      section.className = "group-grid";
      for (const e of g.entries) section.appendChild(makeTile(p, e));
      wrap.appendChild(section);
    }
    return;
  }
  for (const e of p.filtered) wrap.appendChild(makeTile(p, e));
}

function renderGrid(): void {
  renderGridFor(state.activePane);
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
    // File URIs so the drag can leave the window: WebKitGTK turns this
    // into a native drag other apps accept (copy into a folder, attach
    // to a message, …). Internal drops still prefer DND_MIME above.
    ev.dataTransfer.setData(
      "text/uri-list",
      dragPaths.map((p) => "file://" + encodeURI(p)).join("\r\n"),
    );
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

function renderSelectionFor(paneIdx: number): void {
  const p = state.panes[paneIdx];
  const suf = paneIdx === 0 ? "" : "-1";
  document.querySelectorAll(`#file-body${suf} tr`).forEach((tr) => {
    tr.classList.toggle("is-selected", p.selection.has((tr as HTMLTableRowElement).dataset.path ?? ""));
  });
  document.querySelectorAll(`#grid-wrap${suf} .tile`).forEach((t, i) => {
    t.classList.toggle("is-selected", p.selection.has(p.filtered[i]?.path ?? ""));
  });
}

function renderSelection(): void {
  for (let i = 0; i < state.panes.length; i++) {
    if (i === 1 && !state.dual) continue;
    renderSelectionFor(i);
    // Duplicate results: each pane's bar follows its own selection.
    const p = state.panes[i];
    const suf = i === 0 ? "" : "-1";
    const bar = $(`dupe-bar${suf}`);
    bar.hidden = p.dupeGroups === null;
    if (p.dupeGroups) {
      const del = $(`dupe-delete${suf}`) as HTMLButtonElement;
      del.disabled = p.selection.size === 0;
      del.textContent = `Delete selected (${p.selection.size})`;
    }
    // Compare results: each pane's bar follows its own rows.
    const cbar = $(`compare-bar${suf}`);
    cbar.hidden = p.compareRows === null;
    if (p.compareRows) {
      const out = $(`compare-copy-out${suf}`) as HTMLButtonElement;
      const inn = $(`compare-copy-in${suf}`) as HTMLButtonElement;
      out.disabled = !p.compareRows.some((r) => r.status === "only-here");
      inn.disabled = !p.compareRows.some((r) => r.status === "only-there");
      const sum = $(`compare-summary${suf}`) as HTMLElement;
      if (p.compareSummary) sum.textContent = p.compareSummary;
    }
  }
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
  ($("act-rename") as HTMLButtonElement).disabled = n === 0;
  ($("act-props") as HTMLButtonElement).disabled = n !== 1;
  ($("act-paste") as HTMLButtonElement).disabled = state.clipboard === null;
  if (n === 0) {
    $("status-selection").textContent = "Nothing selected";
  } else {
    let bytes = 0;
    let files = 0;
    for (const p of state.selection) {
      const e = state.entries.find((x) => x.path === p);
      if (!e) continue;
      const sz = e.is_dir ? folderSizeCache.get(e.path) : e.size;
      if (sz !== undefined && sz !== null) {
        bytes += sz;
        files++;
      }
    }
    $("status-selection").textContent = files > 0 ? `${n} selected · ${fmtSize(bytes)}` : `${n} selected`;
  }
  void updatePreview();
}

// ---- Keyboard navigation (arrows move the selection, Enter opens) ----
// The selection is a single entry after any arrow move; Shift+arrow extends
// a range from the anchor (the last plain-clicked or arrow-landed item).
// renderSelection() updates the highlight, the toolbar, the status bar and
// the preview.

function moveSelectionTo(index: number, extend = false): void {
  const list = state.filtered;
  if (list.length === 0) return;
  const i = Math.max(0, Math.min(list.length - 1, index));
  if (extend && state.anchor && state.selection.size > 0) {
    const a = list.findIndex((e) => e.path === state.anchor);
    if (a !== -1) {
      const [lo, hi] = [Math.min(a, i), Math.max(a, i)];
      state.selection.clear();
      for (let j = lo; j <= hi; j++) state.selection.add(list[j].path);
      renderSelection();
      scrollSelectedIntoView(list[i].path);
      return;
    }
  }
  state.selection.clear();
  state.selection.add(list[i].path);
  state.anchor = list[i].path;
  renderSelection();
  scrollSelectedIntoView(list[i].path);
}

function moveSelection(delta: number, extend = false): void {
  const list = state.filtered;
  if (list.length === 0) return;
  if (extend && state.anchor && state.selection.size > 0) {
    const a = list.findIndex((e) => e.path === state.anchor);
    if (a !== -1) {
      // The focus is the selected end farthest from the anchor; extend from it.
      let focus = a;
      for (const p of state.selection) {
        const idx = list.findIndex((e) => e.path === p);
        if (idx !== -1 && Math.abs(idx - a) > Math.abs(focus - a)) focus = idx;
      }
      moveSelectionTo(focus + delta, true);
      return;
    }
  }
  const current = list.findIndex((e) => state.selection.has(e.path));
  const next = current === -1 ? (delta > 0 ? 0 : list.length - 1) : current + delta;
  moveSelectionTo(next);
}

/** ID suffix for the active pane's file-area elements ("" for pane 0, "-1" for pane 1). */
function paneSuffix(): string {
  return state.activePane === 0 ? "" : "-1";
}

function gridColumns(): number {
  const tiles = [...document.querySelectorAll(`#grid-wrap${paneSuffix()} .tile`)] as HTMLElement[];
  if (tiles.length === 0) return 1;
  const top = tiles[0].offsetTop;
  let n = 0;
  for (const t of tiles) {
    if (t.offsetTop === top) n++;
    else break;
  }
  return Math.max(1, n);
}

function pageStep(): number {
  const area = $(`file-area${paneSuffix()}`);
  const first = (document.querySelector(`#file-body${paneSuffix()} tr`) ??
    document.querySelector(`#grid-wrap${paneSuffix()} .tile`)) as HTMLElement | null;
  const h = first ? first.offsetHeight : 32;
  return Math.max(1, Math.floor(area.clientHeight / Math.max(1, h)));
}

function scrollSelectedIntoView(focusPath?: string): void {
  const path = focusPath ?? state.selection.values().next().value;
  if (!path) return;
  const suf = paneSuffix();
  for (const tr of document.querySelectorAll(`#file-body${suf} tr`)) {
    if ((tr as HTMLTableRowElement).dataset.path === path) {
      tr.scrollIntoView({ block: "nearest" });
      return;
    }
  }
  const idx = state.filtered.findIndex((e) => e.path === path);
  const tile = document.querySelectorAll(`#grid-wrap${suf} .tile`)[idx] as HTMLElement | undefined;
  tile?.scrollIntoView({ block: "nearest" });
}

function renderStatus(): void {
  const total = state.entries.length;
  const shown = state.filtered.length;
  if (state.dupeGroups) {
    const files = state.dupeGroups.reduce((n, g) => n + g.entries.length, 0);
    $("status-count").textContent = `${state.dupeGroups.length} duplicate groups · ${files} files`;
  } else if (state.compareRows) {
    $("status-count").textContent = state.compareSummary ?? `${shown} compare rows`;
  } else if (state.searching) {
    $("status-count").textContent = state.contentMatches
      ? `${shown} content matches for “${state.searchQuery}”`
      : `${shown} results for “${state.searchQuery}”`;
  } else {
    $("status-count").textContent =
      shown === total ? `${total} items` : `${shown} of ${total} items`;
  }
  const d = driveFor(state.path);
  if (d) {
    $("status-drive").textContent = `${fmtSize(d.free)} free of ${fmtSize(d.total)} on ${d.mount}`;
    $("side-free").textContent = `${fmtSize(d.free)} free`;
  } else {
    $("status-drive").textContent = "—";
    $("side-free").textContent = "—";
  }
}

function renderPaneHeads(): void {
  for (let i = 0; i < state.panes.length; i++) {
    if (i === 1 && !state.dual) continue;
    const suf = i === 0 ? "" : "-1";
    const el = $(`pane-head${suf}`) as HTMLElement | null;
    if (!el) continue;
    const tab = state.panes[i].tabs[state.panes[i].activeTab];
    el.textContent = tab?.isTrash ? "Trash" : tab?.path ?? "";
    el.classList.toggle("is-active", i === state.activePane);
  }
}

function render(): void {
  for (let i = 0; i < state.panes.length; i++) {
    if (i === 1 && !state.dual) continue;
    const p = state.panes[i];
    const suf = i === 0 ? "" : "-1";
    applyFilterSortFor(p);
    renderTableFor(i);
    renderGridFor(i);
    const tab = p.tabs[p.activeTab];
    $(`table-wrap${suf}`).hidden = tab?.view !== "details";
    $(`grid-wrap${suf}`).hidden = tab?.view !== "icons";
  }
  renderCrumbs();
  renderTabs();
  renderStatus();
  renderSelection();
  updateTrashNav();
  renderPaneHeads();
  $("view-details").classList.toggle("is-active", state.view === "details");
  $("view-icons").classList.toggle("is-active", state.view === "icons");
  // In Trash the Date column is the deletion date, not the modification date.
  const dateTh = document.querySelector('#file-table th[data-sort="modified"]');
  if (dateTh) dateTh.textContent = state.isTrash ? "Date deleted" : "Date modified";
  const dateOpt = document.querySelector('#sort-key option[value="modified"]');
  if (dateOpt) dateOpt.textContent = state.isTrash ? "Date deleted" : "Date modified";
}

function showStateFor(which: "loading" | "empty" | "error" | "full", paneIdx = state.activePane): void {
  const suf = paneIdx === 0 ? "" : "-1";
  const tab = state.panes[paneIdx].tabs[state.panes[paneIdx].activeTab];
  $(`loading${suf}`).hidden = which !== "loading";
  $(`empty${suf}`).hidden = which !== "empty";
  $(`error${suf}`).hidden = which !== "error";
  $(`table-wrap${suf}`).hidden = which !== "full" || tab?.view !== "details";
  $(`grid-wrap${suf}`).hidden = which !== "full" || tab?.view !== "icons";
  if (which === "empty") updateEmptyStateFor(paneIdx);
}

// The empty state says why the listing is empty, not just that it is:
// Trash, a search with no hits, a name filter with no match, or a folder
// that really has nothing in it. The Clear search button only appears
// when a filter is what emptied the listing.
function updateEmptyStateFor(paneIdx: number): void {
  const p = state.panes[paneIdx];
  const suf = paneIdx === 0 ? "" : "-1";
  const el = $(`empty${suf}`) as HTMLElement;
  const h2 = el.querySelector("h2")!;
  const para = el.querySelector("p")!;
  const newFolderBtn = $(`empty-new-folder${suf}`) as HTMLButtonElement;
  const clearBtn = $(`empty-clear-search${suf}`) as HTMLButtonElement;
  const tab = p.tabs[p.activeTab];
  const q = p.searchQuery.trim();
  clearBtn.hidden = true;
  if (tab?.isTrash) {
    h2.textContent = "Trash is empty";
    para.textContent = "Deleted items will appear here. You can restore them or delete them permanently.";
    newFolderBtn.hidden = true;
  } else if (p.searching && p.contentMode) {
    h2.textContent = "No content matches";
    para.textContent = `No file under this folder contains “${q}”.`;
    newFolderBtn.hidden = true;
    clearBtn.hidden = false;
  } else if (p.searching) {
    h2.textContent = "No results";
    para.textContent = `Nothing under this folder matches “${q}”.`;
    newFolderBtn.hidden = true;
    clearBtn.hidden = false;
  } else if (q) {
    h2.textContent = `No matches for “${q}”`;
    para.textContent = "Try a different name, or clear the search to see everything in this folder.";
    newFolderBtn.hidden = true;
    clearBtn.hidden = false;
  } else {
    h2.textContent = "This folder is empty";
    para.textContent = "Nothing here yet. Create a folder or paste files into it.";
    newFolderBtn.hidden = false;
  }
}

function clearSearch(): void {
  const search = $("search") as HTMLInputElement;
  search.value = "";
  if (state.searching) void navigate(state.path, false);
  else {
    state.searchQuery = "";
    render();
    showState(state.filtered.length === 0 ? "empty" : "full");
  }
}

function showState(which: "loading" | "empty" | "error" | "full"): void {
  showStateFor(which, state.activePane);
}

async function loadDirFor(paneIdx: number): Promise<void> {
  const p = state.panes[paneIdx];
  const suf = paneIdx === 0 ? "" : "-1";
  // A fresh listing leaves the result modes behind: content matches,
  // duplicate groups and compare rows describe the previous listing.
  p.contentMatches = null;
  p.dupeGroups = null;
  p.compareRows = null;
  p.compareSummary = null;
  // Drop only this pane's previous folder sizes: the other pane keeps its
  // cached sizes, and this pane never shows a size computed for a previous
  // state of a folder.
  for (const e of p.entries) if (e.is_dir) folderSizeCache.delete(e.path);
  showStateFor("loading", paneIdx);
  try {
    const tab = p.tabs[p.activeTab];
    let entries: Entry[] = [];
    if (tab?.tag) {
      const paths = getPathsForTag(tab.tag);
      entries = paths.length > 0 ? await invoke<Entry[]>("get_entries", { paths }) : [];
    } else if (tab?.isTrash) {
      entries = await invoke<Entry[]>("list_trash");
    } else {
      entries = await invoke<Entry[]>("list_dir", { path: tab?.path ?? "" });
    }
    p.entries = entries;
    render();
    showStateFor(p.filtered.length === 0 ? "empty" : "full", paneIdx);
    renderStatus();
    void requestFolderSizesFor(paneIdx);
    if (paneIdx === state.activePane) {
      void loadGitInfo();
    }
  } catch (err) {
    $(`error-text${suf}`).textContent = String(err);
    showStateFor("error", paneIdx);
    renderCrumbs();
    renderStatus();
  }
}

async function loadDir(): Promise<void> {
  return loadDirFor(state.activePane);
}

function onRowClick(ev: MouseEvent, e: Entry): void {
  if (ev.ctrlKey || ev.metaKey) {
    if (state.selection.has(e.path)) state.selection.delete(e.path);
    else state.selection.add(e.path);
    // The anchor follows the last clicked item (Explorer behaviour), so a
    // later Shift+click or Shift+arrow extends from here.
    state.anchor = e.path;
  } else if (ev.shiftKey && state.selection.size > 0) {
    const idx = state.filtered.findIndex((x) => x.path === e.path);
    const anchorIdx = state.anchor
      ? state.filtered.findIndex((x) => x.path === state.anchor)
      : state.filtered.findIndex((x) => state.selection.has(x.path));
    if (idx !== -1 && anchorIdx !== -1) {
      const [a, b] = [Math.min(idx, anchorIdx), Math.max(idx, anchorIdx)];
      for (let i = a; i <= b; i++) state.selection.add(state.filtered[i].path);
    }
  } else {
    state.selection.clear();
    state.selection.add(e.path);
    state.anchor = e.path;
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

async function doOpenTerminal(dir: string): Promise<void> {
  try {
    await invoke("open_terminal", { path: dir });
  } catch (err) {
    toast(`Could not open terminal: ${err}`, true);
  }
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

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API unavailable (or denied): fall back to execCommand.
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

async function doCopyPath(): Promise<void> {
  const paths = [...state.selection];
  const text = paths.length > 0 ? paths.join("\n") : state.path;
  if (await copyText(text)) {
    toast(paths.length > 1 ? `${paths.length} paths copied` : "Path copied");
  } else {
    toast("Could not copy to clipboard", true);
  }
}

/* ---- Open With ---- */

async function askOpenWith(e: Entry): Promise<void> {
  const dlg = $("dlg-open-with") as HTMLDialogElement;
  ($("open-with-title") as HTMLElement).textContent = `Open ${e.name} with`;
  const list = $("open-with-list");
  list.innerHTML = "";
  ($("open-with-empty") as HTMLElement).hidden = true;
  ($("open-with-default") as HTMLButtonElement).hidden = true;
  ($("open-with-always") as HTMLInputElement).checked = false;
  try {
    const apps = await invoke<AppInfo[]>("list_apps_for", { path: e.path });
    if (apps.length === 0) {
      ($("open-with-empty") as HTMLElement).hidden = false;
      ($("open-with-default") as HTMLButtonElement).hidden = false;
    }
    for (const app of apps) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ctx-item";
      b.textContent = app.name;
      b.addEventListener("click", () => {
        // App buttons are type="button": no form submit fires, so the
        // dialog is dismissed explicitly here (dialog bug-class sweep).
        const always = ($("open-with-always") as HTMLInputElement).checked;
        dlg.close();
        void doOpenWith(e, app, always);
      });
      list.appendChild(b);
    }
    ($("open-with-default") as HTMLButtonElement).onclick = () => {
      dlg.close();
      void openEntry(e);
    };
    dlg.showModal();
  } catch (err) {
    toast(`Could not list applications: ${err}`, true);
  }
}

async function doOpenWith(e: Entry, app: AppInfo, always = false): Promise<void> {
  if (always) {
    try {
      await invoke("set_default_app", { path: e.path, desktop: app.desktop });
      toast(`${app.name} is now the default for ${e.extension ? `.${e.extension}` : "this type"}`);
    } catch (err) {
      toast(`Could not set the default app: ${err}`, true);
    }
  }
  try {
    await invoke("open_with", { path: e.path, exec: app.exec });
  } catch (err) {
    toast(`Could not open with ${app.name}: ${err}`, true);
  }
}

/* ---- Batch rename ---- */

type BatchTab = "replace" | "prefix_suffix" | "number" | "case" | "clean";
let currentBatchTab: BatchTab = "replace";

type BatchOpts = {
  tab: BatchTab;
  // Replace
  find: string;
  replace: string;
  matchCase: boolean;
  isRegex: boolean;
  replaceAll: boolean;
  includeExt: boolean;
  // Prefix / Suffix
  prefix: string;
  suffix: string;
  // Numbering
  numBase: string;
  numPos: "suffix" | "prefix" | "replace";
  numSep: string;
  start: number;
  step: number;
  pad: number;
  // Case
  caseStyle: "lower" | "upper" | "title" | "sentence" | "camel" | "kebab" | "snake";
  caseScope: "name" | "ext" | "both";
  // Clean
  cleanSpaces: "dash" | "underscore" | "remove" | "keep";
  cleanSymbols: boolean;
  cleanNumbers: boolean;
  cleanTrim: boolean;
  // Global secondary case
  globalCase: "none" | "lower" | "upper" | "title" | "kebab" | "snake";
};

function splitStem(name: string): [string, string] {
  const i = name.lastIndexOf(".");
  if (i <= 0) return [name, ""];
  return [name.slice(0, i), name.slice(i)];
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function applyCase(s: string, style: string): string {
  if (!s) return "";
  switch (style) {
    case "lower":
      return s.toLowerCase();
    case "upper":
      return s.toUpperCase();
    case "title":
      return s.replace(/\w\S*/g, (txt) => txt.charAt(0).toUpperCase() + txt.slice(1).toLowerCase());
    case "sentence":
      return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
    case "camel":
      return s
        .replace(/[-_\s]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ""))
        .replace(/^(.)/, (c) => c.toLowerCase());
    case "kebab":
      return s
        .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
        .replace(/[-_\s]+/g, "-")
        .toLowerCase();
    case "snake":
      return s
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .replace(/[-_\s]+/g, "_")
        .toLowerCase();
    default:
      return s;
  }
}

function batchNewName(name: string, o: BatchOpts, i: number): string {
  const [stem, ext] = splitStem(name);
  let nextStem = stem;
  let nextExt = ext;

  if (o.tab === "replace") {
    if (o.find) {
      const target = o.includeExt ? name : stem;
      let replaced = target;
      try {
        if (o.isRegex) {
          const flags = (o.matchCase ? "" : "i") + (o.replaceAll ? "g" : "");
          const re = new RegExp(o.find, flags);
          replaced = target.replace(re, o.replace);
        } else {
          if (o.replaceAll) {
            if (o.matchCase) {
              replaced = target.split(o.find).join(o.replace);
            } else {
              replaced = target.replace(new RegExp(escapeRegex(o.find), "gi"), o.replace);
            }
          } else {
            if (o.matchCase) {
              replaced = target.replace(o.find, o.replace);
            } else {
              replaced = target.replace(new RegExp(escapeRegex(o.find), "i"), o.replace);
            }
          }
        }
      } catch {
        // Invalid regex during input — retain original target
      }
      if (o.includeExt) return replaced;
      nextStem = replaced;
    }
  } else if (o.tab === "prefix_suffix") {
    nextStem = o.prefix + stem + o.suffix;
  } else if (o.tab === "number") {
    const num = String(o.start + i * o.step).padStart(o.pad, "0");
    const base = o.numBase.trim() || stem;
    if (o.numPos === "prefix") {
      nextStem = base ? `${num}${o.numSep}${base}` : num;
    } else if (o.numPos === "suffix") {
      nextStem = base ? `${base}${o.numSep}${num}` : num;
    } else {
      nextStem = o.numBase.trim() ? `${o.numBase.trim()}${o.numSep}${num}` : num;
    }
  } else if (o.tab === "case") {
    if (o.caseScope === "name" || o.caseScope === "both") {
      nextStem = applyCase(stem, o.caseStyle);
    }
    if (o.caseScope === "ext" || o.caseScope === "both") {
      nextExt = ext ? "." + applyCase(ext.slice(1), o.caseStyle) : "";
    }
  } else if (o.tab === "clean") {
    let s = stem;
    if (o.cleanSpaces === "dash") s = s.replace(/\s+/g, "-");
    else if (o.cleanSpaces === "underscore") s = s.replace(/\s+/g, "_");
    else if (o.cleanSpaces === "remove") s = s.replace(/\s+/g, "");

    if (o.cleanSymbols) s = s.replace(/[^\w\s-]/g, "");
    if (o.cleanNumbers) s = s.replace(/[0-9]+/g, "");
    if (o.cleanTrim) s = s.trim();
    nextStem = s;
  }

  if (o.globalCase !== "none") {
    nextStem = applyCase(nextStem, o.globalCase);
  }

  return nextStem + nextExt;
}

function batchOpts(): BatchOpts {
  const getVal = (id: string) => {
    const el = $(id) as HTMLInputElement | HTMLSelectElement | null;
    return el ? el.value : "";
  };
  const getChecked = (id: string) => {
    const el = $(id) as HTMLInputElement | null;
    return el ? el.checked : false;
  };
  const getNum = (id: string, fallback: number) => {
    const el = $(id) as HTMLInputElement | null;
    const v = Number(el?.value);
    return Number.isFinite(v) ? v : fallback;
  };

  return {
    tab: currentBatchTab,
    find: getVal("batch-find"),
    replace: getVal("batch-replace"),
    matchCase: getChecked("batch-match-case"),
    isRegex: getChecked("batch-regex"),
    replaceAll: getChecked("batch-replace-all"),
    includeExt: getChecked("batch-include-ext"),
    prefix: getVal("batch-prefix"),
    suffix: getVal("batch-suffix"),
    numBase: getVal("batch-num-base"),
    numPos: (getVal("batch-num-pos") as any) || "suffix",
    numSep: getVal("batch-num-sep"),
    start: getNum("batch-num-start", 1),
    step: Math.max(1, getNum("batch-num-step", 1)),
    pad: Math.max(1, Math.min(6, getNum("batch-num-pad", 2))),
    caseStyle: (getVal("batch-case-style") as any) || "lower",
    caseScope: (getVal("batch-case-scope") as any) || "name",
    cleanSpaces: (getVal("batch-clean-spaces") as any) || "dash",
    cleanSymbols: getChecked("batch-clean-symbols"),
    cleanNumbers: getChecked("batch-clean-numbers"),
    cleanTrim: getChecked("batch-clean-trim"),
    globalCase: (getVal("batch-global-case") as any) || "none",
  };
}

function switchBatchTab(tab: BatchTab): void {
  currentBatchTab = tab;
  document.querySelectorAll(".batch-tab-btn").forEach((btn) => {
    btn.classList.toggle("is-active", (btn as HTMLElement).dataset.batchTab === tab);
  });
  for (const t of ["replace", "prefix_suffix", "number", "case", "clean"] as BatchTab[]) {
    const panel = $(`batch-panel-${t}`);
    if (panel) panel.hidden = t !== tab;
  }
  updateBatchPreview();
}

/** Live preview + collision check. Returns false when Apply must stay disabled. */
function updateBatchPreview(): boolean {
  const items = selectedEntries();
  const o = batchOpts();
  const preview = $("batch-preview");
  preview.innerHTML = "";
  const seen = new Set<string>();
  let ok = true;
  let changedCount = 0;
  let collisionCount = 0;

  for (let i = 0; i < items.length; i++) {
    const e = items[i];
    const next = batchNewName(e.name, o, i);
    const isChanged = next !== e.name;
    if (isChanged) changedCount++;

    const collision = next === "" || seen.has(next);
    if (collision) {
      ok = false;
      collisionCount++;
    }
    seen.add(next);

    const line = document.createElement("div");
    line.className = "batch-line";
    line.innerHTML = `
      <span class="batch-line-before" title="${escapeHtml(e.name)}">${escapeHtml(e.name)}</span>
      <span class="batch-line-arrow">→</span>
      <span class="batch-line-after ${collision ? "is-collision" : isChanged ? "is-changed" : ""}" title="${escapeHtml(next || "(empty name)")}">
        ${escapeHtml(next || "(empty name)")}
      </span>
    `;
    preview.appendChild(line);
  }

  const stats = $("batch-preview-stats");
  if (stats) {
    stats.textContent = `${changedCount} of ${items.length} will change${collisionCount > 0 ? ` · ⚠ ${collisionCount} collision${collisionCount > 1 ? "s" : ""}` : ""}`;
  }

  const err = $("batch-error");
  if (!ok) {
    err.textContent = "Conflict detected: Two files would get the same name (or an empty name). Please adjust the settings.";
    err.hidden = false;
  } else {
    err.hidden = true;
  }

  ($("batch-confirm") as HTMLButtonElement).disabled = !ok || items.length === 0;
  return ok;
}

function askBatchRename(): void {
  const items = selectedEntries();
  if (items.length === 0) return;
  ($("batch-count") as HTMLElement).textContent = `${items.length} item${items.length === 1 ? "" : "s"} selected to rename`;
  switchBatchTab(currentBatchTab);
  updateBatchPreview();
  ($("dlg-batch") as HTMLDialogElement).showModal();
}

async function doBatchRename(): Promise<void> {
  const items = selectedEntries();
  if (items.length === 0) return;
  if (!updateBatchPreview()) return; // collision — dialog stays open
  const o = batchOpts();
  ($("dlg-batch") as HTMLDialogElement).close();
  let done = 0;
  let failed = 0;
  let firstErr = "";
  for (let i = 0; i < items.length; i++) {
    const next = batchNewName(items[i].name, o, i);
    if (next === items[i].name) continue;
    try {
      await invoke("rename_path", { path: items[i].path, new_name: next });
      const oldPath = items[i].path;
      const parent = parentOf(oldPath) ?? "";
      const newPath = parent ? `${parent.replace(/\/+$/, "")}/${next}` : next;
      renamePathInTags(oldPath, newPath);
      done++;
    } catch (err) {
      failed++;
      if (!firstErr) firstErr = String(err);
    }
  }
  if (failed === 0) toast(`${done} item${done === 1 ? "" : "s"} renamed`);
  else toast(`${done} renamed, ${failed} failed: ${firstErr}`, true);
  await loadDir();
}

/* ---- Visual Disk Space Analyzer (Treemap & Ranked Breakdown) ---- */

interface SpaceChild {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  file_count: number;
  dir_count: number;
}

interface DiskUsageReport {
  path: string;
  name: string;
  total_size: number;
  total_files: number;
  total_dirs: number;
  items: SpaceChild[];
}

interface TreemapTile {
  item: SpaceChild;
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  pct: number;
}

const ANALYZER_PALETTE = [
  "#3b82f6", // Electric Blue
  "#8b5cf6", // Purple
  "#10b981", // Emerald Green
  "#f59e0b", // Amber
  "#06b6d4", // Cyan
  "#ec4899", // Rose / Pink
  "#6366f1", // Indigo
  "#14b8a6", // Teal
  "#f97316", // Warm Orange
  "#84cc16", // Lime
  "#a855f7", // Violet
  "#e11d48", // Crimson
  "#0284c7", // Sky
  "#059669", // Mint
  "#d97706", // Gold
];

let analyzerCurrentPath: string = "";
let analyzerReport: DiskUsageReport | null = null;
let analyzerViewMode: "both" | "treemap" | "list" = "both";
let analyzerIsScanning: boolean = false;
let analyzerScanToken: number = 0;
let analyzerResizeObserver: ResizeObserver | null = null;

function setAnalyzerViewMode(mode: "both" | "treemap" | "list"): void {
  analyzerViewMode = mode;
  const content = $("analyzer-content");
  if (content) {
    content.className = `analyzer-content view-${mode}`;
  }
  $("analyzer-view-both")?.classList.toggle("is-active", mode === "both");
  $("analyzer-view-treemap")?.classList.toggle("is-active", mode === "treemap");
  $("analyzer-view-list")?.classList.toggle("is-active", mode === "list");

  if (analyzerReport && (mode === "both" || mode === "treemap")) {
    requestAnimationFrame(() => {
      if (analyzerReport) renderTreemap(analyzerReport);
    });
  }
}

async function openDiskAnalyzer(path?: string): Promise<void> {
  const target = path || state.path;
  if (!target || state.isTrash) {
    toast("Cannot analyze Trash virtual directory", true);
    return;
  }
  const dlg = $("dlg-analyzer") as HTMLDialogElement;
  if (!dlg.open) {
    dlg.showModal();
    if (!analyzerResizeObserver) {
      const canvas = $("analyzer-treemap-canvas");
      if (canvas && typeof ResizeObserver !== "undefined") {
        analyzerResizeObserver = new ResizeObserver(() => {
          if (analyzerReport && dlg.open && (analyzerViewMode === "both" || analyzerViewMode === "treemap")) {
            renderTreemap(analyzerReport);
          }
        });
        analyzerResizeObserver.observe(canvas);
      }
    }
  }
  await scanAnalyzerPath(target);
}

function closeDiskAnalyzer(): void {
  const dlg = $("dlg-analyzer") as HTMLDialogElement;
  if (dlg.open) dlg.close();
  hideAnalyzerTooltip();
  void invoke("cancel_analyze_space");
}

async function scanAnalyzerPath(target: string): Promise<void> {
  analyzerCurrentPath = target;
  analyzerIsScanning = true;
  const currentToken = ++analyzerScanToken;

  renderAnalyzerBreadcrumbs(target);

  const loading = $("analyzer-loading");
  const loadingSub = $("analyzer-loading-sub");
  if (loading) loading.hidden = false;
  if (loadingSub) loadingSub.textContent = target;
  ($("analyzer-empty") as HTMLElement).hidden = true;

  ($("analyzer-stat-size") as HTMLElement).textContent = "Scanning…";
  ($("analyzer-stat-files") as HTMLElement).textContent = "—";
  ($("analyzer-stat-dirs") as HTMLElement).textContent = "—";
  ($("analyzer-stat-largest") as HTMLElement).textContent = "—";

  try {
    const report = await invoke<DiskUsageReport>("analyze_space", { path: target });
    if (currentToken !== analyzerScanToken) return;

    analyzerReport = report;
    analyzerIsScanning = false;
    if (loading) loading.hidden = true;

    renderAnalyzerView(report);
  } catch (err: any) {
    if (currentToken !== analyzerScanToken) return;
    analyzerIsScanning = false;
    if (loading) loading.hidden = true;
    const msg = String(err?.message || err || "Failed to analyze");
    if (!msg.includes("cancelled")) {
      toast(`Disk Analysis error: ${msg}`, true);
    }
  }
}

function renderAnalyzerBreadcrumbs(currPath: string): void {
  const container = $("analyzer-crumbs");
  if (!container) return;
  container.innerHTML = "";

  const segments = currPath.split("/").filter(Boolean);
  let accumulated = "";

  const rootBtn = document.createElement("button");
  rootBtn.type = "button";
  rootBtn.className = "analyzer-crumb-btn" + (currPath === "/" ? " is-current" : "");
  rootBtn.textContent = "/";
  rootBtn.title = "Root (/)";
  rootBtn.addEventListener("click", () => void scanAnalyzerPath("/"));
  container.appendChild(rootBtn);

  for (let i = 0; i < segments.length; i++) {
    accumulated += "/" + segments[i];
    const targetPath = accumulated;

    const sep = document.createElement("span");
    sep.className = "analyzer-crumb-sep";
    sep.textContent = "›";
    container.appendChild(sep);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "analyzer-crumb-btn" + (i === segments.length - 1 ? " is-current" : "");
    btn.textContent = segments[i];
    btn.title = targetPath;
    btn.addEventListener("click", () => void scanAnalyzerPath(targetPath));
    container.appendChild(btn);
  }

  container.scrollLeft = container.scrollWidth;
}

function renderAnalyzerView(report: DiskUsageReport): void {
  ($("analyzer-stat-size") as HTMLElement).textContent = fmtSize(report.total_size);
  ($("analyzer-stat-files") as HTMLElement).textContent = `${report.total_files.toLocaleString()} files`;
  ($("analyzer-stat-dirs") as HTMLElement).textContent = `${report.total_dirs.toLocaleString()} folders`;

  const largest = report.items.length > 0 ? report.items[0] : null;
  if (largest && report.total_size > 0) {
    const pct = ((largest.size / report.total_size) * 100).toFixed(1);
    ($("analyzer-stat-largest") as HTMLElement).textContent = `${largest.name} (${fmtSize(largest.size)} · ${pct}%)`;
    ($("analyzer-stat-largest") as HTMLElement).title = `${largest.path} · ${fmtSize(largest.size)} (${pct}%)`;
  } else {
    ($("analyzer-stat-largest") as HTMLElement).textContent = "—";
    ($("analyzer-stat-largest") as HTMLElement).title = "";
  }

  const emptyEl = $("analyzer-empty");
  if (report.items.length === 0 || report.total_size === 0) {
    if (emptyEl) emptyEl.hidden = false;
    ($("analyzer-treemap-svg") as unknown as SVGElement).innerHTML = "";
    ($("analyzer-table-body") as HTMLElement).innerHTML = "";
    ($("analyzer-list-count") as HTMLElement).textContent = "0 items";
    return;
  }

  if (emptyEl) emptyEl.hidden = true;

  renderTreemap(report);
  renderRankedList(report);
}

function computeSquarifiedTreemap(
  items: SpaceChild[],
  totalSize: number,
  width: number,
  height: number,
  palette: string[]
): TreemapTile[] {
  if (items.length === 0 || totalSize <= 0 || width <= 0 || height <= 0) return [];

  let activeItems: SpaceChild[] = [];
  if (items.length > 32) {
    activeItems = items.slice(0, 32);
    let othersSize = 0;
    let othersFiles = 0;
    let othersDirs = 0;
    for (let i = 32; i < items.length; i++) {
      othersSize += items[i].size;
      othersFiles += items[i].file_count;
      othersDirs += items[i].dir_count;
    }
    if (othersSize > 0) {
      activeItems.push({
        name: `[${items.length - 32} other items]`,
        path: "",
        is_dir: false,
        size: othersSize,
        file_count: othersFiles,
        dir_count: othersDirs,
      });
    }
  } else {
    activeItems = [...items];
  }

  const nonZero = activeItems.filter((it) => it.size > 0);
  if (nonZero.length === 0) return [];

  const nonZeroTotal = nonZero.reduce((acc, it) => acc + it.size, 0);
  const totalArea = width * height;
  const weights = nonZero.map((it) => (it.size / nonZeroTotal) * totalArea);

  const tiles: TreemapTile[] = [];

  let curX = 0;
  let curY = 0;
  let curW = width;
  let curH = height;

  let row: number[] = [];
  let rowItems: SpaceChild[] = [];
  let rowIndices: number[] = [];

  function worst(rowAreas: number[], sideLength: number): number {
    if (rowAreas.length === 0) return Infinity;
    const s2 = sideLength * sideLength;
    const sum = rowAreas.reduce((a, b) => a + b, 0);
    const sum2 = sum * sum;
    let max = -Infinity;
    let min = Infinity;
    for (const a of rowAreas) {
      if (a > max) max = a;
      if (a < min) min = a;
    }
    return Math.max((s2 * max) / sum2, sum2 / (s2 * min));
  }

  function layoutRow(rowAreas: number[], rowChildren: SpaceChild[], origIndices: number[]): void {
    const sum = rowAreas.reduce((a, b) => a + b, 0);
    if (sum <= 0) return;

    if (curW <= curH) {
      const rowHeight = sum / curW;
      let offset = 0;
      for (let i = 0; i < rowAreas.length; i++) {
        const itemW = rowAreas[i] / rowHeight;
        const it = rowChildren[i];
        const origIdx = origIndices[i];
        const pct = (it.size / totalSize) * 100;
        const color = !it.path ? "#475569" : palette[origIdx % palette.length];
        tiles.push({
          item: it,
          x: curX + offset,
          y: curY,
          w: itemW,
          h: rowHeight,
          color,
          pct,
        });
        offset += itemW;
      }
      curY += rowHeight;
      curH = Math.max(0, curH - rowHeight);
    } else {
      const rowWidth = sum / curH;
      let offset = 0;
      for (let i = 0; i < rowAreas.length; i++) {
        const itemH = rowAreas[i] / rowWidth;
        const it = rowChildren[i];
        const origIdx = origIndices[i];
        const pct = (it.size / totalSize) * 100;
        const color = !it.path ? "#475569" : palette[origIdx % palette.length];
        tiles.push({
          item: it,
          x: curX,
          y: curY + offset,
          w: rowWidth,
          h: itemH,
          color,
          pct,
        });
        offset += itemH;
      }
      curX += rowWidth;
      curW = Math.max(0, curW - rowWidth);
    }
  }

  for (let i = 0; i < nonZero.length; i++) {
    const area = weights[i];
    const s = Math.min(curW, curH);
    if (row.length === 0) {
      row.push(area);
      rowItems.push(nonZero[i]);
      rowIndices.push(i);
    } else {
      const currentWorst = worst(row, s);
      const testRow = [...row, area];
      const newWorst = worst(testRow, s);
      if (newWorst <= currentWorst) {
        row.push(area);
        rowItems.push(nonZero[i]);
        rowIndices.push(i);
      } else {
        layoutRow(row, rowItems, rowIndices);
        row = [area];
        rowItems = [nonZero[i]];
        rowIndices = [i];
      }
    }
  }

  if (row.length > 0) {
    layoutRow(row, rowItems, rowIndices);
  }

  return tiles;
}

function renderTreemap(report: DiskUsageReport): void {
  const canvas = $("analyzer-treemap-canvas");
  const svg = $("analyzer-treemap-svg") as unknown as SVGSVGElement;
  if (!canvas || !svg) return;

  const rect = canvas.getBoundingClientRect();
  const width = Math.max(rect.width - 16, 240);
  const height = Math.max(rect.height - 16, 160);

  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.innerHTML = "";

  const tiles = computeSquarifiedTreemap(
    report.items,
    report.total_size,
    width,
    height,
    ANALYZER_PALETTE
  );

  const pad = 2;

  for (const t of tiles) {
    const tileW = Math.max(t.w - pad * 2, 1);
    const tileH = Math.max(t.h - pad * 2, 1);
    const tileX = t.x + pad;
    const tileY = t.y + pad;

    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("class", "treemap-node");

    const r = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    r.setAttribute("class", "treemap-rect");
    r.setAttribute("x", tileX.toFixed(1));
    r.setAttribute("y", tileY.toFixed(1));
    r.setAttribute("width", tileW.toFixed(1));
    r.setAttribute("height", tileH.toFixed(1));
    r.setAttribute("rx", "4");
    r.setAttribute("ry", "4");
    r.setAttribute("fill", t.color);
    g.appendChild(r);

    if (tileW >= 48 && tileH >= 24) {
      const textName = document.createElementNS("http://www.w3.org/2000/svg", "text");
      textName.setAttribute("class", "treemap-label-name");
      textName.setAttribute("x", (tileX + 7).toFixed(1));
      textName.setAttribute("y", (tileY + (tileH >= 44 ? 18 : tileH / 2 + 4)).toFixed(1));

      const maxChars = Math.floor((tileW - 14) / 7.2);
      const displayName = t.item.name.length > maxChars && maxChars > 3
        ? t.item.name.slice(0, maxChars - 2) + "…"
        : t.item.name;
      textName.textContent = displayName;
      g.appendChild(textName);

      if (tileH >= 44 && tileW >= 60) {
        const textSize = document.createElementNS("http://www.w3.org/2000/svg", "text");
        textSize.setAttribute("class", "treemap-label-size");
        textSize.setAttribute("x", (tileX + 7).toFixed(1));
        textSize.setAttribute("y", (tileY + 34).toFixed(1));
        textSize.textContent = `${fmtSize(t.item.size)} (${t.pct.toFixed(1)}%)`;
        g.appendChild(textSize);
      }
    }

    g.addEventListener("mouseenter", (ev) => {
      showAnalyzerTooltip(ev, t);
    });
    g.addEventListener("mousemove", (ev) => {
      moveAnalyzerTooltip(ev);
    });
    g.addEventListener("mouseleave", () => {
      hideAnalyzerTooltip();
    });

    g.addEventListener("click", () => {
      if (t.item.is_dir && t.item.path) {
        hideAnalyzerTooltip();
        void scanAnalyzerPath(t.item.path);
      }
    });

    g.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      if (!t.item.path) return;
      showAnalyzerContextMenu(ev.clientX, ev.clientY, t.item);
    });

    svg.appendChild(g);
  }
}

function showAnalyzerTooltip(ev: MouseEvent, tile: TreemapTile): void {
  const tip = $("analyzer-tooltip");
  if (!tip) return;
  const isDir = tile.item.is_dir;
  const countStr = isDir
    ? `${tile.item.dir_count.toLocaleString()} folders, ${tile.item.file_count.toLocaleString()} files`
    : "1 file";

  tip.innerHTML = `
    <div class="analyzer-tip-title">
      <span style="color: ${tile.color}">${iconSvg(isDir ? ICONS.folder : iconForFileName(tile.item.name))}</span>
      <span>${escapeHtml(tile.item.name)}</span>
    </div>
    <div class="analyzer-tip-meta">
      <strong>${fmtSize(tile.item.size)}</strong>
      <span>(${tile.pct.toFixed(1)}% of folder)</span>
    </div>
    <div class="analyzer-tip-details">${countStr}</div>
    ${tile.item.path ? `<div class="analyzer-tip-details mono" style="font-size: 10px; opacity: 0.7;">${escapeHtml(tile.item.path)}</div>` : ""}
    <div class="analyzer-tip-hint">${isDir ? "Click to drill down • Right-click for options" : "Right-click for options"}</div>
  `;
  tip.hidden = false;
  moveAnalyzerTooltip(ev);
}

function moveAnalyzerTooltip(ev: MouseEvent): void {
  const tip = $("analyzer-tooltip");
  if (!tip || tip.hidden) return;
  const pad = 14;
  let x = ev.clientX + pad;
  let y = ev.clientY + pad;
  const tipRect = tip.getBoundingClientRect();
  if (x + tipRect.width > window.innerWidth - 8) {
    x = ev.clientX - tipRect.width - pad;
  }
  if (y + tipRect.height > window.innerHeight - 8) {
    y = ev.clientY - tipRect.height - pad;
  }
  tip.style.left = `${Math.max(x, 8)}px`;
  tip.style.top = `${Math.max(y, 8)}px`;
}

function hideAnalyzerTooltip(): void {
  const tip = $("analyzer-tooltip");
  if (tip) tip.hidden = true;
}

function renderRankedList(report: DiskUsageReport): void {
  const tbody = $("analyzer-table-body");
  const countEl = $("analyzer-list-count");
  if (!tbody) return;
  tbody.innerHTML = "";

  if (countEl) {
    countEl.textContent = `${report.items.length} items`;
  }

  const maxItemSize = report.items.length > 0 ? report.items[0].size : 1;

  for (let i = 0; i < report.items.length; i++) {
    const item = report.items[i];
    const pct = report.total_size > 0 ? (item.size / report.total_size) * 100 : 0;
    const barWidth = maxItemSize > 0 ? Math.max((item.size / maxItemSize) * 100, 1) : 0;
    const color = ANALYZER_PALETTE[i % ANALYZER_PALETTE.length];

    const tr = document.createElement("tr");
    tr.className = "analyzer-row";
    tr.title = item.is_dir ? "Click to drill down • Right-click for options" : "Right-click for options";

    const tdRank = document.createElement("td");
    tdRank.className = "analyzer-cell-rank";
    tdRank.textContent = String(i + 1);
    tr.appendChild(tdRank);

    const tdName = document.createElement("td");
    const nameWrap = document.createElement("div");
    nameWrap.className = "analyzer-cell-name" + (item.is_dir ? " is-dir" : "");
    const iconSvgStr = item.is_dir ? ICONS.folder : iconForFileName(item.name);
    nameWrap.innerHTML = `<span class="analyzer-item-icon" style="color: ${item.is_dir ? "var(--color-file-folder, var(--color-accent))" : "var(--color-muted)"}">${iconSvg(iconSvgStr)}</span><span class="analyzer-cell-name-text">${escapeHtml(item.name)}</span>`;
    tdName.appendChild(nameWrap);
    tr.appendChild(tdName);

    const tdUsage = document.createElement("td");
    const usageBox = document.createElement("div");
    usageBox.className = "analyzer-usage-box";
    usageBox.innerHTML = `
      <div class="analyzer-bar-track">
        <div class="analyzer-bar-fill" style="width: ${barWidth.toFixed(1)}%; background: ${color}"></div>
      </div>
      <span class="analyzer-pct-text">${pct.toFixed(1)}%</span>
    `;
    tdUsage.appendChild(usageBox);
    tr.appendChild(tdUsage);

    const tdSize = document.createElement("td");
    tdSize.className = "analyzer-cell-size num";
    tdSize.textContent = fmtSize(item.size);
    tr.appendChild(tdSize);

    const tdItems = document.createElement("td");
    tdItems.className = "analyzer-cell-items";
    if (item.is_dir) {
      const parts: string[] = [];
      if (item.dir_count > 0) parts.push(`${item.dir_count} folder${item.dir_count > 1 ? "s" : ""}`);
      if (item.file_count > 0) parts.push(`${item.file_count} file${item.file_count > 1 ? "s" : ""}`);
      tdItems.textContent = parts.join(", ") || "empty";
    } else {
      tdItems.textContent = "1 file";
    }
    tr.appendChild(tdItems);

    const tdActions = document.createElement("td");
    const actWrap = document.createElement("div");
    actWrap.className = "analyzer-actions-wrap";

    // Reveal in FileMon
    const btnReveal = document.createElement("button");
    btnReveal.type = "button";
    btnReveal.className = "analyzer-act-btn";
    btnReveal.title = "Reveal in FileMon";
    btnReveal.innerHTML = `<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3L5 8l5 5"/></svg>`;
    btnReveal.addEventListener("click", (ev) => {
      ev.stopPropagation();
      void revealInFileMon(item.path);
    });
    actWrap.appendChild(btnReveal);

    // Terminal
    const btnTerm = document.createElement("button");
    btnTerm.type = "button";
    btnTerm.className = "analyzer-act-btn";
    btnTerm.title = "Open in Terminal";
    btnTerm.innerHTML = `<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 3.5h11a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z"/><path d="M5 6.5l2 1.5-2 1.5M9 9.5h2"/></svg>`;
    btnTerm.addEventListener("click", (ev) => {
      ev.stopPropagation();
      void doOpenTerminal(item.is_dir ? item.path : (parentOf(item.path) || state.path));
    });
    actWrap.appendChild(btnTerm);

    tdActions.appendChild(actWrap);
    tr.appendChild(tdActions);

    tr.addEventListener("click", () => {
      if (item.is_dir && item.path) {
        void scanAnalyzerPath(item.path);
      }
    });

    tr.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      showAnalyzerContextMenu(ev.clientX, ev.clientY, item);
    });

    tbody.appendChild(tr);
  }
}

function showAnalyzerContextMenu(x: number, y: number, item: SpaceChild): void {
  if (!item.path) return;
  const items: { label: string; action: () => void | Promise<void> }[] = [];
  if (item.is_dir) {
    items.push({
      label: "Drill down into this folder",
      action: () => void scanAnalyzerPath(item.path),
    });
  }
  items.push({
    label: "Reveal in FileMon",
    action: () => void revealInFileMon(item.path),
  });
  items.push({
    label: "Open in Terminal",
    action: () => void doOpenTerminal(item.is_dir ? item.path : (parentOf(item.path) || state.path)),
  });
  items.push({
    label: "Copy Path",
    action: async () => {
      try {
        await navigator.clipboard.writeText(item.path);
        toast("Path copied to clipboard");
      } catch {
        toast("Could not copy to clipboard", true);
      }
    },
  });
  items.push({
    label: "Move to Trash",
    action: async () => {
      try {
        await trashPaths([item.path]);
        if (analyzerCurrentPath) void scanAnalyzerPath(analyzerCurrentPath);
      } catch (e: any) {
        toast(`Failed to trash: ${e?.message || e}`, true);
      }
    },
  });
  showMenuAt(x, y, items);
}

async function revealInFileMon(path: string): Promise<void> {
  const dlg = $("dlg-analyzer") as HTMLDialogElement;
  if (dlg.open) dlg.close();
  hideAnalyzerTooltip();
  const parent = parentOf(path);
  if (parent) {
    await navigate(parent);
    state.selection.clear();
    state.selection.add(path);
    renderSelection();
  } else {
    await navigate(path);
  }
}

/* ---- Duplicate finder ---- */

async function runDupes(): Promise<void> {
  if (state.isTrash) {
    toast("Find duplicates is not available in Trash");
    return;
  }
  try {
    const groups = await invoke<DupeGroup[]>("find_duplicates", { root: state.path });
    if (groups.length === 0) {
      toast("No duplicate files found in this folder");
      // Refreshing after deleting the last duplicates lands here: leave
      // the results mode instead of showing the stale groups.
      state.dupeGroups = null;
      await loadDir();
      return;
    }
    state.dupeGroups = groups;
    state.entries = groups.flatMap((g) => g.entries);
    // Keep the first file of each group, pre-select the rest for deletion.
    state.selection.clear();
    for (const g of groups) {
      for (const e of g.entries.slice(1)) state.selection.add(e.path);
    }
    const files = groups.reduce((n, g) => n + g.entries.length, 0);
    ($("dupe-summary") as HTMLElement).textContent =
      `${groups.length} duplicate groups · ${files} files · first of each group kept`;
    render();
    showState("full");
  } catch (err) {
    toast(`Find duplicates failed: ${err}`, true);
  }
}

async function deleteSelectedDupes(): Promise<void> {
  const paths = [...state.selection];
  if (paths.length === 0) return;
  try {
    const n = await invoke<number>("delete_paths", { paths });
    toast(`${n} item${n === 1 ? "" : "s"} moved to Trash`);
    await runDupes();
    if (!state.dupeGroups) await loadDir();
  } catch (err) {
    toast(`Delete failed: ${err}`, true);
  }
}

async function exitDupes(): Promise<void> {
  state.dupeGroups = null;
  await loadDir();
}

/* ---- Compare folders (dual pane) ---- */
// Compares the two panes' folders by name at the top level: same-name
// files are "same" when size and content hash match; folders with the same
// name are not recursed into. Rows are relative to the pane the compare
// was run from: only-here / only-there / different.

async function runCompare(): Promise<void> {
  if (!state.dual) {
    toast("Compare needs dual pane (Ctrl+Shift+D)", true);
    return;
  }
  const other = 1 - state.activePane;
  const tabA = state.panes[state.activePane].tabs[state.panes[state.activePane].activeTab];
  const tabB = state.panes[other].tabs[state.panes[other].activeTab];
  if (!tabA || !tabB || tabA.isTrash || tabB.isTrash) {
    toast("Compare is not available in Trash", true);
    return;
  }
  try {
    const res = await invoke<CompareResult>("compare_dirs", { a: tabA.path, b: tabB.path, includeHidden: state.showHidden });
    const rows: CompareRow[] = [
      ...res.only_a.map((e) => ({ entry: e, status: "only-here" as const })),
      ...res.only_b.map((e) => ({ entry: e, status: "only-there" as const })),
      ...res.different.map((e) => ({ entry: e, status: "different" as const })),
    ];
    state.compareRows = rows;
    state.compareSummary =
      `${res.only_a.length} only here · ${res.only_b.length} only there · ${res.different.length} different · ${res.same} identical (top level only)`;
    state.entries = rows.map((r) => r.entry);
    render();
    showState("full");
  } catch (err) {
    toast(`Compare failed: ${err}`, true);
  }
}

async function exitCompare(): Promise<void> {
  state.compareRows = null;
  state.compareSummary = null;
  await loadDir();
}

/** Copy the files that exist only on one side to the other side, then
 * re-run the compare so the result updates. `toOther` false means the
 * missing files come from the other pane into this one. */
async function copyMissing(toOther: boolean): Promise<void> {
  if (!state.compareRows) return;
  const other = 1 - state.activePane;
  const tab = state.panes[other].tabs[state.panes[other].activeTab];
  if (!tab || tab.isTrash) {
    toast("The other pane is showing the Trash", true);
    return;
  }
  const here = state.panes[state.activePane].tabs[state.panes[state.activePane].activeTab]?.path ?? "";
  const rows = state.compareRows.filter((r) =>
    toOther ? r.status === "only-here" : r.status === "only-there",
  );
  if (rows.length === 0) {
    toast("Nothing missing on that side");
    return;
  }
  const dest = toOther ? tab.path : here;
  const outcome = await runTransfer(rows.map((r) => r.entry.path), dest, true);
  if (outcome) {
    await loadDirFor(other);
    await runCompare();
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
  const oldPath = items[0].path;
  try {
    await invoke("rename_path", { path: oldPath, new_name: name });
    const parent = parentOf(oldPath) ?? "";
    const newPath = parent ? `${parent.replace(/\/+$/, "")}/${name}` : name;
    renamePathInTags(oldPath, newPath);
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
    // Permissions editor: octal input + Apply (type="button" so the
    // <form method="dialog"> never submits and closes the dialog early).
    const permDiv = document.createElement("div");
    const permDt = document.createElement("dt");
    permDt.textContent = "Permissions";
    const permDd = document.createElement("dd");
    permDd.className = "props-perm";
    const permInput = document.createElement("input");
    permInput.id = "props-mode";
    permInput.className = "mono";
    permInput.value = p.permissions;
    permInput.maxLength = 4;
    permInput.size = 5;
    permInput.setAttribute("aria-label", "Permissions in octal");
    const permBtn = document.createElement("button");
    permBtn.type = "button";
    permBtn.className = "btn btn-outline";
    permBtn.textContent = "Apply";
    const permMsg = document.createElement("span");
    permMsg.className = "props-msg";
    permBtn.addEventListener("click", async () => {
      const raw = permInput.value.trim();
      if (!/^[0-7]{3,4}$/.test(raw)) {
        permMsg.textContent = "Octal, e.g. 644";
        return;
      }
      try {
        const mode = await invoke<string>("set_permissions", { path: items[0].path, mode: parseInt(raw, 8) });
        permInput.value = mode;
        permMsg.textContent = "Applied";
        toast(`Permissions set to ${mode}`);
      } catch (err) {
        permMsg.textContent = `Failed: ${err}`;
      }
    });
    permDd.append(permInput, permBtn, permMsg);
    permDiv.append(permDt, permDd);
    body.appendChild(permDiv);
    // SHA-256 for files, computed after the dialog opens so the dialog
    // itself never waits on a big file.
    if (!p.is_dir) {
      const shaDiv = document.createElement("div");
      const shaDt = document.createElement("dt");
      shaDt.textContent = "SHA-256";
      const shaDd = document.createElement("dd");
      shaDd.className = "props-perm";
      const shaSpan = document.createElement("span");
      shaSpan.className = "mono props-sha";
      shaSpan.textContent = "Computing…";
      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.id = "props-copy-sha";
      copyBtn.className = "btn btn-outline";
      copyBtn.textContent = "Copy";
      copyBtn.disabled = true;
      copyBtn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(shaSpan.textContent ?? "");
          toast("SHA-256 copied");
        } catch {
          toast("Could not copy to clipboard", true);
        }
      });
      shaDd.append(shaSpan, copyBtn);
      shaDiv.append(shaDt, shaDd);
      body.appendChild(shaDiv);
    }
    ($("dlg-props") as HTMLDialogElement).showModal();
    // SHA-256 runs after the dialog opens so a big file never delays it.
    if (!p.is_dir) {
      try {
        const hash = await invoke<string>("file_sha256", { path: items[0].path });
        const shaSpan = document.querySelector(".props-sha");
        if (shaSpan) shaSpan.textContent = hash;
        const copyBtn = document.getElementById("props-copy-sha") as HTMLButtonElement | null;
        if (copyBtn) copyBtn.disabled = false;
      } catch {
        const shaSpan = document.querySelector(".props-sha");
        if (shaSpan) shaSpan.textContent = "Unavailable";
      }
    }
  } catch (err) {
    toast(`Could not read properties: ${err}`, true);
  }
}

let previewGen = 0;

// Syntax highlighting for the preview pane. One pass over the line, so a
// span never nests inside another span: strings, comments, numbers and
// keywords are classified by a single combined regex. Only & < > are
// escaped (quotes stay raw so the string alternative can match them).
const CODE_KEYWORDS: Record<string, Set<string>> = {
  clike: new Set("fn let mut pub struct enum impl trait use mod const static if else match for while loop return break continue in where type ref self Self crate super async await move dyn unsafe extern as true false null this new class extends implements import export from try catch finally throw void int string bool float double char switch case default do sizeof typedef namespace template typename virtual override final friend inline explicit operator delete sizeof".split(" ")),
  python: new Set("def class import from as return if elif else for while try except finally with lambda pass break continue True False None and or not in is print yield async await global nonlocal raise del assert".split(" ")),
  shell: new Set("if then else elif fi for while do done case esac function return echo exit in select until".split(" ")),
};
// Language family per extension: comment marker + keyword set. HTML/XML
// get tag highlighting instead of keywords.
const CODE_LANG: Record<string, { comment: string; kw: string; tag?: boolean }> = {
  rs: { comment: "//", kw: "clike" },
  js: { comment: "//", kw: "clike" },
  ts: { comment: "//", kw: "clike" },
  jsx: { comment: "//", kw: "clike" },
  tsx: { comment: "//", kw: "clike" },
  c: { comment: "//", kw: "clike" },
  h: { comment: "//", kw: "clike" },
  cpp: { comment: "//", kw: "clike" },
  hpp: { comment: "//", kw: "clike" },
  go: { comment: "//", kw: "clike" },
  java: { comment: "//", kw: "clike" },
  rb: { comment: "#", kw: "clike" },
  php: { comment: "//", kw: "clike" },
  swift: { comment: "//", kw: "clike" },
  kt: { comment: "//", kw: "clike" },
  py: { comment: "#", kw: "python" },
  sh: { comment: "#", kw: "shell" },
  toml: { comment: "#", kw: "shell" },
  yaml: { comment: "#", kw: "shell" },
  yml: { comment: "#", kw: "shell" },
  html: { comment: "<!--", kw: "clike", tag: true },
  xml: { comment: "<!--", kw: "clike", tag: true },
  css: { comment: "/*", kw: "clike" },
  scss: { comment: "//", kw: "clike" },
  json: { comment: "//", kw: "clike" },
};

function highlightCodeLine(line: string, ext: string): string {
  const lang = CODE_LANG[ext] ?? { comment: "//", kw: "clike" };
  const esc = line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const commentAlt =
    lang.comment === "#"
      ? "#.*"
      : lang.comment === "<!--"
        ? "&lt;!--.*?--&gt;"
        : lang.comment === "/*"
          ? "/\\*[\\s\\S]*?\\*/"
          : "//.*";
  const re = new RegExp(
    `("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*')|(${commentAlt})|(\\b\\d+(?:\\.\\d+)?\\b)` +
      (lang.tag ? `|(&lt;\\/?[a-zA-Z][^&]*?&gt;)` : ``) +
      `|(\\b[a-zA-Z_][a-zA-Z0-9_]*\\b)`,
    "g",
  );
  const kws = CODE_KEYWORDS[lang.kw];
  // Classify by the match's own shape, not by capture-group position:
  // the tag alternative exists only for HTML/XML, so the group indices
  // shift between languages and a positional replacer mislabels words.
  return esc.replace(re, (m) => {
    if (m.startsWith('"') || m.startsWith("'")) return `<span class="tok-str">${m}</span>`;
    if (m.startsWith("/") || m.startsWith("#") || m.startsWith("&lt;!--")) return `<span class="tok-com">${m}</span>`;
    if (/^\d/.test(m)) return `<span class="tok-num">${m}</span>`;
    if (m.startsWith("&lt;")) return `<span class="tok-tag">${m}</span>`;
    if (kws.has(m)) return `<span class="tok-kw">${m}</span>`;
    return m;
  });
}
function renderPreviewTags(container: HTMLElement, path: string): void {
  const section = document.createElement("div");
  section.className = "preview-tags-section";

  const title = document.createElement("div");
  title.className = "preview-tags-title";
  title.textContent = "Tags";
  section.appendChild(title);

  const pills = document.createElement("div");
  pills.className = "preview-tags-pills";

  const isLight = document.documentElement.dataset.theme === "light";
  const activeTags = getTagsForPath(path);

  for (const tagKey of ALL_TAGS) {
    const def = TAG_DEFS[tagKey];
    const isTagged = activeTags.includes(tagKey);
    const col = isLight ? def.lightColor : def.color;

    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "preview-tag-pill" + (isTagged ? " is-active" : "");
    pill.innerHTML = `<span class="file-tag-dot" style="background:${col}"></span><span>${escapeHtml(def.label)}</span>`;
    pill.title = isTagged ? `Remove ${def.label} tag` : `Add ${def.label} tag`;
    pill.addEventListener("click", () => {
      toggleTagForPaths([path], tagKey);
    });
    pills.appendChild(pill);
  }

  section.appendChild(pills);
  container.appendChild(section);
}

async function updatePreview(): Promise<void> {
  if (!state.previewOpen) return;
  // A newer preview supersedes this one: the folder/text branches await a
  // backend call, and a stale one resolving late must not overwrite the
  // preview the user is looking at now (it used to clobber an image
  // preview with the previous folder's "Folder" note).
  const gen = ++previewGen;
  const body = $("preview-body");
  const items = selectedEntries();
  if (items.length !== 1) {
    $("preview-title").textContent = "Preview";
    body.innerHTML = `<p class="preview-note">Select one file to preview it here.</p>`;
    return;
  }
  const e = items[0];
  const finish = () => {
    if (!state.isTrash) renderPreviewTags(body, e.path);
  };
  $("preview-title").textContent = e.name;
  if (e.is_dir) {
    try {
      const p = await invoke<Properties>("get_properties", { path: e.path });
      if (gen !== previewGen) return;
      body.innerHTML = `<dl class="detail-grid"><div><dt>Type</dt><dd>Folder</dd></div><div><dt>Size</dt><dd>${fmtSize(p.size)}</dd></div><div><dt>Items</dt><dd>${p.items ?? 0}</dd></div><div><dt>Modified</dt><dd>${fmtDate(p.modified)}</dd></div></dl>`;
    } catch {
      if (gen !== previewGen) return;
      body.innerHTML = `<p class="preview-note">Folder</p>`;
    }
    finish();
    return;
  }
  if (e.extension && IMAGE_EXTS.has(e.extension)) {
    const url = convertFileSrc(e.path);
    const wrap = document.createElement("div");
    wrap.className = "preview-img-wrap";
    const img = document.createElement("img");
    img.className = "preview-img";
    img.src = url;
    img.alt = `Preview of ${e.name}`;
    img.title = "Click to toggle actual size";
    img.onerror = () => {
      body.innerHTML = `<p class="preview-note">Could not preview this image.</p>`;
    };
    // Click toggles fit-width vs actual size; the caption shows the
    // dimensions once the image has loaded.
    const caption = document.createElement("p");
    caption.className = "preview-caption";
    caption.textContent = fmtSize(e.size ?? 0);
    img.onload = () => {
      if (gen !== previewGen) return;
      caption.textContent = `${img.naturalWidth} × ${img.naturalHeight} · ${fmtSize(e.size ?? 0)}`;
    };
    img.addEventListener("click", () => img.classList.toggle("is-zoomed"));
    wrap.append(img, caption);
    body.innerHTML = "";
    body.appendChild(wrap);
    finish();
    return;
  }
  if (e.extension === "pdf") {
    // WebKitGTK renders PDFs natively in an <embed>; if this engine ever
    // stops doing so the fallback button still opens the file's app.
    body.innerHTML = "";
    body.appendChild(makePdfPreview(e));
    finish();
    return;
  }
  if (e.extension && ARCHIVE_EXTS.has(e.extension)) {
    try {
      const entries = await invoke<ArchiveEntry[]>("list_archive", { path: e.path });
      if (gen !== previewGen) return;
      body.innerHTML = "";
      body.appendChild(makeArchivePreview(e, entries));
      finish();
      return;
    } catch {
      /* not a readable archive — fall through to summary */
    }
  }
  if ((e.extension === "md" || e.extension === "markdown") && (e.size ?? 0) < 200_000) {
    try {
      const text = await invoke<string>("read_text", { path: e.path });
      if (gen !== previewGen) return;
      const div = document.createElement("div");
      div.className = "md-preview";
      div.innerHTML = renderMarkdown(text);
      body.innerHTML = "";
      body.appendChild(div);
      finish();
      return;
    } catch {
      /* fall through to summary */
    }
  }
  if (e.extension && TEXT_EXTS.has(e.extension) && (e.size ?? 0) < 200_000) {
    try {
      const text = await invoke<string>("read_text", { path: e.path });
      if (gen !== previewGen) return;
      const { pre, note } = makePreviewText(e, text);
      body.innerHTML = "";
      body.appendChild(pre);
      if (note) body.appendChild(note);
      finish();
      return;
    } catch {
      /* fall through to summary */
    }
  }
  body.innerHTML = `<dl class="detail-grid"><div><dt>Type</dt><dd>${kindLabel(e)}</dd></div><div><dt>Size</dt><dd>${fmtSize(e.size ?? 0)}</dd></div><div><dt>Modified</dt><dd>${fmtDate(e.modified)}</dd></div></dl>`;
  finish();
}

function setPreview(open: boolean): void {
  state.previewOpen = open;
  $("preview").hidden = !open;
  $("preview-toggle").setAttribute("aria-pressed", String(open));
  $("preview-toggle").classList.toggle("is-active", open);
  if (open) void updatePreview();
}

// Text preview shared by the preview pane and Quick Look: first 200 lines
// with line numbers; code files get syntax highlighting.
type ArchiveEntry = { name: string; size: number | null; is_dir: boolean };

// Extensions whose contents can be listed without extracting.
const ARCHIVE_EXTS = new Set(["zip", "tar", "tgz", "gz", "xz", "bz2"]);

/** Archive listing for the preview pane and Quick Look: name + size rows. */
function makeArchivePreview(e: Entry, entries: ArchiveEntry[]): HTMLElement {
  const wrap = document.createElement("div");
  const head = document.createElement("p");
  head.className = "preview-caption";
  head.textContent = `Archive · ${entries.length} ${entries.length === 1 ? "entry" : "entries"}`;
  const list = document.createElement("div");
  list.className = "archive-list";
  for (const a of entries) {
    const row = document.createElement("div");
    row.className = "archive-row";
    const name = document.createElement("span");
    name.className = "mono archive-name";
    name.textContent = a.name;
    const size = document.createElement("span");
    size.className = "archive-size";
    size.textContent = a.is_dir || a.size === null ? "—" : fmtSize(a.size);
    row.append(name, size);
    list.appendChild(row);
  }
  wrap.append(head, list);
  return wrap;
}

/** Small Markdown renderer for the preview pane. The file content is
 * escaped first so it can never inject markup; links are http(s) only. */
function renderMarkdown(text: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const codes: string[] = [];
  const inline = (s: string): string => {
    let out = esc(s).replace(/`([^`]+)`/g, (_m, c) => {
      codes.push(c);
      return `\u0000${codes.length - 1}\u0000`;
    });
    out = out
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return out.replace(/\u0000(\d+)\u0000/g, (_m, i) => `<code>${codes[Number(i)]}</code>`);
  };
  const lines = text.split("\n");
  const html: string[] = [];
  let inCode = false;
  let codeBuf: string[] = [];
  let listBuf: string[] = [];
  const flushList = () => {
    if (listBuf.length) {
      html.push(`<ul>${listBuf.map((l) => `<li>${inline(l)}</li>`).join("")}</ul>`);
      listBuf = [];
    }
  };
  for (const raw of lines) {
    if (raw.trim().startsWith("```")) {
      if (inCode) {
        html.push(`<pre class="md-code">${esc(codeBuf.join("\n"))}</pre>`);
        codeBuf = [];
        inCode = false;
      } else {
        flushList();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(raw);
      continue;
    }
    const h = raw.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      flushList();
      html.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
      continue;
    }
    const q = raw.match(/^>\s?(.*)$/);
    if (q) {
      flushList();
      html.push(`<blockquote>${inline(q[1])}</blockquote>`);
      continue;
    }
    const li = raw.match(/^[-*]\s+(.*)$/);
    if (li) {
      listBuf.push(li[1]);
      continue;
    }
    if (raw.trim() === "") {
      flushList();
      continue;
    }
    flushList();
    html.push(`<p>${inline(raw)}</p>`);
  }
  if (inCode) html.push(`<pre class="md-code">${esc(codeBuf.join("\n"))}</pre>`);
  flushList();
  return html.join("\n");
}

function makePreviewText(e: Entry, text: string): { pre: HTMLPreElement; note: HTMLParagraphElement | null } {
  const lines = text.split("\n");
  const shown = lines.slice(0, 200);
  const pre = document.createElement("pre");
  pre.className = "preview-text";
  const isCode = e.extension ? CODE_EXTS.has(e.extension) : false;
  if (isCode) {
    pre.innerHTML = shown
      .map((l, i) => `<span class="line-num">${String(i + 1).padStart(4, " ")}</span>  ${highlightCodeLine(l, e.extension!)}`)
      .join("\n");
  } else {
    pre.textContent = shown.map((l, i) => `${String(i + 1).padStart(4, " ")}  ${l}`).join("\n");
  }
  const note = lines.length > 200 ? document.createElement("p") : null;
  if (note) {
    note.className = "preview-caption";
    note.textContent = `Showing first 200 of ${lines.length} lines`;
  }
  return { pre, note };
}

// PDF preview shared by the preview pane and Quick Look.
function makePdfPreview(e: Entry): DocumentFragment {
  const frag = document.createDocumentFragment();
  const embed = document.createElement("embed");
  embed.className = "preview-pdf";
  embed.src = convertFileSrc(e.path);
  embed.type = "application/pdf";
  frag.appendChild(embed);
  const openBtn = document.createElement("button");
  openBtn.type = "button";
  openBtn.className = "btn btn-outline";
  openBtn.textContent = "Open with default app";
  openBtn.addEventListener("click", () => void invoke("open_path", { path: e.path }));
  const cap = document.createElement("p");
  cap.className = "preview-caption";
  cap.textContent = fmtSize(e.size ?? 0);
  const row = document.createElement("div");
  row.className = "preview-pdf-row";
  row.append(openBtn, cap);
  frag.appendChild(row);
  return frag;
}

/* ---- Quick Look (Space): a large centred preview of the selected file ---- */

let quicklookOpen = false;
let quicklookGen = 0;

function openQuickLook(): void {
  if (selectedEntries().length !== 1) return;
  quicklookOpen = true;
  $("quicklook").hidden = false;
  void renderQuickLook();
}

function closeQuickLook(): void {
  if (!quicklookOpen) return;
  quicklookOpen = false;
  const body = $("quicklook-body");
  body.querySelectorAll("video").forEach((v) => v.pause());
  body.innerHTML = "";
  $("quicklook").hidden = true;
}

function moveQuickLook(delta: number): void {
  const list = state.filtered;
  const cur = selectedEntries()[0];
  const idx = cur ? list.findIndex((x) => x.path === cur.path) : -1;
  const next = list[Math.min(list.length - 1, Math.max(0, idx + delta))];
  if (!next) return;
  state.selection.clear();
  state.selection.add(next.path);
  state.anchor = next.path;
  renderSelection();
  void renderQuickLook();
  scrollSelectedIntoView(next.path);
}

async function renderQuickLook(): Promise<void> {
  const gen = ++quicklookGen;
  const body = $("quicklook-body");
  const cap = $("quicklook-caption");
  const items = selectedEntries();
  if (items.length !== 1) {
    closeQuickLook();
    return;
  }
  const e = items[0];
  $("quicklook-title").textContent = e.name;
  body.innerHTML = "";
  cap.textContent = "";
  if (e.is_dir) {
    try {
      const p = await invoke<Properties>("get_properties", { path: e.path });
      if (gen !== quicklookGen) return;
      body.innerHTML = `<dl class="detail-grid"><div><dt>Type</dt><dd>Folder</dd></div><div><dt>Size</dt><dd>${fmtSize(p.size)}</dd></div><div><dt>Items</dt><dd>${p.items ?? 0}</dd></div><div><dt>Modified</dt><dd>${fmtDate(p.modified)}</dd></div></dl>`;
    } catch {
      if (gen !== quicklookGen) return;
      body.innerHTML = `<p class="preview-note">Folder</p>`;
    }
    return;
  }
  if (e.extension && IMAGE_EXTS.has(e.extension)) {
    const img = document.createElement("img");
    img.className = "quicklook-img";
    img.src = convertFileSrc(e.path);
    img.alt = `Preview of ${e.name}`;
    img.onerror = () => {
      body.innerHTML = `<p class="preview-note">Could not preview this image.</p>`;
    };
    img.onload = () => {
      if (gen !== quicklookGen) return;
      cap.textContent = `${img.naturalWidth} × ${img.naturalHeight} · ${fmtSize(e.size ?? 0)}`;
    };
    body.appendChild(img);
    return;
  }
  if (e.extension && VIDEO_EXTS.has(e.extension)) {
    // No inline player: a <video> element crashes this WebKitGTK (missing
    // GStreamer autoaudiosink). Show the first frame instead, with a button
    // to open the file's own player.
    try {
      const b64 = await invoke<string>("thumb", { path: e.path });
      if (gen !== quicklookGen) return;
      const img = document.createElement("img");
      img.className = "quicklook-img";
      img.src = `data:image/png;base64,${b64}`;
      img.alt = `First frame of ${e.name}`;
      body.appendChild(img);
    } catch {
      if (gen !== quicklookGen) return;
      body.innerHTML = `<dl class="detail-grid"><div><dt>Type</dt><dd>${kindLabel(e)}</dd></div><div><dt>Size</dt><dd>${fmtSize(e.size ?? 0)}</dd></div><div><dt>Modified</dt><dd>${fmtDate(e.modified)}</dd></div></dl>`;
    }
    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "btn btn-outline";
    openBtn.textContent = "Open with default app";
    openBtn.addEventListener("click", () => void invoke("open_path", { path: e.path }));
    const row = document.createElement("div");
    row.className = "preview-pdf-row";
    row.appendChild(openBtn);
    body.appendChild(row);
    cap.textContent = fmtSize(e.size ?? 0);
    return;
  }
  if (e.extension === "pdf") {
    body.appendChild(makePdfPreview(e));
    return;
  }
  if (e.extension && ARCHIVE_EXTS.has(e.extension)) {
    try {
      const entries = await invoke<ArchiveEntry[]>("list_archive", { path: e.path });
      if (gen !== quicklookGen) return;
      body.appendChild(makeArchivePreview(e, entries));
      return;
    } catch {
      /* fall through to summary */
    }
  }
  if ((e.extension === "md" || e.extension === "markdown") && (e.size ?? 0) < 200_000) {
    try {
      const text = await invoke<string>("read_text", { path: e.path });
      if (gen !== quicklookGen) return;
      const div = document.createElement("div");
      div.className = "md-preview";
      div.innerHTML = renderMarkdown(text);
      body.appendChild(div);
      return;
    } catch {
      /* fall through to summary */
    }
  }
  if (e.extension && TEXT_EXTS.has(e.extension) && (e.size ?? 0) < 200_000) {
    try {
      const text = await invoke<string>("read_text", { path: e.path });
      if (gen !== quicklookGen) return;
      const { pre, note } = makePreviewText(e, text);
      body.appendChild(pre);
      if (note) body.appendChild(note);
      return;
    } catch {
      /* fall through to summary */
    }
  }
  body.innerHTML = `<dl class="detail-grid"><div><dt>Type</dt><dd>${kindLabel(e)}</dd></div><div><dt>Size</dt><dd>${fmtSize(e.size ?? 0)}</dd></div><div><dt>Modified</dt><dd>${fmtDate(e.modified)}</dd></div></dl>`;
}

/* ---- Appearance (density, interface scale, grid zoom, grouping, accent) ---- */

type Density = "comfortable" | "compact";
type AccentName = "blue" | "emerald" | "violet" | "rose" | "amber" | "cyan" | "mono";

const ACCENT_PRESETS: Record<
  AccentName,
  {
    label: string;
    dark: { accent: string; accent2: string; subtle: string; ring: string };
    light: { accent: string; accent2: string; subtle: string; ring: string };
  }
> = {
  blue: {
    label: "Electric Blue",
    dark: { accent: "#3b82f6", accent2: "#60a5fa", subtle: "rgba(59, 130, 246, 0.15)", ring: "rgba(59, 130, 246, 0.4)" },
    light: { accent: "#2563eb", accent2: "#3b82f6", subtle: "rgba(37, 99, 235, 0.08)", ring: "rgba(37, 99, 235, 0.25)" },
  },
  emerald: {
    label: "Emerald Green",
    dark: { accent: "#10b981", accent2: "#34d399", subtle: "rgba(16, 185, 129, 0.15)", ring: "rgba(16, 185, 129, 0.4)" },
    light: { accent: "#059669", accent2: "#10b981", subtle: "rgba(5, 150, 105, 0.08)", ring: "rgba(5, 150, 105, 0.25)" },
  },
  violet: {
    label: "Cyber Violet",
    dark: { accent: "#8b5cf6", accent2: "#a78bfa", subtle: "rgba(139, 92, 246, 0.15)", ring: "rgba(139, 92, 246, 0.4)" },
    light: { accent: "#7c3aed", accent2: "#8b5cf6", subtle: "rgba(124, 58, 237, 0.08)", ring: "rgba(124, 58, 237, 0.25)" },
  },
  rose: {
    label: "Crimson Rose",
    dark: { accent: "#f43f5e", accent2: "#fb7185", subtle: "rgba(244, 63, 94, 0.15)", ring: "rgba(244, 63, 94, 0.4)" },
    light: { accent: "#e11d48", accent2: "#f43f5e", subtle: "rgba(225, 29, 72, 0.08)", ring: "rgba(225, 29, 72, 0.25)" },
  },
  amber: {
    label: "Amber Gold",
    dark: { accent: "#f59e0b", accent2: "#fbbf24", subtle: "rgba(245, 158, 11, 0.15)", ring: "rgba(245, 158, 11, 0.4)" },
    light: { accent: "#d97706", accent2: "#f59e0b", subtle: "rgba(217, 119, 6, 0.08)", ring: "rgba(217, 119, 6, 0.25)" },
  },
  cyan: {
    label: "Cyan Teal",
    dark: { accent: "#06b6d4", accent2: "#22d3ee", subtle: "rgba(6, 182, 212, 0.15)", ring: "rgba(6, 182, 212, 0.4)" },
    light: { accent: "#0891b2", accent2: "#06b6d4", subtle: "rgba(8, 145, 178, 0.08)", ring: "rgba(8, 145, 178, 0.25)" },
  },
  mono: {
    label: "Monochrome",
    dark: { accent: "#e4e4e7", accent2: "#ffffff", subtle: "rgba(255, 255, 255, 0.12)", ring: "rgba(255, 255, 255, 0.3)" },
    light: { accent: "#18181b", accent2: "#27272a", subtle: "rgba(24, 24, 27, 0.08)", ring: "rgba(24, 24, 27, 0.25)" },
  },
};

function getAccentColor(): AccentName {
  return (localStorage.getItem("filemon-accent") || "blue") as AccentName;
}

function applyAccentColor(a?: AccentName): void {
  const win = window as unknown as { __applyAccent?: (acc: string) => void };
  if (win.__applyAccent) {
    win.__applyAccent(a || getAccentColor());
    return;
  }
  const accent = a || getAccentColor();
  const preset = ACCENT_PRESETS[accent] || ACCENT_PRESETS.blue;
  const isLight = document.documentElement.dataset.theme === "light";
  const colors = isLight ? preset.light : preset.dark;

  const s = document.documentElement.style;
  s.setProperty("--color-accent", colors.accent);
  s.setProperty("--color-accent-2", colors.accent2);
  s.setProperty("--color-accent-subtle", colors.subtle);
  s.setProperty("--color-focus", colors.accent);
  s.setProperty("--color-focus-ring", colors.ring);
  s.setProperty("--color-file-folder", colors.accent);
  s.setProperty("--color-accent-gradient", `linear-gradient(135deg, ${colors.accent} 0%, ${colors.accent2} 100%)`);
  document.documentElement.dataset.accent = accent;
}

function setAccentColor(a: AccentName): void {
  localStorage.setItem("filemon-accent", a);
  applyAccentColor(a);
  syncAppearancePanel();
  toast(`Accent color set to ${ACCENT_PRESETS[a]?.label || a}`);
}

function applyDensity(): void {
  const d = (localStorage.getItem("filemon-density") || "comfortable") as Density;
  document.body.classList.toggle("density-compact", d === "compact");
}

function applyUiScale(): void {
  const s = Number(localStorage.getItem("filemon-ui-scale") || "1") || 1;
  ($("app") as HTMLElement).style.zoom = String(s);
}

function setDensity(d: Density): void {
  localStorage.setItem("filemon-density", d);
  applyDensity();
  syncAppearancePanel();
}

function setUiScale(s: number): void {
  localStorage.setItem("filemon-ui-scale", String(s));
  applyUiScale();
  syncAppearancePanel();
}

function setGridZoom(z: 0 | 1 | 2): void {
  state.zoom = z;
  saveTabs();
  render();
  syncAppearancePanel();
}

function setGroupBy(g: GroupMode): void {
  state.groupBy = g;
  state.pane.collapsedGroups.clear();
  saveTabs();
  render();
  syncAppearancePanel();
}

function syncAppearancePanel(): void {
  ($("appearance-group") as HTMLSelectElement).value = state.groupBy;
  document.querySelectorAll("#appearance-panel [data-density]").forEach((b) => {
    b.classList.toggle(
      "is-active",
      (b as HTMLElement).dataset.density === (localStorage.getItem("filemon-density") || "comfortable"),
    );
  });
  document.querySelectorAll("#appearance-panel [data-scale]").forEach((b) => {
    b.classList.toggle(
      "is-active",
      (b as HTMLElement).dataset.scale === (localStorage.getItem("filemon-ui-scale") || "1"),
    );
  });
  document.querySelectorAll("#appearance-panel [data-zoom]").forEach((b) => {
    b.classList.toggle("is-active", Number((b as HTMLElement).dataset.zoom) === state.zoom);
  });
  document.querySelectorAll("#appearance-panel [data-accent]").forEach((b) => {
    b.classList.toggle("is-active", (b as HTMLElement).dataset.accent === getAccentColor());
  });
}

function toggleAppearancePanel(open?: boolean): void {
  const panel = $("appearance-panel");
  const willOpen = open ?? panel.hidden;
  if (willOpen) {
    syncAppearancePanel();
    const rect = $("act-appearance").getBoundingClientRect();
    panel.style.top = `${rect.bottom + 6}px`;
    panel.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
    panel.hidden = false;
    $("act-appearance").setAttribute("aria-pressed", "true");
  } else {
    panel.hidden = true;
    $("act-appearance").setAttribute("aria-pressed", "false");
  }
}

/* ---- Advanced filters (toolbar Filter button) ---- */
// Reads the filter panel into the active pane's filter, then re-renders.
// Size inputs are KB; dates are yyyy-mm-dd from the date inputs.

function syncFilterPanel(): void {
  const f = state.pane.filter;
  ($("filter-kind") as HTMLSelectElement).value = f.kind;
  ($("filter-ext") as HTMLInputElement).value = f.ext;
  ($("filter-min") as HTMLInputElement).value = f.minSize === null ? "" : String(Math.round(f.minSize / 1024));
  ($("filter-max") as HTMLInputElement).value = f.maxSize === null ? "" : String(Math.round(f.maxSize / 1024));
  ($("filter-after") as HTMLInputElement).value = f.after ?? "";
  ($("filter-before") as HTMLInputElement).value = f.before ?? "";
  ($("act-filter") as HTMLButtonElement).classList.toggle("is-active", filterActive());
  ($("act-filter") as HTMLButtonElement).setAttribute("aria-pressed", String(filterActive()));
}

function applyFilterFromPanel(): void {
  const kb = (id: string): number | null => {
    const v = Number(($(`filter-${id}`) as HTMLInputElement).value);
    return Number.isFinite(v) && v >= 0 && ($(`filter-${id}`) as HTMLInputElement).value !== "" ? Math.round(v * 1024) : null;
  };
  state.pane.filter = {
    kind: ($("filter-kind") as HTMLSelectElement).value,
    ext: ($("filter-ext") as HTMLInputElement).value.trim().replace(/^\./, ""),
    minSize: kb("min"),
    maxSize: kb("max"),
    after: ($("filter-after") as HTMLInputElement).value || null,
    before: ($("filter-before") as HTMLInputElement).value || null,
  };
  ($("act-filter") as HTMLButtonElement).classList.toggle("is-active", filterActive());
  ($("act-filter") as HTMLButtonElement).setAttribute("aria-pressed", String(filterActive()));
  render();
  showState(state.filtered.length === 0 ? "empty" : "full");
}

function toggleFilterPanel(open?: boolean): void {
  const panel = $("filter-panel");
  const willOpen = open ?? panel.hidden;
  if (willOpen) {
    toggleAppearancePanel(false);
    syncFilterPanel();
    const rect = $("act-filter").getBoundingClientRect();
    panel.style.top = `${rect.bottom + 6}px`;
    panel.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
    panel.hidden = false;
    $("act-filter").setAttribute("aria-pressed", "true");
  } else {
    panel.hidden = true;
    if (!filterActive()) $("act-filter").setAttribute("aria-pressed", "false");
  }
}

function clearFilters(): void {
  state.pane.filter = { kind: "all", ext: "", minSize: null, maxSize: null, after: null, before: null };
  syncFilterPanel();
  render();
  showState(state.filtered.length === 0 ? "empty" : "full");
}

function showMenuAt(
  x: number,
  y: number,
  items: { label: string; disabled?: boolean; action: () => void | Promise<void> }[],
  topElement?: HTMLElement | null,
): void {
  const menu = $("ctx-menu");
  menu.innerHTML = "";
  if (topElement) {
    menu.appendChild(topElement);
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

function makeContextMenuTagsBar(paths: string[]): HTMLElement | null {
  if (paths.length === 0) return null;
  const row = document.createElement("div");
  row.className = "ctx-tags-row";

  const label = document.createElement("span");
  label.className = "ctx-tags-label";
  label.textContent = "Tags";
  row.appendChild(label);

  const dotsWrap = document.createElement("div");
  dotsWrap.className = "ctx-tags-dots";

  const isLight = document.documentElement.dataset.theme === "light";
  const map = loadFileTags();
  let hasAnyTag = false;

  for (const tagKey of ALL_TAGS) {
    const def = TAG_DEFS[tagKey];
    const col = isLight ? def.lightColor : def.color;
    const isTagged = paths.every((p) => (map[p] || []).includes(tagKey));
    if (paths.some((p) => (map[p] || []).includes(tagKey))) {
      hasAnyTag = true;
    }

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ctx-tag-btn" + (isTagged ? " is-active" : "");
    btn.style.backgroundColor = col;
    btn.style.color = col;
    btn.title = `Tag: ${def.label}` + (isTagged ? " (Click to remove)" : "");
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      toggleTagForPaths(paths, tagKey);
      hideContextMenu();
    });
    dotsWrap.appendChild(btn);
  }
  row.appendChild(dotsWrap);

  if (hasAnyTag) {
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "ctx-tag-clear-btn";
    clearBtn.title = "Clear all tags";
    clearBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>`;
    clearBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      clearTagsForPaths(paths);
      hideContextMenu();
    });
    row.appendChild(clearBtn);
  }

  return row;
}

function showPinMenu(x: number, y: number, path: string): void {
  showMenuAt(x, y, [{ label: "Unpin from Quick access", action: () => togglePin(path) }]);
}

function showDriveMenu(x: number, y: number, d: Drive): void {
  const isMounted = d.mounted !== false && !!d.mount;
  const items: { label: string; disabled?: boolean; action: () => void | Promise<void> }[] = [];
  if (isMounted) {
    items.push({ label: "Open", action: () => void navigate(d.mount) });
    items.push({ label: "Open in new tab", action: () => void openInNewTab(d.mount) });
    items.push({ label: "Analyze Disk Space", action: () => void openDiskAnalyzer(d.mount) });
    items.push({
      label: "Copy mount path",
      action: async () => {
        try {
          await navigator.clipboard.writeText(d.mount);
          toast("Mount path copied");
        } catch {
          toast("Could not copy to clipboard", true);
        }
      },
    });
    const isSystemMount = d.mount === "/" || d.mount === "/boot" || d.mount === "/home";
    if (!isSystemMount) {
      items.push({ label: "Unmount", action: () => void unmountDrive(d) });
    }
  } else {
    items.push({ label: "Mount and open", action: () => void mountDrive(d) });
    if (d.device) {
      items.push({
        label: "Copy device path",
        action: async () => {
          try {
            await navigator.clipboard.writeText(d.device!);
            toast("Device path copied");
          } catch {
            toast("Could not copy to clipboard", true);
          }
        },
      });
    }
  }
  showMenuAt(x, y, items);
}

function showContextMenu(x: number, y: number, target: Entry | null): void {
  const items: { label: string; disabled?: boolean; action: () => void | Promise<void> }[] = [];
  const selectedPaths = state.selection.size > 0
    ? [...state.selection]
    : target
      ? [target.path]
      : [];
  const tagsBar = !state.isTrash && selectedPaths.length > 0 ? makeContextMenuTagsBar(selectedPaths) : null;

  if (state.isTrash) {
    if (target) {
      items.push({ label: "Restore", action: () => void doRestore() });
      items.push({ label: "Delete permanently", action: askDelete });
    } else {
      items.push({ label: "Empty Trash", disabled: state.entries.length === 0, action: askEmptyTrash });
    }
  } else if (target) {
    if (state.tag) {
      items.push({
        label: "Reveal in Folder",
        action: async () => {
          const parent = parentOf(target.path);
          if (parent) {
            await navigate(parent);
            state.selection.clear();
            state.selection.add(target.path);
            renderSelection();
          }
        },
      });
    }
    items.push({ label: "Open", action: () => void openEntry(target) });
    items.push({ label: "Quick Look", action: openQuickLook });
    if (target.is_dir) {
      items.push({ label: "Open in new tab", action: () => void openInNewTab(target.path) });
      items.push({ label: "Analyze Disk Space", action: () => void openDiskAnalyzer(target.path) });
    }
    items.push({
      label: "Open in Terminal",
      action: () =>
        void doOpenTerminal(target.is_dir ? target.path : (parentOf(target.path) ?? state.path)),
    });
    if (!target.is_dir) items.push({ label: "Open With…", action: () => void askOpenWith(target) });
    if (target.is_dir && !isBuiltinPlace(target.path)) {
      items.push({
        label: isPinned(target.path) ? "Unpin from Quick access" : "Pin to Quick access",
        action: () => togglePin(target.path),
      });
    }
    items.push({ label: "Copy", action: () => void doCopyCut("copy") });
    items.push({ label: "Cut", action: () => void doCopyCut("cut") });
    items.push({ label: "Copy Path", action: () => void doCopyPath() });
    if (state.dual) {
      items.push({ label: "Copy to other pane (F5)", action: () => void transferToOtherPane(true) });
      items.push({ label: "Move to other pane (F6)", action: () => void transferToOtherPane(false) });
      items.push({ label: "Compare with other pane", action: () => void runCompare() });
    }
    items.push({ label: "Compress to ZIP", action: () => void doCompress() });
    if (state.selection.size === 1 && (target.extension ?? "").toLowerCase() === "zip") {
      items.push({ label: "Extract here", action: () => void doExtract() });
    }
    if (state.selection.size > 1) {
      items.push({ label: `Batch Rename (${state.selection.size} files, F2)…`, action: askBatchRename });
    } else {
      items.push({ label: "Rename (F2)", action: askRename });
      items.push({ label: "Batch Rename…", action: askBatchRename });
    }
    items.push({ label: "Delete", action: askDelete });
    items.push({ label: "Properties", disabled: state.selection.size !== 1, action: () => void showProperties() });
  } else {
    items.push({ label: "Open in Terminal", action: () => void doOpenTerminal(state.path) });
    items.push({ label: "Analyze Disk Space", action: () => void openDiskAnalyzer(state.path) });
    items.push({ label: "Copy Path", action: () => void doCopyPath() });
    if (!isBuiltinPlace(state.path)) {
      items.push({
        label: isPinned(state.path) ? "Unpin this folder from Quick access" : "Pin this folder to Quick access",
        action: () => togglePin(state.path),
      });
    }
    items.push({ label: "New folder", action: () => askNew("folder") });
    items.push({ label: "New file", action: () => askNew("file") });
    items.push({ label: "Paste", disabled: state.clipboard === null, action: () => void doPaste() });
  }
  showMenuAt(x, y, items, tagsBar);
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
    if (state.contentMode) {
      const matches = await invoke<ContentMatch[]>("search_content", { root: state.path, query: q });
      state.entries = matches.map((m) => m.entry);
      state.contentMatches = new Map(matches.map((m) => [m.entry.path, { line: m.line, snippet: m.snippet }]));
      render();
      showState(state.filtered.length === 0 ? "empty" : "full");
      renderStatus();
      return;
    }
    state.contentMatches = null;
    state.entries = await invoke<Entry[]>("search_files", { root: state.path, query: q });
    render();
    showState(state.filtered.length === 0 ? "empty" : "full");
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
  document.querySelectorAll("#tag-list .nav-item").forEach((b) => {
    b.classList.toggle("is-active", (b as HTMLElement).dataset.tag === state.tag);
  });
  document.querySelectorAll("#quick-list .nav-item, #drive-list .nav-item").forEach((b) => {
    const el = b as HTMLElement;
    el.classList.toggle("is-active", !state.isTrash && !state.tag && !!el.dataset.path && el.dataset.path === state.path);
  });
}

async function refreshDrives(): Promise<void> {
  try {
    state.drives = await invoke<Drive[]>("get_drives");
    renderSidebar();
  } catch (err) {
    console.error("Failed to refresh drives:", err);
  }
}

async function mountDrive(d: Drive): Promise<void> {
  if (!d.device) {
    toast("No device path for this drive", true);
    return;
  }
  try {
    toast(`Mounting ${d.name}...`);
    const mountPath = await invoke<string>("mount_drive", { device: d.device });
    toast(`Mounted ${d.name}`);
    await refreshDrives();
    if (mountPath) {
      await navigate(mountPath);
    }
  } catch (err) {
    toast(`Mount failed: ${err}`, true);
  }
}

async function unmountDrive(d: Drive): Promise<void> {
  const target = d.mount || d.device;
  if (!target) {
    toast("Cannot unmount: unknown target", true);
    return;
  }
  try {
    toast(`Unmounting ${d.name}...`);
    await invoke("unmount_drive", { target });
    toast(`Unmounted ${d.name}`);
    if (d.mount && (state.path === d.mount || state.path.startsWith(d.mount + "/"))) {
      await navigate(state.homeDir);
    }
    await refreshDrives();
  } catch (err) {
    toast(`Unmount failed: ${err}`, true);
  }
}

function selectAll(): void {
  state.selection.clear();
  for (const e of state.filtered) {
    state.selection.add(e.path);
  }
  renderSelection();
}

function invertSelection(): void {
  const current = new Set(state.selection);
  state.selection.clear();
  for (const e of state.filtered) {
    if (!current.has(e.path)) state.selection.add(e.path);
  }
  renderSelection();
}

function toggleHiddenFiles(): void {
  state.showHidden = !state.showHidden;
  ($("show-hidden") as HTMLInputElement).checked = state.showHidden;
  localStorage.setItem("filemon-hidden", state.showHidden ? "1" : "0");
  render();
  showState(state.filtered.length === 0 ? "empty" : "full");
}

/* ==========================================================================
   Command Palette & Quick Jump (Ctrl+K / Ctrl+P)
   ========================================================================== */

type PaletteAction = {
  id: string;
  title: string;
  category: "Places" | "Navigation" | "Layout" | "Actions" | "View" | "Settings" | "Tags";
  subtitle?: string;
  shortcut?: string;
  icon: string;
  keywords?: string;
  run: () => void | Promise<void>;
};

let paletteFiltered: PaletteAction[] = [];
let paletteSelectedIndex = 0;

function scoreItem(item: PaletteAction, query: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const title = item.title.toLowerCase();
  const sub = (item.subtitle || "").toLowerCase();
  const keywords = (item.keywords || "").toLowerCase();

  if (title === q) return 100;
  if (title.startsWith(q)) return 80;
  const titleIdx = title.indexOf(q);
  if (titleIdx !== -1) return 60 - titleIdx;

  const words = title.split(/[\s\-_]+/);
  const acronym = words.map((w) => w[0]).join("");
  if (acronym.startsWith(q)) return 50;

  if (sub.includes(q)) return 30;
  if (keywords.includes(q)) return 20;

  const qWords = q.split(/\s+/).filter(Boolean);
  if (qWords.length > 1 && qWords.every((w) => title.includes(w) || sub.includes(w) || keywords.includes(w))) {
    return 15;
  }
  return 0;
}

function highlightMatches(text: string, query: string): string {
  if (!query) return escapeHtml(text);
  const q = query.toLowerCase();
  const lower = text.toLowerCase();
  const idx = lower.indexOf(q);
  if (idx === -1) return escapeHtml(text);
  const before = escapeHtml(text.slice(0, idx));
  const match = escapeHtml(text.slice(idx, idx + q.length));
  const after = escapeHtml(text.slice(idx + q.length));
  return `${before}<mark class="palette-mark">${match}</mark>${after}`;
}

function getAllPaletteActions(): PaletteAction[] {
  const actions: PaletteAction[] = [];

  for (const [label, path] of builtinPlaces()) {
    actions.push({
      id: "place-" + label,
      title: label,
      category: "Places",
      subtitle: path,
      icon: quickIconFor(label),
      keywords: label.toLowerCase() + " folder place jump",
      run: () => void navigate(path),
    });
  }

  actions.push({
    id: "place-trash",
    title: "Trash",
    category: "Places",
    subtitle: "freedesktop Trash",
    icon: ICONS.trash,
    keywords: "recycle bin deleted files",
    run: () => void openTrash(),
  });

  for (const p of state.pinned) {
    actions.push({
      id: "pin-" + p,
      title: baseName(p),
      category: "Places",
      subtitle: `Pinned · ${p}`,
      icon: ICONS.pin,
      keywords: "pinned favorite bookmark " + baseName(p).toLowerCase(),
      run: () => void navigate(p),
    });
  }

  for (const d of state.drives) {
    const isMounted = d.mounted !== false && !!d.mount;
    actions.push({
      id: "drive-" + d.name,
      title: d.name + (!isMounted ? " (Mount)" : ""),
      category: "Places",
      subtitle: isMounted ? `${d.mount} · ${fmtSize(d.free)} free of ${fmtSize(d.total)}` : `${d.device || ""} · Unmounted (click to mount)`,
      icon: ICONS.drive,
      keywords: "drive disk partition storage hdd ssd " + d.name.toLowerCase(),
      run: () => {
        if (isMounted) void navigate(d.mount);
        else void mountDrive(d);
      },
    });
  }

  if (!state.isTrash) {
    for (const e of state.entries) {
      if (e.is_dir) {
        actions.push({
          id: "folder-" + e.path,
          title: e.name,
          category: "Places",
          subtitle: `In current folder · ${e.path}`,
          icon: ICONS.folder,
          keywords: "folder subfolder " + e.name.toLowerCase(),
          run: () => void navigate(e.path),
        });
      }
    }
  }

  const tagCounts = getTagCounts();
  for (const tagKey of ALL_TAGS) {
    const def = TAG_DEFS[tagKey];
    const count = tagCounts[tagKey] || 0;
    actions.push({
      id: "tag-view-" + tagKey,
      title: `View Tag: ${def.label}` + (state.tag === tagKey ? " (Active)" : ""),
      category: "Tags",
      subtitle: `Show all files tagged ${def.label} (${count} item${count === 1 ? "" : "s"})`,
      icon: ICONS.folder,
      keywords: `tag label ${tagKey} ${def.label.toLowerCase()} filter color bookmark`,
      run: () => void openTagView(tagKey),
    });
  }

  if (state.selection.size > 0 && !state.isTrash) {
    const selectedPaths = [...state.selection];
    for (const tagKey of ALL_TAGS) {
      const def = TAG_DEFS[tagKey];
      actions.push({
        id: "tag-toggle-" + tagKey,
        title: `Tag Selected: ${def.label}`,
        category: "Actions",
        subtitle: `Toggle ${def.label} tag for ${selectedPaths.length} selected item${selectedPaths.length === 1 ? "" : "s"}`,
        icon: ICONS.sun,
        keywords: `tag color ${tagKey} ${def.label.toLowerCase()} mark label`,
        run: () => toggleTagForPaths(selectedPaths, tagKey),
      });
    }
    actions.push({
      id: "tag-clear-selected",
      title: "Clear Tags from Selected",
      category: "Actions",
      subtitle: `Remove all color tags from ${selectedPaths.length} selected item${selectedPaths.length === 1 ? "" : "s"}`,
      icon: ICONS.trash,
      keywords: "clear remove tags unmark untag",
      run: () => clearTagsForPaths(selectedPaths),
    });
  }

  actions.push({
    id: "act-dual",
    title: state.dual ? "Turn Off Dual Pane" : "Toggle Dual Pane (Split View)",
    category: "Layout",
    subtitle: "Side-by-side two-pane file manager",
    shortcut: "Ctrl+Shift+D",
    icon: ICONS.panel,
    keywords: "split pane dual two columns view side by side",
    run: () => void setDual(!state.dual),
  });

  if (state.dual) {
    actions.push({
      id: "act-pane-1",
      title: "Focus Left Pane",
      category: "Layout",
      subtitle: "Switch active pane to the left",
      shortcut: "Alt+1",
      icon: ICONS.panel,
      keywords: "left pane 1 focus switch",
      run: () => setActivePane(0),
    });
    actions.push({
      id: "act-pane-2",
      title: "Focus Right Pane",
      category: "Layout",
      subtitle: "Switch active pane to the right",
      shortcut: "Alt+2",
      icon: ICONS.panel,
      keywords: "right pane 2 focus switch",
      run: () => setActivePane(1),
    });
  }

  actions.push({
    id: "act-preview",
    title: "Toggle Preview Pane",
    category: "Layout",
    subtitle: "Show or hide the side inspect pane",
    icon: ICONS.panel,
    keywords: "preview inspect side details",
    run: () => ($("preview-toggle") as HTMLButtonElement).click(),
  });

  actions.push({
    id: "act-new-tab",
    title: "New Tab",
    category: "Navigation",
    subtitle: "Open current folder in a new tab",
    shortcut: "Ctrl+T",
    icon: ICONS.folderPlus,
    keywords: "tab new open duplicate",
    run: () => newTab(),
  });

  actions.push({
    id: "act-close-tab",
    title: "Close Tab",
    category: "Navigation",
    subtitle: "Close the currently active tab",
    shortcut: "Ctrl+W",
    icon: ICONS.trash,
    keywords: "close tab remove exit",
    run: () => void closeTab(state.activeTab),
  });

  actions.push({
    id: "act-reopen-tab",
    title: "Reopen Closed Tab",
    category: "Navigation",
    subtitle: "Restore the last closed tab with its folder",
    shortcut: "Ctrl+Shift+T",
    icon: ICONS.undo,
    keywords: "reopen closed tab restore undo",
    run: () => void reopenClosedTab(),
  });

  actions.push({
    id: "act-next-tab",
    title: "Next Tab",
    category: "Navigation",
    subtitle: "Cycle to the next tab",
    shortcut: "Ctrl+Tab",
    icon: ICONS.list,
    keywords: "switch tab next cycle",
    run: () => void switchTab((state.activeTab + 1) % state.tabs.length),
  });

  actions.push({
    id: "act-prev-tab",
    title: "Previous Tab",
    category: "Navigation",
    subtitle: "Cycle to the previous tab",
    shortcut: "Ctrl+Shift+Tab",
    icon: ICONS.list,
    keywords: "switch tab prev previous cycle",
    run: () => void switchTab((state.activeTab + state.tabs.length - 1) % state.tabs.length),
  });

  actions.push({
    id: "act-new-folder",
    title: "New Folder",
    category: "Actions",
    subtitle: "Create a new folder in current directory",
    shortcut: "Ctrl+Shift+N",
    icon: ICONS.folderPlus,
    keywords: "create make new directory folder mkdir",
    run: () => askNew("folder"),
  });

  actions.push({
    id: "act-new-file",
    title: "New File",
    category: "Actions",
    subtitle: "Create a new empty text document",
    icon: ICONS.filePlus,
    keywords: "create make new file touch empty document",
    run: () => askNew("file"),
  });

  actions.push({
    id: "act-select-all",
    title: "Select All",
    category: "Actions",
    subtitle: "Select all files and folders in current view",
    shortcut: "Ctrl+A",
    icon: ICONS.list,
    keywords: "select all every everything",
    run: () => selectAll(),
  });

  actions.push({
    id: "act-invert-selection",
    title: "Invert Selection",
    category: "Actions",
    subtitle: "Invert the current file selection",
    icon: ICONS.list,
    keywords: "invert toggle selection opposite",
    run: () => invertSelection(),
  });

  actions.push({
    id: "act-copy-path",
    title: "Copy Path",
    category: "Actions",
    subtitle: state.selection.size > 0 ? "Copy paths of selected items to clipboard" : "Copy current directory path to clipboard",
    icon: ICONS.copy,
    keywords: "copy path full path clipboard",
    run: () => void doCopyPath(),
  });

  if (state.selection.size > 0) {
    actions.push({
      id: "act-batch-rename",
      title: `Batch Rename (${state.selection.size} item${state.selection.size === 1 ? "" : "s"})`,
      category: "Actions",
      subtitle: "Multi-file rename: regex, numbering, prefix/suffix, case change, clean spaces",
      shortcut: "F2",
      icon: ICONS.pencil,
      keywords: "batch rename multiple replace numbering pattern case",
      run: () => askBatchRename(),
    });
    actions.push({
      id: "act-properties",
      title: "Properties",
      category: "Actions",
      subtitle: "View file details, size, permissions, SHA-256 hash",
      shortcut: "Alt+Enter",
      icon: ICONS.info,
      keywords: "properties chmod info permissions hash sha256 size",
      run: () => void showProperties(),
    });
  }

  if (state.selection.size === 1) {
    actions.push({
      id: "act-quicklook",
      title: "Quick Look Preview",
      category: "Actions",
      subtitle: "Large instant file preview dialog",
      shortcut: "Space",
      icon: ICONS.image,
      keywords: "quick look space preview large",
      run: () => openQuickLook(),
    });
  }

  actions.push({
    id: "act-terminal",
    title: "Open Terminal Here",
    category: "Actions",
    subtitle: `Launch default terminal in ${state.path}`,
    icon: ICONS.command,
    keywords: "terminal console bash zsh shell open here cli",
    run: () => void doOpenTerminal(state.path),
  });

  actions.push({
    id: "act-disk-analyzer",
    title: `Analyze Disk Space (${baseName(state.path) || state.path})`,
    category: "Actions",
    subtitle: "Visual Treemap & folder usage breakdown",
    shortcut: "Ctrl+Shift+U",
    icon: ICONS.treemap,
    keywords: "disk space usage analyzer treemap breakdown windirstat baobab visual",
    run: () => void openDiskAnalyzer(state.path),
  });

  if (state.selection.size === 1) {
    const sel = selectedEntries()[0];
    if (sel && sel.is_dir) {
      actions.push({
        id: "act-disk-analyzer-selected",
        title: `Analyze Disk Space: ${sel.name}`,
        category: "Actions",
        subtitle: `Scan and visualize usage for ${sel.path}`,
        icon: ICONS.treemap,
        keywords: "disk space usage analyzer folder " + sel.name.toLowerCase(),
        run: () => void openDiskAnalyzer(sel.path),
      });
    }
  }

  if (state.gitInfo) {
    actions.push({
      id: "git-copy-branch",
      title: `Copy Git Branch (${state.gitInfo.branch})`,
      category: "Actions",
      subtitle: `Repo: ${baseName(state.gitInfo.root)} · ${state.gitInfo.is_clean ? "Clean" : "Uncommitted changes"}`,
      icon: ICONS.command,
      keywords: "git branch copy name repo repository",
      run: () => {
        void copyText(state.gitInfo!.branch);
        toast(`Branch "${state.gitInfo!.branch}" copied`);
      },
    });
    actions.push({
      id: "git-refresh-status",
      title: "Refresh Git Status",
      category: "Actions",
      subtitle: "Re-scan repository working tree and branch",
      icon: ICONS.undo,
      keywords: "git status refresh reload sync",
      run: () => void loadGitInfo(),
    });
  }

  actions.push({
    id: "act-dupes",
    title: "Find Duplicate Files",
    category: "Actions",
    subtitle: "Scan current folder tree for duplicate file contents",
    icon: ICONS.file,
    keywords: "find duplicates hash identical files scanner",
    run: () => void runDupes(),
  });

  if (state.dual) {
    actions.push({
      id: "act-compare",
      title: "Compare with Other Pane",
      category: "Actions",
      subtitle: "Diff folder contents between left and right panes",
      icon: ICONS.list,
      keywords: "compare diff sync panes missing files",
      run: () => void runCompare(),
    });
  }

  if (state.isTrash) {
    actions.push({
      id: "act-empty-trash",
      title: "Empty Trash",
      category: "Actions",
      subtitle: "Permanently delete all items in Trash",
      icon: ICONS.trash,
      keywords: "empty clear delete wipe trash",
      run: () => askEmptyTrash(),
    });
  }

  actions.push({
    id: "act-hidden",
    title: state.showHidden ? "Hide Hidden Files" : "Show Hidden Files (dotfiles)",
    category: "View",
    subtitle: "Toggle visibility of dotfiles and hidden folders",
    shortcut: "Ctrl+H",
    icon: ICONS.file,
    keywords: "hidden files dotfiles dot toggle show",
    run: () => toggleHiddenFiles(),
  });

  actions.push({
    id: "act-view-details",
    title: "Details View (Table)",
    category: "View",
    subtitle: "List files in sortable columns (Name, Size, Date, Type)",
    icon: ICONS.list,
    keywords: "details table list view columns rows",
    run: () => {
      state.view = "details";
      saveTabs();
      render();
      showState(state.filtered.length === 0 ? "empty" : "full");
    },
  });

  actions.push({
    id: "act-view-icons",
    title: "Icons View (Grid)",
    category: "View",
    subtitle: "Display files in thumbnail grid with tile zoom",
    icon: ICONS.grid,
    keywords: "icons grid gallery thumbnails view",
    run: () => {
      state.view = "icons";
      saveTabs();
      render();
      showState(state.filtered.length === 0 ? "empty" : "full");
    },
  });

  actions.push({
    id: "act-theme",
    title: "Toggle Theme (Light / Dark)",
    category: "Settings",
    subtitle: "Switch between dark obsidian and clean light mode",
    icon: ICONS.sun,
    keywords: "theme mode dark light color appearance",
    run: () => ($("theme-toggle") as HTMLButtonElement).click(),
  });

  actions.push({
    id: "act-appearance-panel",
    title: "Appearance Settings",
    category: "Settings",
    subtitle: "Density, interface scale, icon grid size, grouping",
    icon: ICONS.panel,
    keywords: "appearance density scale zoom group settings",
    run: () => {
      toggleFilterPanel(false);
      toggleAppearancePanel();
    },
  });

  const currentAccent = getAccentColor();
  for (const [key, preset] of Object.entries(ACCENT_PRESETS) as [AccentName, (typeof ACCENT_PRESETS)[AccentName]][]) {
    actions.push({
      id: "accent-" + key,
      title: `Theme Accent: ${preset.label}` + (currentAccent === key ? " (Active)" : ""),
      category: "Settings",
      subtitle: `Switch accent color to ${preset.label}`,
      icon: ICONS.sun,
      keywords: `accent color theme ${key} ${preset.label.toLowerCase()}`,
      run: () => setAccentColor(key),
    });
  }

  actions.push({
    id: "act-filter-panel",
    title: "Filter Panel",
    category: "Settings",
    subtitle: "Filter by file type, extension, size range, date modified",
    icon: ICONS.list,
    keywords: "filter find types size date funnel",
    run: () => {
      toggleAppearancePanel(false);
      toggleFilterPanel();
    },
  });

  actions.push({
    id: "act-search",
    title: "Search Current Folder",
    category: "Navigation",
    subtitle: "Focus search bar to find files by name",
    shortcut: "Ctrl+F",
    icon: ICONS.doc,
    keywords: "search find query name filter",
    run: () => {
      const s = $("search") as HTMLInputElement;
      s.focus();
      s.select();
    },
  });

  actions.push({
    id: "act-address",
    title: "Go to Path (Address Bar)",
    category: "Navigation",
    subtitle: "Type or paste a folder path directly",
    shortcut: "Ctrl+L",
    icon: ICONS.folder,
    keywords: "address bar path go location jump url",
    run: () => showAddressBar(),
  });

  actions.push({
    id: "act-refresh-drives",
    title: "Refresh Drives & Partitions",
    category: "Settings",
    subtitle: "Re-scan mounted disks and unmounted partitions",
    icon: ICONS.drive,
    keywords: "refresh drives disks mount partition scan",
    run: () => void refreshDrives(),
  });

  actions.push({
    id: "act-refresh-dir",
    title: "Refresh Current Folder",
    category: "Navigation",
    subtitle: "Reload current folder contents from disk",
    shortcut: "F5",
    icon: ICONS.undo,
    keywords: "refresh reload update dir folder f5",
    run: () => void loadDir(),
  });

  return actions;
}

function updatePaletteSelection(): void {
  const listEl = $("palette-list");
  if (!listEl) return;
  const items = listEl.querySelectorAll<HTMLElement>(".palette-item");
  items.forEach((el, i) => {
    const isSel = i === paletteSelectedIndex;
    el.classList.toggle("is-selected", isSel);
    el.setAttribute("aria-selected", isSel ? "true" : "false");
  });
  scrollPaletteSelectionIntoView();
}

function scrollPaletteSelectionIntoView(): void {
  const listEl = $("palette-list");
  if (!listEl) return;
  const selEl = listEl.querySelector<HTMLElement>(".palette-item.is-selected");
  if (selEl) {
    selEl.scrollIntoView({ block: "nearest" });
  }
}

function renderPaletteList(query: string): void {
  const listEl = $("palette-list");
  if (!listEl) return;
  listEl.innerHTML = "";

  if (paletteFiltered.length === 0) {
    listEl.innerHTML = `
      <div class="palette-empty">
        <span>No commands or places match "${escapeHtml(query)}"</span>
        <span style="font-size: 11.5px; opacity: 0.65;">Try a different keyword or prefix with &gt; for commands</span>
      </div>
    `;
    return;
  }

  const shown = paletteFiltered.slice(0, 40);
  let currentGroup = "";

  shown.forEach((item, idx) => {
    if (!query && item.category !== currentGroup) {
      currentGroup = item.category;
      const groupEl = document.createElement("div");
      groupEl.className = "palette-group-title";
      groupEl.textContent = currentGroup;
      listEl.appendChild(groupEl);
    }

    const row = document.createElement("div");
    row.className = "palette-item" + (idx === paletteSelectedIndex ? " is-selected" : "");
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", idx === paletteSelectedIndex ? "true" : "false");
    row.dataset.idx = String(idx);

    row.innerHTML = `
      <span class="palette-item-icon">${iconSvg(item.icon)}</span>
      <div class="palette-item-main">
        <span class="palette-item-title">${highlightMatches(item.title, query)}</span>
        ${item.subtitle ? `<span class="palette-item-sub">${escapeHtml(item.subtitle)}</span>` : ""}
      </div>
      <div class="palette-item-badge">
        ${item.shortcut ? `<kbd class="palette-kbd">${escapeHtml(item.shortcut)}</kbd>` : `<span class="palette-category-badge">${escapeHtml(item.category)}</span>`}
      </div>
    `;

    row.addEventListener("mouseenter", () => {
      paletteSelectedIndex = idx;
      updatePaletteSelection();
    });

    row.addEventListener("click", () => {
      closePalette();
      void item.run();
    });

    listEl.appendChild(row);
  });

  scrollPaletteSelectionIntoView();
}

function updatePaletteResults(rawQuery: string): void {
  const q = rawQuery.trim();
  const allActions = getAllPaletteActions();
  const isCommandOnly = q.startsWith(">");
  const cleanQuery = (isCommandOnly ? q.slice(1) : q).trim();

  let results: { item: PaletteAction; score: number }[] = [];

  for (const item of allActions) {
    if (isCommandOnly && item.category === "Places") continue;
    const score = scoreItem(item, cleanQuery);
    if (score > 0) {
      results.push({ item, score });
    }
  }

  results.sort((a, b) => b.score - a.score);
  paletteFiltered = results.map((r) => r.item);

  if ((cleanQuery.startsWith("/") || cleanQuery.startsWith("~")) && cleanQuery.length > 1) {
    const resolved = cleanQuery.startsWith("~") ? state.homeDir + cleanQuery.slice(1) : cleanQuery;
    paletteFiltered.unshift({
      id: "direct-path-jump",
      title: `Go to "${cleanQuery}"`,
      category: "Navigation",
      subtitle: resolved,
      icon: ICONS.folder,
      run: () => void navigate(resolved),
    });
  }

  paletteSelectedIndex = 0;
  renderPaletteList(cleanQuery);
}

function openPalette(): void {
  const dlg = $("dlg-palette") as HTMLDialogElement;
  if (!dlg) return;
  const input = $("palette-input") as HTMLInputElement;
  input.value = "";
  dlg.showModal();
  updatePaletteResults("");
  input.focus();
}

function closePalette(): void {
  const dlg = $("dlg-palette") as HTMLDialogElement;
  if (dlg && dlg.open) dlg.close();
}

function togglePalette(): void {
  const dlg = $("dlg-palette") as HTMLDialogElement;
  if (dlg && dlg.open) closePalette();
  else openPalette();
}

function renderSidebar(): void {
  const quick = $("quick-list");
  quick.innerHTML = "";
  for (const [label, path] of builtinPlaces()) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "nav-item" + (!state.isTrash && state.path === path ? " is-active" : "");
    b.dataset.path = path;
    b.innerHTML = `${iconSvg(quickIconFor(label))}${label}`;
    b.addEventListener("click", () => void navigate(path));
    attachDropTarget(b, () => path);
    quick.appendChild(b);
  }
  for (const path of state.pinned) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "nav-item" + (!state.isTrash && state.path === path ? " is-active" : "");
    b.dataset.path = path;
    b.title = path;
    b.innerHTML = `${iconSvg(ICONS.folder)}<span>${escapeHtml(baseName(path))}</span><span class="nav-meta pin-badge">${iconSvg(ICONS.pin)}</span>`;
    b.addEventListener("click", () => void navigate(path));
    b.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      showPinMenu(ev.clientX, ev.clientY, path);
    });
    attachDropTarget(b, () => path);
    quick.appendChild(b);
  }
  const tagList = $("tag-list");
  if (tagList) {
    tagList.innerHTML = "";
    const counts = getTagCounts();
    const isLight = document.documentElement.dataset.theme === "light";
    for (const tagKey of ALL_TAGS) {
      const def = TAG_DEFS[tagKey];
      const count = counts[tagKey] || 0;
      const b = document.createElement("button");
      b.type = "button";
      b.className = "nav-item nav-tag" + (state.tag === tagKey ? " is-active" : "");
      b.dataset.tag = tagKey;
      const col = isLight ? def.lightColor : def.color;
      b.innerHTML = `<span class="nav-tag-dot" style="background:${col}"></span><span>${escapeHtml(def.label)}</span>${count > 0 ? `<span class="nav-meta">${count}</span>` : ""}`;
      b.addEventListener("click", () => void openTagView(tagKey));

      b.addEventListener("dragover", (ev) => {
        if (!isInternalDrag(ev)) return;
        ev.preventDefault();
        ev.dataTransfer!.dropEffect = "copy";
        markDropTarget(b);
      });
      b.addEventListener("drop", (ev) => {
        ev.preventDefault();
        markDropTarget(null);
        const paths = dropPaths(ev);
        if (paths && paths.length > 0) {
          toggleTagForPaths(paths, tagKey);
          toast(`Tagged ${paths.length} item${paths.length > 1 ? "s" : ""} as ${def.label}`);
        }
      });
      tagList.appendChild(b);
    }
  }
  const dl = $("drive-list");
  dl.innerHTML = "";
  for (const d of state.drives) {
    const isMounted = d.mounted !== false && !!d.mount;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "nav-item nav-drive" + (isMounted && !state.isTrash && state.path === d.mount ? " is-active" : "") + (!isMounted ? " is-unmounted" : "");
    if (isMounted) {
      b.dataset.path = d.mount;
      const used = d.total > 0 ? Math.round(((d.total - d.free) / d.total) * 100) : 0;
      b.innerHTML = `<span class="nav-drive-row">${iconSvg(ICONS.drive)}<span>${escapeHtml(d.name)}</span><span class="nav-meta">${fmtSize(d.free)} free</span></span><span class="drive-bar" title="${used}% used"><span style="width: ${used}%" class="${used >= 90 ? "is-full" : ""}"></span></span>`;
      b.title = `${d.mount} · ${d.fs || "filesystem"} · ${fmtSize(d.free)} free of ${fmtSize(d.total)} (${used}% used)`;
      b.addEventListener("click", () => void navigate(d.mount));
      attachDropTarget(b, () => d.mount);
    } else {
      if (d.device) b.dataset.device = d.device;
      b.innerHTML = `<span class="nav-drive-row">${iconSvg(ICONS.drive)}<span>${escapeHtml(d.name)}</span><span class="nav-mount-badge">Mount</span></span><span class="drive-bar drive-bar-unmounted"><span></span></span>`;
      b.title = `${d.device || d.name} · ${d.fs || "partition"} · ${d.total > 0 ? fmtSize(d.total) : "Unmounted"} (click to mount)`;
      b.addEventListener("click", () => void mountDrive(d));
    }
    b.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      showDriveMenu(ev.clientX, ev.clientY, d);
    });
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
  // Appearance preferences apply before the first render so the window
  // never flashes the default density/scale/accent.
  applyAccentColor();
  applyDensity();
  applyUiScale();
  loadPins();
  await prunePins();
  state.drives = await invoke<Drive[]>("get_drives");
  renderSidebar();
  restoreTabs(home);
  if (state.dual) {
    // Rebuild the second pane from the stored preference.
    state.panes.push(makePane());
    restoreTabs(home, 1);
    buildSecondPane();
    ($("pane-1") as HTMLElement).hidden = false;
    document.querySelectorAll(".pane-head").forEach((el) => ((el as HTMLElement).hidden = false));
    const dualBtn = $("act-dual") as HTMLButtonElement;
    dualBtn.classList.add("is-active");
    dualBtn.setAttribute("aria-pressed", "true");
  }
  // Session restore: the active pane comes back too, not just its tabs.
  const savedPane = Number(localStorage.getItem("filemon-active-pane") ?? "0");
  if (state.dual && savedPane === 1) {
    state.activePane = 1;
    document.querySelectorAll(".pane").forEach((el, idx) => el.classList.toggle("is-active", idx === 1));
  }

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
  $("act-rename").addEventListener("click", () => {
    if (state.selection.size > 1) askBatchRename();
    else askRename();
  });
  $("act-delete").addEventListener("click", askDelete);
  $("act-props").addEventListener("click", () => void showProperties());
  $("act-restore").addEventListener("click", () => void doRestore());
  $("act-delete-permanent").addEventListener("click", askDelete);
  $("act-empty-trash").addEventListener("click", askEmptyTrash);
  $("act-dupes").addEventListener("click", () => void runDupes());
  $("act-analyzer").addEventListener("click", () => void openDiskAnalyzer());

  $("analyzer-btn-close")?.addEventListener("click", closeDiskAnalyzer);
  $("analyzer-done-btn")?.addEventListener("click", closeDiskAnalyzer);
  $("analyzer-btn-refresh")?.addEventListener("click", () => {
    if (analyzerCurrentPath) void scanAnalyzerPath(analyzerCurrentPath);
  });
  $("analyzer-btn-up")?.addEventListener("click", () => {
    if (analyzerCurrentPath) {
      const p = parentOf(analyzerCurrentPath);
      if (p) void scanAnalyzerPath(p);
    }
  });
  $("analyzer-btn-cancel")?.addEventListener("click", () => {
    void invoke("cancel_analyze_space");
    analyzerIsScanning = false;
    ($("analyzer-loading") as HTMLElement).hidden = true;
  });
  $("analyzer-view-both")?.addEventListener("click", () => setAnalyzerViewMode("both"));
  $("analyzer-view-treemap")?.addEventListener("click", () => setAnalyzerViewMode("treemap"));
  $("analyzer-view-list")?.addEventListener("click", () => setAnalyzerViewMode("list"));
  $("analyzer-reveal-btn")?.addEventListener("click", () => {
    if (analyzerCurrentPath) void revealInFileMon(analyzerCurrentPath);
  });
  $("analyzer-terminal-btn")?.addEventListener("click", () => {
    if (analyzerCurrentPath) void doOpenTerminal(analyzerCurrentPath);
  });
  $("act-dual").addEventListener("click", () => void setDual(!state.dual));
  $("act-appearance").addEventListener("click", (ev) => {
    ev.stopPropagation();
    toggleFilterPanel(false);
    toggleAppearancePanel();
  });
  $("act-filter").addEventListener("click", (ev) => {
    ev.stopPropagation();
    toggleFilterPanel();
  });
  $("act-palette").addEventListener("click", () => togglePalette());
  const palInput = $("palette-input") as HTMLInputElement;
  palInput.addEventListener("input", () => {
    updatePaletteResults(palInput.value);
  });
  palInput.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      if (paletteFiltered.length > 0) {
        paletteSelectedIndex = (paletteSelectedIndex + 1) % paletteFiltered.length;
        updatePaletteSelection();
      }
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      if (paletteFiltered.length > 0) {
        paletteSelectedIndex = (paletteSelectedIndex - 1 + paletteFiltered.length) % paletteFiltered.length;
        updatePaletteSelection();
      }
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      const sel = paletteFiltered[paletteSelectedIndex];
      if (sel) {
        closePalette();
        void sel.run();
      }
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      closePalette();
    }
  });
  for (const id of ["filter-kind", "filter-ext", "filter-min", "filter-max", "filter-after", "filter-before"]) {
    $(id).addEventListener("input", () => applyFilterFromPanel());
    $(id).addEventListener("change", () => applyFilterFromPanel());
  }
  $("filter-clear").addEventListener("click", () => clearFilters());
  // Clicking anywhere outside the filter panel closes it (the button stops
  // its own click from reaching here).
  document.addEventListener("click", (ev) => {
    if (!($("filter-panel") as HTMLElement).hidden && !(ev.target as HTMLElement).closest("#filter-panel")) {
      toggleFilterPanel(false);
    }
  });
  const addressBar = $("address-bar") as HTMLInputElement;
  addressBar.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      void goToAddress();
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      hideAddressBar();
    }
  });
  addressBar.addEventListener("blur", () => hideAddressBar());
  ($("appearance-group") as HTMLSelectElement).addEventListener("change", (ev) => {
    setGroupBy((ev.target as HTMLSelectElement).value as GroupMode);
  });
  document.querySelectorAll("#appearance-panel [data-density]").forEach((b) => {
    b.addEventListener("click", () => setDensity((b as HTMLElement).dataset.density as Density));
  });
  document.querySelectorAll("#appearance-panel [data-scale]").forEach((b) => {
    b.addEventListener("click", () => setUiScale(Number((b as HTMLElement).dataset.scale)));
  });
  document.querySelectorAll("#appearance-panel [data-zoom]").forEach((b) => {
    b.addEventListener("click", () => setGridZoom(Number((b as HTMLElement).dataset.zoom) as 0 | 1 | 2));
  });
  document.querySelectorAll("#appearance-panel [data-accent]").forEach((b) => {
    b.addEventListener("click", () => setAccentColor((b as HTMLElement).dataset.accent as AccentName));
  });
  // Clicking anywhere outside the panel closes it (the button stops its
  // own click from reaching here).
  document.addEventListener("click", (ev) => {
    if (!($("appearance-panel") as HTMLElement).hidden && !(ev.target as HTMLElement).closest("#appearance-panel")) {
      toggleAppearancePanel(false);
    }
  });
  // Ctrl+wheel on either grid zooms the tiles (delegated: pane 1's grid
  // is built later, and the wheel target is a tile, not the wrap).
  ($("panes") as HTMLElement).addEventListener(
    "wheel",
    (ev) => {
      if (!(ev.ctrlKey || ev.metaKey)) return;
      if (!(ev.target as HTMLElement).closest(".grid-wrap")) return;
      if (state.view !== "icons") return;
      ev.preventDefault();
      setGridZoom(Math.min(2, Math.max(0, state.zoom + (ev.deltaY < 0 ? 1 : -1))) as 0 | 1 | 2);
    },
    { passive: false },
  );
  $("quicklook-close").addEventListener("click", closeQuickLook);
  $("quicklook-backdrop").addEventListener("click", closeQuickLook);
  $("quicklook-prev").addEventListener("click", () => moveQuickLook(-1));
  $("quicklook-next").addEventListener("click", () => moveQuickLook(1));
  $("empty-clear-search").addEventListener("click", clearSearch);
  $("pane-0").addEventListener("mousedown", () => setActivePane(0));
  $("dupe-delete").addEventListener("click", () => void deleteSelectedDupes());
  $("dupe-done").addEventListener("click", () => void exitDupes());
  $("compare-copy-out").addEventListener("click", () => void copyMissing(true));
  $("compare-copy-in").addEventListener("click", () => void copyMissing(false));
  $("compare-done").addEventListener("click", () => void exitCompare());
  $("search-content").addEventListener("click", () => {
    state.contentMode = !state.contentMode;
    const btn = $("search-content");
    btn.setAttribute("aria-pressed", String(state.contentMode));
    btn.classList.toggle("is-active", state.contentMode);
    if (state.searching) void runSearch();
  });

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
  // A folder's size arrives after the listing: fill in its Size cell in
  // place instead of re-rendering the whole list. When sorting by size the
  // order itself depends on that number, so re-sort (debounced — sizes
  // arrive one per folder) instead of leaving the list mis-ordered.
  let sizeSortTimer = 0;
  void listen<{ path: string; size: number }>("folder-size", (ev) => {
    folderSizeCache.set(ev.payload.path, ev.payload.size);
    for (const suf of ["", "-1"]) {
      for (const tr of document.querySelectorAll(`#file-body${suf} tr`)) {
        if ((tr as HTMLTableRowElement).dataset.path === ev.payload.path) {
          const cell = tr.querySelector("td.num");
          if (cell) cell.textContent = fmtSize(ev.payload.size);
          break;
        }
      }
    }
    if (state.selection.has(ev.payload.path)) renderSelection();
    // Either pane may be sorting by size: re-sort both when one does.
    const anySizeSort = state.panes.some((p) => p.tabs[p.activeTab]?.sortKey === "size");
    if (anySizeSort) {
      window.clearTimeout(sizeSortTimer);
      sizeSortTimer = window.setTimeout(() => render(), 150);
    }
  });
  $("transfer-cancel").addEventListener("click", () => {
    ($("transfer-cancel") as HTMLButtonElement).disabled = true;
    void invoke("cancel_transfer");
  });
  // Never let the webview navigate away when a file is dropped on it.
  window.addEventListener("dragover", (ev) => ev.preventDefault());
  window.addEventListener("drop", (ev) => ev.preventDefault());
  window.addEventListener("focus", () => {
    void refreshDrives();
    void loadGitInfo();
  });

  const gitBadge = $("git-badge");
  if (gitBadge) {
    gitBadge.addEventListener("click", () => {
      if (!state.gitInfo) return;
      const branch = state.gitInfo.branch;
      void copyText(branch);
      toast(`Branch "${branch}" copied to clipboard`);
    });
    gitBadge.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      if (!state.gitInfo) return;
      const info = state.gitInfo;
      showMenuAt(ev.clientX, ev.clientY, [
        {
          label: `Copy branch (${info.branch})`,
          action: () => {
            void copyText(info.branch);
            toast(`Branch "${info.branch}" copied`);
          },
        },
        {
          label: "Open Terminal Here",
          action: () => void doOpenTerminal(state.path),
        },
        {
          label: "Refresh Git status",
          action: () => void loadGitInfo(),
        },
      ]);
    });
  }
  document.addEventListener("click", (ev) => {
    if (!(ev.target as HTMLElement).closest("#ctx-menu")) hideContextMenu();
  });
  document.addEventListener("keydown", (ev) => {
    const inField = (ev.target as HTMLElement).closest("input, select, textarea, dialog");
    if (ev.key === "Escape") {
      hideContextMenu();
      toggleAppearancePanel(false);
      toggleFilterPanel(false);
      hideAddressBar();
      closePalette();
      if (($("dlg-analyzer") as HTMLDialogElement).open) {
        closeDiskAnalyzer();
      }
    }
    // Ctrl+Shift+U opens the Disk Space Analyzer
    if ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && ev.key.toLowerCase() === "u") {
      ev.preventDefault();
      void openDiskAnalyzer();
      return;
    }
    // When Disk Space Analyzer is open, handle its navigation shortcuts
    if (($("dlg-analyzer") as HTMLDialogElement).open) {
      if (ev.key === "Backspace" || (ev.altKey && ev.key === "ArrowUp")) {
        ev.preventDefault();
        if (analyzerCurrentPath) {
          const p = parentOf(analyzerCurrentPath);
          if (p) void scanAnalyzerPath(p);
        }
        return;
      }
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "r") {
        ev.preventDefault();
        if (analyzerCurrentPath) void scanAnalyzerPath(analyzerCurrentPath);
        return;
      }
    }
    // Ctrl+K or Ctrl+P opens the Command Palette from anywhere
    if ((ev.ctrlKey || ev.metaKey) && (ev.key.toLowerCase() === "k" || ev.key.toLowerCase() === "p")) {
      ev.preventDefault();
      togglePalette();
      return;
    }
    // While Quick Look is open it owns the keyboard: Esc/Space close it,
    // Left/Right step through the listing, everything else is swallowed.
    if (quicklookOpen) {
      ev.preventDefault();
      if (ev.key === "Escape" || ev.key === " ") closeQuickLook();
      else if (ev.key === "ArrowRight") moveQuickLook(1);
      else if (ev.key === "ArrowLeft") moveQuickLook(-1);
      return;
    }
    // Ctrl+Shift+T reopens the last closed tab; plain Ctrl+T opens a fresh one.
    if ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && ev.key.toLowerCase() === "t") {
      ev.preventDefault();
      void reopenClosedTab();
      return;
    }
    // Tab shortcuts work even from the search box.
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "t") {
      ev.preventDefault();
      newTab();
      return;
    }
    // Ctrl+L focuses the address bar (works from a field too).
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "l") {
      ev.preventDefault();
      showAddressBar();
      return;
    }
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "w") {
      ev.preventDefault();
      void closeTab(state.activeTab);
      return;
    }
    // Ctrl+H toggles hidden files (the checkbox in the toolbar does the same).
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "h") {
      ev.preventDefault();
      toggleHiddenFiles();
      return;
    }
    // Ctrl+Shift+D toggles dual pane; Alt+1 / Alt+2 switch the active pane.
    if ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && ev.key.toLowerCase() === "d") {
      ev.preventDefault();
      void setDual(!state.dual);
      return;
    }
    if (ev.altKey && (ev.key === "1" || ev.key === "2")) {
      ev.preventDefault();
      if (state.dual) setActivePane(Number(ev.key) - 1);
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
    // Space opens Quick Look on the single selected file (not from a field,
    // where it types a space).
    if (ev.key === " " && !inField && state.selection.size === 1) {
      ev.preventDefault();
      openQuickLook();
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
    } else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "a") {
      ev.preventDefault();
      selectAll();
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
      if (state.selection.size > 1) {
        askBatchRename();
      } else {
        askRename();
      }
    } else if ((ev.ctrlKey || ev.metaKey) && (ev.key === "=" || ev.key === "+") && state.view === "icons") {
      ev.preventDefault();
      setGridZoom(Math.min(2, state.zoom + 1) as 0 | 1 | 2);
    } else if ((ev.ctrlKey || ev.metaKey) && ev.key === "-" && state.view === "icons") {
      ev.preventDefault();
      setGridZoom(Math.max(0, state.zoom - 1) as 0 | 1 | 2);
    } else if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      const step = state.view === "icons" ? gridColumns() : 1;
      moveSelection(ev.key === "ArrowDown" ? step : -step, ev.shiftKey);
    } else if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") {
      ev.preventDefault();
      if (state.view === "icons") moveSelection(ev.key === "ArrowRight" ? 1 : -1, ev.shiftKey);
    } else if (ev.key === "Home") {
      ev.preventDefault();
      moveSelectionTo(0, ev.shiftKey);
    } else if (ev.key === "End") {
      ev.preventDefault();
      moveSelectionTo(state.filtered.length - 1, ev.shiftKey);
    } else if (ev.key === "PageDown" || ev.key === "PageUp") {
      ev.preventDefault();
      moveSelection(ev.key === "PageDown" ? pageStep() : -pageStep(), ev.shiftKey);
    } else if (ev.key === "Enter" && state.selection.size === 1) {
      const e = selectedEntries()[0];
      if (e) void openEntry(e);
    } else if (ev.key === "Backspace") {
      const p = parentOf(state.path);
      if (p !== null) void navigate(p);
    } else if (ev.key === "F5" && state.dual) {
      ev.preventDefault();
      void transferToOtherPane(true);
    } else if (ev.key === "F6" && state.dual) {
      ev.preventDefault();
      void transferToOtherPane(false);
    }
  });

  ($("rename-confirm") as HTMLButtonElement).addEventListener("click", (ev) => {
    ev.preventDefault();
    void doRename();
  });
  ($("batch-confirm") as HTMLButtonElement).addEventListener("click", (ev) => {
    ev.preventDefault();
    void doBatchRename();
  });
  document.querySelectorAll(".batch-tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = (btn as HTMLElement).dataset.batchTab as BatchTab;
      if (tab) switchBatchTab(tab);
    });
  });
  const batchInputIds = [
    "batch-find", "batch-replace", "batch-match-case", "batch-regex", "batch-replace-all", "batch-include-ext",
    "batch-prefix", "batch-suffix",
    "batch-num-base", "batch-num-pos", "batch-num-sep", "batch-num-start", "batch-num-step", "batch-num-pad",
    "batch-case-style", "batch-case-scope",
    "batch-clean-spaces", "batch-clean-symbols", "batch-clean-numbers", "batch-clean-trim",
    "batch-global-case",
  ];
  for (const id of batchInputIds) {
    const el = $(id);
    if (el) {
      el.addEventListener("input", () => updateBatchPreview());
      el.addEventListener("change", () => updateBatchPreview());
    }
  }
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
  for (const id of ["dlg-rename", "dlg-new", "dlg-delete", "dlg-batch", "dlg-open-with", "dlg-palette", "dlg-analyzer"]) {
    ($(id) as HTMLDialogElement).addEventListener("click", (ev) => {
      if (ev.target === $(id)) {
        if (id === "dlg-analyzer") closeDiskAnalyzer();
        else ($(id) as HTMLDialogElement).close();
      }
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
  if (state.dual) await loadDirFor(1);
}

void init();
