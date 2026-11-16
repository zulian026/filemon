//! Filesystem operations for FileMon: listing, search, copy/move/delete
//! (delete goes to the freedesktop Trash), rename, create, properties.
//! Pure helpers are unit-tested; Tauri commands in lib.rs are thin wrappers.

use serde::Serialize;
use std::collections::VecDeque;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

#[derive(Debug, Clone, Serialize)]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: Option<u64>,
    pub modified: Option<i64>,
    pub extension: Option<String>,
    pub hidden: bool,
    /// Trash listings only: where the item lived before it was deleted.
    pub original_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct Drive {
    pub name: String,
    pub mount: String,
    pub total: u64,
    pub free: u64,
    pub fs: String,
    pub removable: bool,
    #[serde(default)]
    pub device: Option<String>,
    #[serde(default)]
    pub mounted: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Properties {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub items: Option<u64>,
    pub modified: Option<i64>,
    pub permissions: String,
    pub kind: String,
}

pub fn home_dir() -> PathBuf {
    std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/"))
}

fn entry_from(path: &Path, md: &fs::Metadata) -> Entry {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());
    let is_dir = md.is_dir();
    Entry {
        hidden: name.starts_with('.'),
        extension: if is_dir {
            None
        } else {
            path.extension()
                .map(|e| e.to_string_lossy().to_lowercase())
        },
        name,
        path: path.to_string_lossy().into_owned(),
        is_dir,
        is_symlink: path.symlink_metadata().map(|m| m.file_type().is_symlink()).unwrap_or(false),
        size: if is_dir { None } else { Some(md.len()) },
        modified: md.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs() as i64),
        original_path: None,
    }
}

/// List one directory. Entries are sorted: directories first, then name
/// (case-insensitive). Unreadable entries are skipped, never fatal.
pub fn list_dir(path: &Path) -> Result<Vec<Entry>, String> {
    let rd = fs::read_dir(path).map_err(|e| format!("Cannot open {}: {}", path.display(), e))?;
    let mut out = Vec::new();
    for item in rd.flatten() {
        let p = item.path();
        if let Ok(md) = fs::metadata(&p) {
            out.push(entry_from(&p, &md));
        }
    }
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

/// Resolve multiple file/folder paths into `Entry` structs. Missing or unreadable
/// paths are skipped cleanly.
pub fn get_entries(paths: &[String]) -> Vec<Entry> {
    let mut out = Vec::new();
    for p_str in paths {
        let p = PathBuf::from(p_str);
        if let Ok(md) = fs::metadata(&p) {
            out.push(entry_from(&p, &md));
        }
    }
    out
}

#[derive(serde::Deserialize)]
struct LsblkOutput {
    #[serde(default)]
    blockdevices: Vec<LsblkDevice>,
}

#[derive(serde::Deserialize)]
struct LsblkDevice {
    name: Option<String>,
    path: Option<String>,
    label: Option<String>,
    fstype: Option<String>,
    #[serde(default)]
    mountpoints: Vec<Option<String>>,
    size: Option<u64>,
    fsavail: Option<u64>,
    rm: Option<bool>,
    #[serde(default)]
    children: Vec<LsblkDevice>,
}

fn collect_lsblk_drives(devs: Vec<LsblkDevice>, out: &mut Vec<Drive>) {
    for dev in devs {
        if !dev.children.is_empty() {
            collect_lsblk_drives(dev.children, out);
        } else {
            let fstype = dev.fstype.clone().unwrap_or_default();
            if fstype == "swap" {
                continue;
            }
            let size = dev.size.unwrap_or(0);
            if size == 0 {
                continue;
            }
            // Skip tiny partition without filesystem and without label (e.g. 16MB MSR)
            if fstype.is_empty() && dev.label.as_deref().unwrap_or("").trim().is_empty() && size < 100_000_000 {
                continue;
            }

            let valid_mounts: Vec<String> = dev
                .mountpoints
                .into_iter()
                .flatten()
                .filter(|m| !m.is_empty() && m != "[SWAP]")
                .collect();

            let mounted = !valid_mounts.is_empty();
            let primary_mount = if valid_mounts.iter().any(|m| m == "/") {
                "/".to_string()
            } else if let Some(m) = valid_mounts.iter().find(|m| m.starts_with("/run/media") || m.starts_with("/media") || m.starts_with("/mnt")) {
                m.clone()
            } else if let Some(m) = valid_mounts.first() {
                m.clone()
            } else {
                String::new()
            };

            // Filter out internal system subvolumes/binds if root is already /
            if primary_mount.starts_with("/var/")
                || primary_mount == "/srv"
                || primary_mount == "/root"
            {
                continue;
            }

            let name = if let Some(ref l) = dev.label {
                let s = l.trim();
                if !s.is_empty() {
                    s.to_string()
                } else if primary_mount == "/" {
                    "System disk".to_string()
                } else if !primary_mount.is_empty() {
                    Path::new(&primary_mount)
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_else(|| primary_mount.clone())
                } else if let Some(ref p) = dev.path {
                    p.clone()
                } else {
                    dev.name.clone().unwrap_or_else(|| "Partition".to_string())
                }
            } else if primary_mount == "/" {
                "System disk".to_string()
            } else if !primary_mount.is_empty() {
                Path::new(&primary_mount)
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| primary_mount.clone())
            } else if let Some(ref p) = dev.path {
                p.clone()
            } else {
                dev.name.clone().unwrap_or_else(|| "Partition".to_string())
            };

            let free = dev.fsavail.unwrap_or(0);
            let removable = dev.rm.unwrap_or(false);

            out.push(Drive {
                name,
                mount: primary_mount,
                total: size,
                free,
                fs: fstype,
                removable,
                device: dev.path,
                mounted,
            });
        }
    }
}

fn drives_from_sysinfo() -> Vec<Drive> {
    use sysinfo::Disks;
    let disks = Disks::new_with_refreshed_list();
    let mut out: Vec<Drive> = disks
        .iter()
        .filter(|d| {
            let m = d.mount_point().to_string_lossy();
            d.total_space() > 0
                && !m.starts_with("/snap")
                && !m.starts_with("/var/lib/snapd")
                && !m.starts_with("/var/")
                && m != "/srv"
                && m != "/root"
                && !d.name().to_string_lossy().starts_with("loop")
        })
        .map(|d| {
            let mount = d.mount_point().to_string_lossy().into_owned();
            let name = if mount == "/" {
                "System disk".into()
            } else if mount.starts_with("/run/media/") || mount.starts_with("/media/") || mount.starts_with("/mnt/") {
                Path::new(&mount)
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| mount.clone())
            } else {
                mount.clone()
            };
            Drive {
                name,
                mount,
                total: d.total_space(),
                free: d.available_space(),
                fs: d.file_system().to_string_lossy().into_owned(),
                removable: d.is_removable(),
                device: Some(d.name().to_string_lossy().into_owned()),
                mounted: true,
            }
        })
        .collect();
    out.sort_by(|a, b| a.mount.cmp(&b.mount));
    out.dedup_by(|a, b| a.mount == b.mount);
    out
}

/// Drives and partitions detection via lsblk (with sysinfo fallback).
/// Lists mounted partitions and unmounted storage devices with volume labels.
pub fn drives() -> Vec<Drive> {
    let mut list = Vec::new();
    if let Ok(out) = std::process::Command::new("lsblk")
        .args(["-J", "-b", "-o", "NAME,PATH,LABEL,FSTYPE,MOUNTPOINTS,SIZE,FSAVAIL,RM,TYPE"])
        .output()
    {
        if out.status.success() {
            if let Ok(parsed) = serde_json::from_slice::<LsblkOutput>(&out.stdout) {
                collect_lsblk_drives(parsed.blockdevices, &mut list);
            }
        }
    }

    if list.is_empty() {
        return drives_from_sysinfo();
    }

    // Sort drives: System disk first, then mounted drives by name, then unmounted drives
    list.sort_by(|a, b| {
        let a_root = a.mount == "/";
        let b_root = b.mount == "/";
        if a_root != b_root {
            return b_root.cmp(&a_root);
        }
        if a.mounted != b.mounted {
            return b.mounted.cmp(&a.mounted);
        }
        a.name.to_lowercase().cmp(&b.name.to_lowercase())
    });

    list.dedup_by(|a, b| {
        if !a.mount.is_empty() && a.mount == b.mount {
            return true;
        }
        if a.device.is_some() && a.device == b.device {
            return true;
        }
        false
    });

    list
}

pub fn mount_drive(device: &str) -> Result<String, String> {
    let out = std::process::Command::new("udisksctl")
        .args(["mount", "-b", device])
        .output()
        .map_err(|e| format!("Failed to run udisksctl: {}", e))?;

    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(err.trim().to_string());
    }

    let stdout = String::from_utf8_lossy(&out.stdout);
    if let Some(pos) = stdout.find(" at ") {
        let path = stdout[pos + 4..].trim().trim_end_matches('.');
        return Ok(path.to_string());
    }

    std::thread::sleep(std::time::Duration::from_millis(150));
    let all = drives();
    if let Some(d) = all.iter().find(|d| d.device.as_deref() == Some(device) && d.mounted && !d.mount.is_empty()) {
        return Ok(d.mount.clone());
    }

    Ok(stdout.trim().to_string())
}

pub fn unmount_drive(target: &str) -> Result<(), String> {
    let mut cmd = std::process::Command::new("udisksctl");
    if target.starts_with("/dev/") {
        cmd.args(["unmount", "-b", target]);
    } else {
        cmd.args(["unmount", "-p", target]);
    }
    let out = cmd.output().map_err(|e| format!("Failed to run udisksctl: {}", e))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(err.trim().to_string());
    }
    Ok(())
}

/// Recursive name search under `root`. Bounded: max depth 10, 20 000 visited
/// directories, `max_results` hits. Hidden directories are skipped.
pub fn search(root: &Path, query: &str, max_results: usize) -> Vec<Entry> {
    let q = query.to_lowercase();
    let mut hits = Vec::new();
    let mut queue: VecDeque<(PathBuf, u8)> = VecDeque::from([(root.to_path_buf(), 0)]);
    let mut visited = 0usize;
    while let Some((dir, depth)) = queue.pop_front() {
        if hits.len() >= max_results || visited > 20_000 {
            break;
        }
        visited += 1;
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for item in rd.flatten() {
            let p = item.path();
            let Ok(md) = fs::metadata(&p) else { continue };
            let e = entry_from(&p, &md);
            if e.name.to_lowercase().contains(&q) {
                hits.push(e.clone());
                if hits.len() >= max_results {
                    break;
                }
            }
            if e.is_dir && depth < 10 && !e.hidden {
                queue.push_back((p, depth + 1));
            }
        }
    }
    hits
}

/// One content hit: the first matching line of a file, with its text.
#[derive(serde::Serialize, Clone, Debug)]
pub struct ContentMatch {
    pub entry: Entry,
    pub line: u32,
    pub snippet: String,
}

fn looks_binary(sample: &[u8]) -> bool {
    sample.iter().take(8192).any(|&b| b == 0)
}

/// Recursive content search under `root`: case-insensitive substring match
/// on text lines. Bounds match name search (depth 10, 20 000 visited dirs),
/// plus: files over 1 MB are skipped, binary files (NUL in the first 8 KB)
/// are skipped, one hit (the first matching line) per file.
pub fn search_content(root: &Path, query: &str, max_results: usize) -> Vec<ContentMatch> {
    let q = query.to_lowercase();
    let mut hits = Vec::new();
    let mut queue: VecDeque<(PathBuf, u8)> = VecDeque::from([(root.to_path_buf(), 0)]);
    let mut visited = 0usize;
    while let Some((dir, depth)) = queue.pop_front() {
        if hits.len() >= max_results || visited > 20_000 {
            break;
        }
        visited += 1;
        let Ok(rd) = fs::read_dir(&dir) else {
            continue;
        };
        for item in rd.flatten() {
            if hits.len() >= max_results {
                break;
            }
            let p = item.path();
            let Ok(md) = fs::metadata(&p) else {
                continue;
            };
            let e = entry_from(&p, &md);
            if e.is_dir {
                if depth < 10 && !e.hidden {
                    queue.push_back((p, depth + 1));
                }
                continue;
            }
            if e.size.unwrap_or(0) > 1024 * 1024 {
                continue;
            }
            let Ok(bytes) = fs::read(&p) else {
                continue;
            };
            if looks_binary(&bytes) {
                continue;
            }
            let text = String::from_utf8_lossy(&bytes);
            for (i, line) in text.lines().enumerate() {
                if line.to_lowercase().contains(&q) {
                    let snippet: String = line.trim().chars().take(120).collect();
                    hits.push(ContentMatch {
                        entry: e,
                        line: (i + 1) as u32,
                        snippet,
                    });
                    break;
                }
            }
        }
    }
    hits
}

/// One group of files with identical content.
#[derive(serde::Serialize, Clone, Debug)]
pub struct DupeGroup {
    pub size: u64,
    pub entries: Vec<Entry>,
}

fn file_hash(path: &Path) -> Option<u64> {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::Hasher;
    let mut f = fs::File::open(path).ok()?;
    let mut hasher = DefaultHasher::new();
    let mut buf = [0u8; 65536];
    use std::io::Read;
    loop {
        let n = f.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        hasher.write(&buf[..n]);
    }
    Some(hasher.finish())
}

fn files_identical(a: &Path, b: &Path) -> bool {
    use std::io::Read;
    let mut fa = match fs::File::open(a) {
        Ok(f) => f,
        Err(_) => return false,
    };
    let mut fb = match fs::File::open(b) {
        Ok(f) => f,
        Err(_) => return false,
    };
    let mut ba = [0u8; 65536];
    let mut bb = [0u8; 65536];
    loop {
        let na = match fa.read(&mut ba) {
            Ok(n) => n,
            Err(_) => return false,
        };
        let nb = match fb.read(&mut bb) {
            Ok(n) => n,
            Err(_) => return false,
        };
        if na != nb || ba[..na] != bb[..nb] {
            return false;
        }
        if na == 0 {
            return true;
        }
    }
}

/// Find duplicate files under `root`, grouped by identical content.
/// Walk bounds match name search; empty files are excluded (every empty
/// file would "duplicate" every other); files over 200 MB are skipped.
/// Grouping is size → hash → byte comparison, so a hash collision alone
/// can never report a false duplicate.
/// Folder comparison for dual pane: names matched at the top level only.
/// Same-name files are "same" when size and content hash match; folders
/// with the same name are not recursed into (they count as same). Hidden
/// entries are included only when `include_hidden` is set.
#[derive(Debug, Clone, Serialize)]
pub struct CompareResult {
    pub only_a: Vec<Entry>,
    pub only_b: Vec<Entry>,
    pub different: Vec<Entry>,
    pub same: usize,
}

pub fn compare_dirs(a: &Path, b: &Path, include_hidden: bool) -> Result<CompareResult, String> {
    let la = list_dir(a)?;
    let lb = list_dir(b)?;
    let la: Vec<Entry> = la.into_iter().filter(|e| include_hidden || !e.hidden).collect();
    let lb: Vec<Entry> = lb.into_iter().filter(|e| include_hidden || !e.hidden).collect();
    let mut by_name_b: std::collections::HashMap<&str, &Entry> = std::collections::HashMap::new();
    for e in &lb {
        by_name_b.insert(e.name.as_str(), e);
    }
    let mut only_a = Vec::new();
    let mut different = Vec::new();
    let mut same = 0usize;
    for ea in &la {
        match by_name_b.get(ea.name.as_str()) {
            None => only_a.push(ea.clone()),
            Some(eb) => {
                if ea.is_dir && eb.is_dir {
                    same += 1;
                } else if ea.is_dir != eb.is_dir {
                    different.push(ea.clone());
                } else if ea.size == eb.size && file_hash(Path::new(&ea.path)) == file_hash(Path::new(&eb.path)) {
                    same += 1;
                } else {
                    different.push(ea.clone());
                }
            }
        }
    }
    let names_a: std::collections::HashSet<&str> = la.iter().map(|e| e.name.as_str()).collect();
    let only_b: Vec<Entry> = lb.into_iter().filter(|e| !names_a.contains(e.name.as_str())).collect();
    Ok(CompareResult { only_a, only_b, different, same })
}

pub fn find_duplicates(root: &Path) -> Vec<DupeGroup> {
    let mut by_size: std::collections::HashMap<u64, Vec<PathBuf>> = std::collections::HashMap::new();
    let mut queue: VecDeque<(PathBuf, u8)> = VecDeque::from([(root.to_path_buf(), 0)]);
    let mut visited = 0usize;
    while let Some((dir, depth)) = queue.pop_front() {
        if visited > 20_000 {
            break;
        }
        visited += 1;
        let Ok(rd) = fs::read_dir(&dir) else {
            continue;
        };
        for item in rd.flatten() {
            let p = item.path();
            let Ok(md) = fs::metadata(&p) else {
                continue;
            };
            let e = entry_from(&p, &md);
            if e.is_dir {
                if depth < 10 && !e.hidden {
                    queue.push_back((p, depth + 1));
                }
                continue;
            }
            let size = e.size.unwrap_or(0);
            if size == 0 || size > 200 * 1024 * 1024 {
                continue;
            }
            by_size.entry(size).or_default().push(p);
        }
    }
    let mut groups = Vec::new();
    for (size, paths) in by_size {
        if paths.len() < 2 {
            continue;
        }
        let mut by_hash: std::collections::HashMap<u64, Vec<PathBuf>> = std::collections::HashMap::new();
        for p in paths {
            if let Some(h) = file_hash(&p) {
                by_hash.entry(h).or_default().push(p);
            }
        }
        for (_, hpaths) in by_hash {
            if hpaths.len() < 2 {
                continue;
            }
            // Verify byte-for-byte against the first file of the hash group.
            let first = &hpaths[0];
            let mut confirmed: Vec<Entry> = Vec::new();
            if let Ok(md) = fs::metadata(first) {
                confirmed.push(entry_from(first, &md));
            }
            for p in &hpaths[1..] {
                if files_identical(first, p) {
                    if let Ok(md) = fs::metadata(p) {
                        confirmed.push(entry_from(p, &md));
                    }
                }
            }
            if confirmed.len() > 1 {
                confirmed.sort_by(|a, b| a.path.cmp(&b.path));
                groups.push(DupeGroup {
                    size,
                    entries: confirmed,
                });
            }
        }
    }
    groups.sort_by(|a, b| {
        b.size
            .cmp(&a.size)
            .then_with(|| a.entries[0].path.cmp(&b.entries[0].path))
    });
    groups
}

/// A name that does not collide inside `dir`: "name", "name (2)", "name (3)".
/// The "(copy)" suffix is applied by the caller before this runs.
pub fn unique_name(dir: &Path, base: &str) -> String {
    if !dir.join(base).exists() {
        return base.to_string();
    }
    let (stem, ext) = split_name(base);
    let mut n = 2;
    loop {
        let cand = match &ext {
            Some(e) => format!("{} ({}){}", stem, n, e),
            None => format!("{} ({})", stem, n),
        };
        if !dir.join(&cand).exists() {
            return cand;
        }
        n += 1;
    }
}

/// Split "archive.tar.gz" into ("archive.tar", ".gz"); "README" into ("README", None).
pub fn split_name(name: &str) -> (&str, Option<String>) {
    match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], Some(name[i..].to_string())),
        _ => (name, None),
    }
}

fn copy_name(dest: &Path, name: &str) -> PathBuf {
    let (stem, ext) = split_name(name);
    let base = match ext {
        Some(e) => format!("{} (copy){}", stem, e),
        None => format!("{} (copy)", stem),
    };
    dest.join(unique_name(dest, &base))
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    let rd = fs::read_dir(src).map_err(|e| e.to_string())?;
    for item in rd.flatten() {
        let p = item.path();
        let target = dst.join(item.file_name());
        let md = fs::symlink_metadata(&p).map_err(|e| e.to_string())?;
        if md.is_dir() {
            copy_dir_recursive(&p, &target)?;
        } else if md.file_type().is_symlink() {
            if let Ok(t) = fs::read_link(&p) {
                let _ = std::os::unix::fs::symlink(&t, &target);
            }
        } else {
            fs::copy(&p, &target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub fn copy_paths(paths: &[PathBuf], dest: &Path) -> Result<usize, String> {
    if !dest.is_dir() {
        return Err(format!("{} is not a folder", dest.display()));
    }
    let mut done = 0;
    for src in paths {
        let name = src
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .ok_or_else(|| "Bad path".to_string())?;
        let target = if dest.join(&name).exists() {
            copy_name(dest, &name)
        } else {
            dest.join(&name)
        };
        let md = fs::symlink_metadata(src).map_err(|e| e.to_string())?;
        if md.is_dir() {
            copy_dir_recursive(src, &target)?;
        } else if md.file_type().is_symlink() {
            let t = fs::read_link(src).map_err(|e| e.to_string())?;
            std::os::unix::fs::symlink(&t, &target).map_err(|e| e.to_string())?;
        } else {
            fs::copy(src, &target).map_err(|e| e.to_string())?;
        }
        done += 1;
    }
    Ok(done)
}

pub fn move_paths(paths: &[PathBuf], dest: &Path) -> Result<usize, String> {
    if !dest.is_dir() {
        return Err(format!("{} is not a folder", dest.display()));
    }
    let mut done = 0;
    for src in paths {
        let name = src
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .ok_or_else(|| "Bad path".to_string())?;
        let target = if dest.join(&name).exists() {
            copy_name(dest, &name)
        } else {
            dest.join(&name)
        };
        match fs::rename(src, &target) {
            Ok(()) => done += 1,
            Err(_) => {
                // Cross-device move: copy, then delete the source.
                copy_paths(std::slice::from_ref(src), dest)?;
                let moved = dest.join(&name);
                if moved.exists() {
                    delete_paths(&[src.clone()])?;
                    done += 1;
                } else {
                    return Err(format!("Could not move {}", src.display()));
                }
            }
        }
    }
    Ok(done)
}

// ---- Chunked transfer with progress + cancel (copy/move) ----
// Same semantics as copy_paths/move_paths (collision "(copy)" names,
// cross-device move falls back to copy + delete), but files are copied in
// 1 MiB chunks so progress can be reported per chunk and a cancel flag can
// stop the transfer between chunks. A cancelled transfer returns Ok with
// cancelled=true and leaves whatever was already copied in place.

#[derive(Debug, Clone, Serialize)]
pub struct TransferProgress {
    pub done_bytes: u64,
    pub total_bytes: u64,
    pub current: String,
    pub done_files: usize,
    pub total_files: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct TransferOutcome {
    pub done: usize,
    pub cancelled: bool,
}

const CHUNK: usize = 1024 * 1024;

enum TxErr {
    Fail(String),
    Cancel,
}

struct TxCtx<'a> {
    state: TransferProgress,
    on_progress: &'a dyn Fn(&TransferProgress),
    cancelled: &'a AtomicBool,
}

impl<'a> TxCtx<'a> {
    fn new(
        total_bytes: u64,
        total_files: usize,
        on_progress: &'a dyn Fn(&TransferProgress),
        cancelled: &'a AtomicBool,
    ) -> Self {
        TxCtx {
            state: TransferProgress {
                done_bytes: 0,
                total_bytes,
                current: String::new(),
                done_files: 0,
                total_files,
            },
            on_progress,
            cancelled,
        }
    }

    fn check_cancel(&self) -> Result<(), TxErr> {
        if self.cancelled.load(Ordering::Relaxed) {
            Err(TxErr::Cancel)
        } else {
            Ok(())
        }
    }

    fn emit(&self) {
        (self.on_progress)(&self.state);
    }

    /// Record bytes copied; emits on every chunk (1 MiB granularity) so the
    /// progress callback can also drive cancellation deterministically.
    fn bump(&mut self, bytes: u64) -> Result<(), TxErr> {
        self.state.done_bytes += bytes;
        self.emit();
        self.check_cancel()
    }

    fn file_done(&mut self, name: String) {
        self.state.done_files += 1;
        self.state.current = name;
        self.emit();
    }

    /// A whole source finished instantly (same-device rename): count its
    /// pre-walked bytes/files at once.
    fn source_done(&mut self, name: String, bytes: u64, files: usize) {
        self.state.done_bytes += bytes;
        self.state.done_files += files;
        self.state.current = name;
        self.emit();
    }
}

fn leaf_name(p: &Path) -> String {
    p.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn count_source(p: &Path, bytes: &mut u64, files: &mut usize) -> Result<(), String> {
    let md = fs::symlink_metadata(p).map_err(|e| e.to_string())?;
    if md.file_type().is_symlink() {
        *files += 1;
    } else if md.is_dir() {
        for item in fs::read_dir(p).map_err(|e| e.to_string())?.flatten() {
            count_source(&item.path(), bytes, files)?;
        }
    } else {
        *bytes += md.len();
        *files += 1;
    }
    Ok(())
}

fn copy_file_chunked(src: &Path, dst: &Path, ctx: &mut TxCtx) -> Result<(), TxErr> {
    let mut r = fs::File::open(src).map_err(|e| TxErr::Fail(e.to_string()))?;
    let mut w = fs::File::create(dst).map_err(|e| TxErr::Fail(e.to_string()))?;
    let mut buf = vec![0u8; CHUNK];
    loop {
        ctx.check_cancel()?;
        match r.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                w.write_all(&buf[..n])
                    .map_err(|e| TxErr::Fail(e.to_string()))?;
                ctx.bump(n as u64)?;
            }
            Err(e) => return Err(TxErr::Fail(e.to_string())),
        }
    }
    Ok(())
}

fn copy_one_tx(src: &Path, target: &Path, ctx: &mut TxCtx) -> Result<(), TxErr> {
    let md = fs::symlink_metadata(src).map_err(|e| TxErr::Fail(e.to_string()))?;
    if md.is_dir() {
        fs::create_dir_all(target).map_err(|e| TxErr::Fail(e.to_string()))?;
        for item in fs::read_dir(src)
            .map_err(|e| TxErr::Fail(e.to_string()))?
            .flatten()
        {
            let p = item.path();
            copy_one_tx(&p, &target.join(item.file_name()), ctx)?;
        }
        Ok(())
    } else if md.file_type().is_symlink() {
        if let Ok(t) = fs::read_link(src) {
            let _ = std::os::unix::fs::symlink(&t, target);
        }
        ctx.file_done(leaf_name(src));
        Ok(())
    } else {
        copy_file_chunked(src, target, ctx)?;
        ctx.file_done(leaf_name(src));
        Ok(())
    }
}

pub fn transfer_files(
    paths: &[PathBuf],
    dest: &Path,
    copy: bool,
    on_progress: &dyn Fn(&TransferProgress),
    cancelled: &AtomicBool,
) -> Result<TransferOutcome, String> {
    if !dest.is_dir() {
        return Err(format!("{} is not a folder", dest.display()));
    }
    let mut totals: Vec<(u64, usize)> = Vec::with_capacity(paths.len());
    let mut total_bytes = 0u64;
    let mut total_files = 0usize;
    for src in paths {
        let mut b = 0u64;
        let mut f = 0usize;
        count_source(src, &mut b, &mut f)?;
        totals.push((b, f));
        total_bytes += b;
        total_files += f;
    }
    let mut ctx = TxCtx::new(total_bytes, total_files, on_progress, cancelled);
    let mut done = 0usize;
    for (i, src) in paths.iter().enumerate() {
        let name = src
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .ok_or_else(|| "Bad path".to_string())?;
        let target = if dest.join(&name).exists() {
            copy_name(dest, &name)
        } else {
            dest.join(&name)
        };
        let (src_bytes, src_files) = totals[i];
        if !copy {
            match fs::rename(src, &target) {
                Ok(()) => {
                    ctx.source_done(name, src_bytes, src_files);
                    done += 1;
                    continue;
                }
                Err(_) => { /* cross-device: fall through to copy + delete */ }
            }
        }
        match copy_one_tx(src, &target, &mut ctx) {
            Ok(()) => {
                done += 1;
                if !copy {
                    // Cross-device move: delete the source now that the copy is complete.
                    delete_paths(std::slice::from_ref(src))?;
                }
            }
            Err(TxErr::Cancel) => {
                return Ok(TransferOutcome {
                    done,
                    cancelled: true,
                });
            }
            Err(TxErr::Fail(e)) => return Err(e),
        }
    }
    Ok(TransferOutcome {
        done,
        cancelled: false,
    })
}

// ---- Zip / unzip ----
// Archives are plain .zip (deflate). Symlinks are stored as symlink entries
// and restored as symlinks on extract. Extraction is guarded against
// zip-slip: any absolute path or `..` component aborts before anything is
// written.

pub fn compress_paths(paths: &[PathBuf], dest: &Path) -> Result<String, String> {
    if !dest.is_dir() {
        return Err(format!("{} is not a folder", dest.display()));
    }
    let base = if paths.len() == 1 {
        paths[0]
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "Archive".into())
    } else {
        "Archive".into()
    };
    let name = format!("{}.zip", base);
    let target = if dest.join(&name).exists() {
        copy_name(dest, &name)
    } else {
        dest.join(&name)
    };
    let file = fs::File::create(&target).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for src in paths {
        let rel = PathBuf::from(
            src.file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
        );
        add_to_zip(&mut zip, src, &rel, &options)?;
    }
    zip.finish().map_err(|e| e.to_string())?;
    Ok(target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or(name))
}

fn add_to_zip<W: Write + std::io::Seek>(
    zip: &mut zip::ZipWriter<W>,
    src: &Path,
    rel: &Path,
    options: &zip::write::SimpleFileOptions,
) -> Result<(), String> {
    let md = fs::symlink_metadata(src).map_err(|e| e.to_string())?;
    let entry_name = rel.to_string_lossy().into_owned();
    if md.is_dir() {
        zip.add_directory(format!("{}/", entry_name), *options)
            .map_err(|e| e.to_string())?;
        for item in fs::read_dir(src).map_err(|e| e.to_string())?.flatten() {
            add_to_zip(zip, &item.path(), &rel.join(item.file_name()), options)?;
        }
    } else if md.file_type().is_symlink() {
        let target = fs::read_link(src).map_err(|e| e.to_string())?;
        zip.add_symlink(entry_name, target.to_string_lossy().as_ref(), *options)
            .map_err(|e| e.to_string())?;
    } else {
        zip.start_file(entry_name, *options)
            .map_err(|e| e.to_string())?;
        let mut f = fs::File::open(src).map_err(|e| e.to_string())?;
        std::io::copy(&mut f, zip).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn extract_archive(path: &Path, dest: &Path) -> Result<String, String> {
    if !dest.is_dir() {
        return Err(format!("{} is not a folder", dest.display()));
    }
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "extracted".into());
    let folder = if dest.join(&stem).exists() {
        copy_name(dest, &stem)
    } else {
        dest.join(&stem)
    };
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    // Validate every entry name first: a bad archive writes nothing.
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let rel = Path::new(entry.name());
        if rel.is_absolute()
            || rel
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return Err(format!("Unsafe entry in archive: {}", entry.name()));
        }
    }
    // A zip that holds a single root folder (the usual case when FileMon
    // compresses a folder) extracts into the stem folder WITHOUT duplicating
    // that root: tree.zip -> tree/a.txt, not tree/tree/a.txt.
    let strip_root = {
        let mut firsts = std::collections::HashSet::new();
        let mut root_is_dir = false;
        for i in 0..archive.len() {
            let entry = archive.by_index(i).map_err(|e| e.to_string())?;
            let p = Path::new(entry.name());
            let mut comps = p.components();
            if let Some(first) = comps.next() {
                firsts.insert(first.as_os_str().to_string_lossy().into_owned());
                if comps.next().is_some() {
                    root_is_dir = true;
                }
            }
        }
        firsts.len() == 1 && root_is_dir
    };
    fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    use std::os::unix::fs::PermissionsExt;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let rel: PathBuf = if strip_root {
            Path::new(entry.name()).components().skip(1).collect()
        } else {
            PathBuf::from(entry.name())
        };
        if rel.as_os_str().is_empty() {
            continue; // the root dir entry itself
        }
        let out = folder.join(&rel);
        if entry.is_dir() {
            fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mode = entry.unix_mode().unwrap_or(0);
        if mode & 0o170000 == 0o120000 {
            // Symlink entry: contents are the link target.
            let mut target = String::new();
            entry
                .read_to_string(&mut target)
                .map_err(|e| e.to_string())?;
            let _ = std::os::unix::fs::symlink(&target, &out);
        } else {
            let mut w = fs::File::create(&out).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut w).map_err(|e| e.to_string())?;
            if mode != 0 {
                let _ = fs::set_permissions(&out, fs::Permissions::from_mode(mode & 0o7777));
            }
        }
    }
    Ok(folder
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or(stem))
}

fn trash_dirs() -> (PathBuf, PathBuf) {
    let base = home_dir().join(".local/share/Trash");
    (base.join("files"), base.join("info"))
}

/// Move paths to the freedesktop Trash and write the .trashinfo sidecar.
/// Returns the number of items trashed.
pub fn delete_paths(paths: &[PathBuf]) -> Result<usize, String> {
    let (files_dir, info_dir) = trash_dirs();
    fs::create_dir_all(&files_dir).map_err(|e| e.to_string())?;
    fs::create_dir_all(&info_dir).map_err(|e| e.to_string())?;
    let now = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string();
    let mut done = 0;
    for src in paths {
        let name = src
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .ok_or_else(|| "Bad path".to_string())?;
        let trash_name = unique_name(&files_dir, &name);
        let target = files_dir.join(&trash_name);
        fs::rename(src, &target).map_err(|e| e.to_string())?;
        let info = format!(
            "[Trash Info]\nPath={}\nDeletionDate={}\n",
            url_encode_path(src),
            now
        );
        fs::write(info_dir.join(format!("{}.trashinfo", trash_name)), info)
            .map_err(|e| e.to_string())?;
        done += 1;
    }
    Ok(done)
}

// ---- Trash browsing: list / restore / delete permanently / empty ----
// The `_in` cores take explicit trash dirs so tests can use a temp Trash
// instead of the real ~/.local/share/Trash; the public wrappers use trash_dirs().

fn url_decode_path(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Parse a .trashinfo body into (original path, deletion epoch or None).
fn parse_trashinfo(text: &str) -> Option<(String, Option<i64>)> {
    let mut path: Option<String> = None;
    let mut deleted: Option<i64> = None;
    for line in text.lines() {
        if let Some(v) = line.strip_prefix("Path=") {
            path = Some(url_decode_path(v.trim()));
        } else if let Some(v) = line.strip_prefix("DeletionDate=") {
            if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(v.trim(), "%Y-%m-%dT%H:%M:%S") {
                use chrono::TimeZone;
                deleted = chrono::Local
                    .from_local_datetime(&naive)
                    .single()
                    .map(|d| d.timestamp());
            }
        }
    }
    path.map(|p| (p, deleted))
}

fn trash_info_for(info_dir: &Path, name: &str) -> Option<(String, Option<i64>)> {
    let text = fs::read_to_string(info_dir.join(format!("{}.trashinfo", name))).ok()?;
    parse_trashinfo(&text)
}

pub fn list_trash_in(files_dir: &Path, info_dir: &Path) -> Vec<Entry> {
    let mut out = Vec::new();
    let Ok(rd) = fs::read_dir(files_dir) else {
        return out;
    };
    for item in rd.flatten() {
        let p = item.path();
        let Ok(md) = fs::symlink_metadata(&p) else {
            continue;
        };
        let mut e = entry_from(&p, &md);
        // Directories report None for size in entry_from; sum them for Trash.
        if e.is_dir {
            e.size = Some(dir_size(&p).0);
        }
        if let Some((orig, deleted)) = trash_info_for(info_dir, &e.name) {
            e.original_path = Some(orig);
            // The Date column shows when the item was deleted.
            if deleted.is_some() {
                e.modified = deleted;
            }
        }
        out.push(e);
    }
    out.sort_by(|a, b| {
        b.modified
            .unwrap_or(0)
            .cmp(&a.modified.unwrap_or(0))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    out
}

pub fn list_trash() -> Vec<Entry> {
    let (files_dir, info_dir) = trash_dirs();
    list_trash_in(&files_dir, &info_dir)
}

fn remove_trash_item(p: &Path) -> Result<(), String> {
    let md = fs::symlink_metadata(p).map_err(|e| e.to_string())?;
    if md.is_dir() && !md.file_type().is_symlink() {
        fs::remove_dir_all(p).map_err(|e| e.to_string())
    } else {
        fs::remove_file(p).map_err(|e| e.to_string())
    }
}

/// Move trashed items back to their original locations. A missing parent
/// folder is recreated; a name collision at the original location gets a
/// " (copy)" suffix (via move_paths). Items without a .trashinfo are
/// restored to the home folder instead of being lost.
pub fn restore_trash_in(_files_dir: &Path, info_dir: &Path, paths: &[PathBuf]) -> Result<usize, String> {
    let mut done = 0;
    for trash_path in paths {
        let name = trash_path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .ok_or_else(|| "Bad path".to_string())?;
        let (orig, _) = trash_info_for(info_dir, &name)
            .map(|(p, d)| (PathBuf::from(p), d))
            .unwrap_or_else(|| (home_dir().join(&name), None));
        let parent = orig.parent().map(|p| p.to_path_buf()).unwrap_or_else(home_dir);
        fs::create_dir_all(&parent).map_err(|e| e.to_string())?;
        move_paths(std::slice::from_ref(trash_path), &parent)?;
        let _ = fs::remove_file(info_dir.join(format!("{}.trashinfo", name)));
        done += 1;
    }
    Ok(done)
}

pub fn restore_trash(paths: &[PathBuf]) -> Result<usize, String> {
    let (files_dir, info_dir) = trash_dirs();
    restore_trash_in(&files_dir, &info_dir, paths)
}

/// Delete trashed items permanently (bypassing the Trash) with their .trashinfo.
pub fn delete_trash_in(_files_dir: &Path, info_dir: &Path, paths: &[PathBuf]) -> Result<usize, String> {
    let mut done = 0;
    for trash_path in paths {
        let name = trash_path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .ok_or_else(|| "Bad path".to_string())?;
        remove_trash_item(trash_path)?;
        let _ = fs::remove_file(info_dir.join(format!("{}.trashinfo", name)));
        done += 1;
    }
    Ok(done)
}

pub fn delete_trash(paths: &[PathBuf]) -> Result<usize, String> {
    let (files_dir, info_dir) = trash_dirs();
    delete_trash_in(&files_dir, &info_dir, paths)
}

pub fn empty_trash_in(files_dir: &Path, info_dir: &Path) -> Result<usize, String> {
    let items: Vec<PathBuf> = fs::read_dir(files_dir)
        .map(|rd| rd.flatten().map(|i| i.path()).collect())
        .unwrap_or_default();
    delete_trash_in(files_dir, info_dir, &items)
}

pub fn empty_trash() -> Result<usize, String> {
    let (files_dir, info_dir) = trash_dirs();
    empty_trash_in(&files_dir, &info_dir)
}

/// Percent-encode a path the way .trashinfo expects (keeps '/' intact).
pub fn url_encode_path(p: &Path) -> String {
    let mut out = String::new();
    for b in p.to_string_lossy().bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'/' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

pub fn validate_new_name(name: &str) -> Result<(), String> {
    let n = name.trim();
    if n.is_empty() {
        return Err("Name cannot be empty".into());
    }
    if n == "." || n == ".." || n.contains('/') || n.contains('\0') {
        return Err("Name cannot contain /".into());
    }
    Ok(())
}

pub fn rename_path(path: &Path, new_name: &str) -> Result<String, String> {
    validate_new_name(new_name)?;
    let parent = path.parent().ok_or("No parent folder")?;
    let target = parent.join(new_name.trim());
    if target.exists() {
        return Err(format!("{} already exists", new_name.trim()));
    }
    fs::rename(path, &target).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().into_owned())
}

pub fn new_folder(parent: &Path, name: &str) -> Result<String, String> {
    validate_new_name(name)?;
    let target = parent.join(name.trim());
    fs::create_dir(&target).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().into_owned())
}

pub fn new_file(parent: &Path, name: &str) -> Result<String, String> {
    validate_new_name(name)?;
    let target = parent.join(name.trim());
    fs::write(&target, b"").map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().into_owned())
}

/// Recursive size of a directory, capped at 200 000 visited entries so a
/// huge tree cannot hang the properties dialog. Returns (bytes, items).
pub fn dir_size(path: &Path) -> (u64, u64) {
    let mut bytes = 0u64;
    let mut items = 0u64;
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if items > 200_000 {
            break;
        }
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for item in rd.flatten() {
            items += 1;
            let p = item.path();
            if let Ok(md) = fs::symlink_metadata(&p) {
                if md.is_dir() {
                    stack.push(p);
                } else {
                    bytes = bytes.saturating_add(md.len());
                }
            }
        }
    }
    (bytes, items)
}

pub fn kind_of(path: &Path, is_dir: bool) -> String {
    if is_dir {
        return "Folder".into();
    }
    match path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .as_deref()
    {
        Some("png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp") => "Image".into(),
        Some("mp4" | "mkv" | "webm" | "mov" | "avi") => "Video".into(),
        Some("mp3" | "flac" | "wav" | "ogg" | "m4a") => "Audio".into(),
        Some("pdf") => "PDF document".into(),
        Some("zip" | "tar" | "gz" | "xz" | "7z" | "rar" | "deb" | "rpm") => "Archive".into(),
        Some("txt" | "md" | "rs" | "py" | "js" | "ts" | "json" | "toml" | "html" | "css" | "sh") => {
            "Text file".into()
        }
        Some(ext) => format!("{} file", ext.to_uppercase()),
        None => "File".into(),
    }
}

pub fn properties(path: &Path) -> Result<Properties, String> {
    let md = fs::metadata(path).map_err(|e| e.to_string())?;
    let is_dir = md.is_dir();
    let (size, items) = if is_dir {
        let (s, n) = dir_size(path);
        (s, Some(n))
    } else {
        (md.len(), None)
    };
    use std::os::unix::fs::PermissionsExt;
    Ok(Properties {
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string_lossy().into_owned()),
        path: path.to_string_lossy().into_owned(),
        is_dir,
        size,
        items,
        modified: md.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs() as i64),
        permissions: format!("{:o}", md.permissions().mode() & 0o777),
        kind: kind_of(path, is_dir),
    })
}

/// One entry inside an archive (zip or tar family), for the preview pane.
#[derive(Debug, Clone, Serialize)]
pub struct ArchiveEntry {
    pub name: String,
    pub size: Option<u64>,
    pub is_dir: bool,
}

/// List an archive's contents without extracting it. .zip is read with the
/// zip crate; the tar family (tar/tgz/tar.gz/tar.xz/tar.bz2) goes through
/// the system tar. A plain .gz (not a tar) and anything unreadable errors,
/// and the caller falls back to the generic summary. Capped at 300 entries.
pub fn list_archive(path: &Path) -> Result<Vec<ArchiveEntry>, String> {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let name = path.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    if ext == "zip" {
        let file = fs::File::open(path).map_err(|e| e.to_string())?;
        let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for i in 0..archive.len().min(300) {
            let entry = archive.by_index(i).map_err(|e| e.to_string())?;
            out.push(ArchiveEntry {
                name: entry.name().to_string(),
                size: Some(entry.size()),
                is_dir: entry.is_dir(),
            });
        }
        return Ok(out);
    }
    let flag = if ext == "tar" {
        "-tf"
    } else if ext == "tgz" || name.ends_with(".tar.gz") {
        "-tzf"
    } else if name.ends_with(".tar.xz") {
        "-tJf"
    } else if name.ends_with(".tar.bz2") {
        "-tjf"
    } else {
        return Err("unsupported archive type".to_string());
    };
    let out = std::process::Command::new("tar")
        .arg(flag)
        .arg(path)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    Ok(text
        .lines()
        .take(300)
        .map(|l| ArchiveEntry {
            is_dir: l.ends_with('/'),
            name: l.to_string(),
            size: None,
        })
        .collect())
}

/// SHA-256 of a file via the system sha256sum (coreutils, always present).
/// The hash is shown in Properties; same input always yields the same hex.
pub fn file_sha256(path: &Path) -> Result<String, String> {
    let out = std::process::Command::new("sha256sum")
        .arg(path)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    text.split_whitespace()
        .next()
        .map(|s| s.to_string())
        .ok_or_else(|| "sha256sum produced no output".to_string())
}

/// Change a file or folder's permission bits (0o000–0o7777). Returns the new
/// octal mode string as shown in Properties.
pub fn set_permissions(path: &Path, mode: u32) -> Result<String, String> {
    if mode > 0o7777 {
        return Err("mode out of range (0o000–0o7777)".to_string());
    }
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).map_err(|e| e.to_string())?;
    Ok(format!("{:o}", mode & 0o7777))
}

pub fn read_text(path: &Path, max_bytes: usize) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let end = bytes.len().min(max_bytes);
    Ok(String::from_utf8_lossy(&bytes[..end]).into_owned())
}

/// First frame of a video file, or a downscaled image, as a base64 PNG —
/// cached on disk so a folder revisited does not regenerate its thumbnails.
/// Cache: $XDG_CACHE_HOME/filemon/thumbs (else ~/.cache), one PNG per
/// source file, keyed by path + size + mtime. A cached PNG is used only
/// when it is at least as new as the source file, so an edited image or a
/// replaced video re-renders. Images go through the image crate; video
/// goes through ffmpeg (a <video> element is not an option: this WebKitGTK
/// crashes its web process on any <video> load — GStreamer autoaudiosink
/// is missing on the system). SVG has no Rust decoder here, so the frontend
/// keeps loading it directly via the asset protocol.
pub fn thumb_cache_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("FILEMON_THUMB_CACHE") {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    if let Ok(dir) = std::env::var("XDG_CACHE_HOME") {
        if !dir.is_empty() {
            return PathBuf::from(dir).join("filemon/thumbs");
        }
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    PathBuf::from(home).join(".cache/filemon/thumbs")
}

fn thumb_key(path: &Path, size: u64, mtime: u64) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    path.to_string_lossy().hash(&mut h);
    size.hash(&mut h);
    mtime.hash(&mut h);
    format!("{:016x}", h.finish())
}

pub fn thumb(path: &Path) -> Result<String, String> {
    let md = fs::metadata(path).map_err(|e| e.to_string())?;
    let mtime = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let key = thumb_key(path, md.len(), mtime);
    let cache = thumb_cache_dir().join(format!("{key}.png"));
    if let Ok(cached) = fs::metadata(&cache) {
        if let Ok(ctime) = cached.modified() {
            if ctime >= md.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH) {
                if let Ok(bytes) = fs::read(&cache) {
                    if !bytes.is_empty() {
                        return Ok(base64_encode(&bytes));
                    }
                }
            }
        }
    }
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let png: Vec<u8> = if matches!(ext.as_str(), "mp4" | "mkv" | "webm" | "mov" | "avi") {
        let out = std::process::Command::new("timeout")
            .args(["10", "ffmpeg", "-v", "error", "-ss", "0.5", "-i"])
            .arg(path)
            .args(["-frames:v", "1", "-vf", "scale=320:-1", "-f", "image2pipe", "-vcodec", "png", "-"])
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() || out.stdout.is_empty() {
            let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(if msg.is_empty() { "ffmpeg failed".to_string() } else { msg });
        }
        out.stdout
    } else {
        let img = image::open(path).map_err(|e| e.to_string())?;
        let small = img.thumbnail(320, 320);
        let mut bytes = Vec::new();
        small
            .write_to(&mut std::io::Cursor::new(&mut bytes), image::ImageFormat::Png)
            .map_err(|e| e.to_string())?;
        bytes
    };
    // Best effort: a failed cache write still returns the thumbnail.
    let _ = fs::create_dir_all(thumb_cache_dir());
    let _ = fs::write(&cache, &png);
    Ok(base64_encode(&png))
}

fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        s.push(ALPHABET[(n >> 18) as usize & 63] as char);
        s.push(ALPHABET[(n >> 12) as usize & 63] as char);
        s.push(if chunk.len() > 1 { ALPHABET[(n >> 6) as usize & 63] as char } else { '=' });
        s.push(if chunk.len() > 2 { ALPHABET[n as usize & 63] as char } else { '=' });
    }
    s
}

pub fn open_path(path: &Path) -> Result<(), String> {
    std::process::Command::new("xdg-open")
        .arg(path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Does this path exist? Used to prune Quick-access pins whose folder is gone.
pub fn path_exists(path: &Path) -> bool {
    path.exists()
}

// ---- Folder sizes ----
// One generation per folder_sizes request; a newer request makes older walks
// give up, so fast navigation through big folders does not pile up work.
pub static FOLDER_SIZE_GEN: AtomicU64 = AtomicU64::new(0);

/// Recursive size of a folder: the sum of all file sizes under it.
/// Symlinks are not followed at all — a link back to a parent would loop
/// forever and a link to a sibling would double-count its files. Unreadable
/// subdirectories are skipped. `gen`/`want` abort the walk when a newer
/// request supersedes this one (checked every 1024 entries).
pub fn folder_size(path: &Path, gen: &AtomicU64, want: u64) -> Result<u64, String> {
    let mut total: u64 = 0;
    let mut stack: Vec<PathBuf> = vec![path.to_path_buf()];
    let mut checked: u64 = 0;
    while let Some(dir) = stack.pop() {
        let rd = match fs::read_dir(&dir) {
            Ok(rd) => rd,
            Err(_) => continue,
        };
        for entry in rd.flatten() {
            checked += 1;
            if checked % 1024 == 0 && gen.load(Ordering::Relaxed) != want {
                return Err("cancelled".to_string());
            }
            let ft = match entry.file_type() {
                Ok(ft) => ft,
                Err(_) => continue,
            };
            if ft.is_symlink() {
                continue;
            }
            if ft.is_dir() {
                stack.push(entry.path());
            } else if let Ok(md) = entry.metadata() {
                total = total.saturating_add(md.len());
            }
        }
    }
    Ok(total)
}

#[derive(Debug, Clone, Serialize)]
pub struct SpaceChild {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub file_count: u64,
    pub dir_count: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiskUsageReport {
    pub path: String,
    pub name: String,
    pub total_size: u64,
    pub total_files: u64,
    pub total_dirs: u64,
    pub items: Vec<SpaceChild>,
}

pub static ANALYZE_GEN: AtomicU64 = AtomicU64::new(0);

pub fn cancel_analyze_space() {
    ANALYZE_GEN.fetch_add(1, Ordering::SeqCst);
}

pub fn analyze_space(root: &Path) -> Result<DiskUsageReport, String> {
    let gen = ANALYZE_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let rd = fs::read_dir(root).map_err(|e| format!("Cannot read {}: {}", root.display(), e))?;

    let root_name = root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| root.to_string_lossy().into_owned());

    let mut items = Vec::new();
    let mut total_size: u64 = 0;
    let mut total_files: u64 = 0;
    let mut total_dirs: u64 = 0;

    for entry in rd.flatten() {
        if ANALYZE_GEN.load(Ordering::Relaxed) != gen {
            return Err("cancelled".to_string());
        }
        let p = entry.path();
        let ft = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        if ft.is_symlink() {
            continue;
        }

        let name = entry.file_name().to_string_lossy().into_owned();

        if ft.is_dir() {
            let mut dir_size: u64 = 0;
            let mut files_in_dir: u64 = 0;
            let mut dirs_in_dir: u64 = 0;
            let mut stack = vec![p.clone()];
            let mut checked: u64 = 0;

            while let Some(current_dir) = stack.pop() {
                let sub_rd = match fs::read_dir(&current_dir) {
                    Ok(r) => r,
                    Err(_) => continue,
                };
                for sub_entry in sub_rd.flatten() {
                    checked += 1;
                    if checked % 512 == 0 && ANALYZE_GEN.load(Ordering::Relaxed) != gen {
                        return Err("cancelled".to_string());
                    }
                    let sub_ft = match sub_entry.file_type() {
                        Ok(t) => t,
                        Err(_) => continue,
                    };
                    if sub_ft.is_symlink() {
                        continue;
                    }
                    if sub_ft.is_dir() {
                        dirs_in_dir += 1;
                        stack.push(sub_entry.path());
                    } else if let Ok(md) = sub_entry.metadata() {
                        files_in_dir += 1;
                        dir_size = dir_size.saturating_add(md.len());
                    }
                }
            }

            total_size = total_size.saturating_add(dir_size);
            total_files += files_in_dir;
            total_dirs += dirs_in_dir + 1;

            items.push(SpaceChild {
                name,
                path: p.to_string_lossy().into_owned(),
                is_dir: true,
                size: dir_size,
                file_count: files_in_dir,
                dir_count: dirs_in_dir,
            });
        } else if let Ok(md) = entry.metadata() {
            let file_size = md.len();
            total_size = total_size.saturating_add(file_size);
            total_files += 1;

            items.push(SpaceChild {
                name,
                path: p.to_string_lossy().into_owned(),
                is_dir: false,
                size: file_size,
                file_count: 1,
                dir_count: 0,
            });
        }
    }

    items.sort_by(|a, b| b.size.cmp(&a.size).then_with(|| a.name.cmp(&b.name)));

    Ok(DiskUsageReport {
        path: root.to_string_lossy().into_owned(),
        name: root_name,
        total_size,
        total_files,
        total_dirs,
        items,
    })
}

// ---- Open in Terminal ----
// Terminals are tried in order; every one of them starts its shell in the
// inherited working directory, so no per-terminal --working-directory flag
// is needed (and a wrong flag would break the launch outright).

const TERMINAL_CANDIDATES: &[&str] = &[
    "foot",
    "alacritty",
    "kitty",
    "wezterm",
    "ghostty",
    "gnome-terminal",
    "konsole",
    "xfce4-terminal",
    "ptyxis",
    "blackbox",
    "xterm",
];

/// Resolve (binary, extra args) for the terminal to launch. Pure over its
/// inputs so tests can pass a fake PATH without touching the environment.
/// $TERMINAL wins when set (it may carry its own args: "foot --app-id x").
fn find_terminal_in(path_var: &str, terminal_var: Option<&str>) -> Option<(String, Vec<String>)> {
    if let Some(t) = terminal_var {
        let mut parts = t.split_whitespace();
        if let Some(bin) = parts.next() {
            return Some((bin.to_string(), parts.map(|s| s.to_string()).collect()));
        }
    }
    for dir in path_var.split(':') {
        if dir.is_empty() {
            continue;
        }
        for name in TERMINAL_CANDIDATES {
            let p = Path::new(dir).join(name);
            if p.is_file() {
                return Some((name.to_string(), Vec::new()));
            }
        }
    }
    None
}

fn find_terminal() -> Option<(String, Vec<String>)> {
    let path_var = std::env::var("PATH").unwrap_or_default();
    let terminal_var = std::env::var("TERMINAL").ok();
    find_terminal_in(&path_var, terminal_var.as_deref())
}

/// Open a terminal emulator with its working directory at `path`. The child
/// is detached (its own process group, null stdio) so it outlives FileMon
/// and never inherits its pipes.
pub fn open_terminal(path: &Path) -> Result<(), String> {
    if !path.is_dir() {
        return Err(format!("Not a folder: {}", path.display()));
    }
    let (bin, args) = find_terminal().ok_or_else(|| {
        "No terminal found (tried $TERMINAL, then foot, alacritty, kitty, wezterm, ghostty, gnome-terminal, konsole, xfce4-terminal, ptyxis, blackbox, xterm)".to_string()
    })?;
    use std::os::unix::process::CommandExt;
    std::process::Command::new(&bin)
        .args(&args)
        .current_dir(path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .process_group(0)
        .spawn()
        .map_err(|e| format!("Could not launch {}: {}", bin, e))?;
    Ok(())
}

// ---- Open With ----
// GUI applications from the freedesktop .desktop files, matched to a file
// by MIME type, launched with the file substituted into their Exec line.

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub struct AppInfo {
    pub name: String,
    pub exec: String,
    pub mime_types: Vec<String>,
    /// The .desktop file name, e.g. "org.gnome.TextEditor.desktop" —
    /// what xdg-mime needs to set a default application.
    pub desktop: String,
}

/// Parse one .desktop file's [Desktop Entry] section. None for hidden
/// entries, entries without a usable Name/Exec, or terminal apps (those
/// belong to Open in Terminal, not Open With).
fn parse_desktop_file(path: &Path) -> Option<AppInfo> {
    let text = fs::read_to_string(path).ok()?;
    let mut name: Option<String> = None;
    let mut exec: Option<String> = None;
    let mut mime_types: Vec<String> = Vec::new();
    let mut hidden = false;
    let mut terminal = false;
    let mut in_entry = false;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_entry = line == "[Desktop Entry]";
            continue;
        }
        if !in_entry || line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        match k {
            "Name" => name = Some(v.trim().to_string()),
            "Exec" => exec = Some(v.trim().to_string()),
            "MimeType" => {
                mime_types = v
                    .split(';')
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string())
                    .collect();
            }
            "NoDisplay" => hidden = hidden || v.trim() == "true",
            "Hidden" => hidden = hidden || v.trim() == "true",
            "Terminal" => terminal = terminal || v.trim() == "true",
            _ => {}
        }
    }
    if hidden || terminal {
        return None;
    }
    let (name, exec) = (name?, exec?);
    if name.is_empty() || exec.is_empty() {
        return None;
    }
    let desktop = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    Some(AppInfo {
        name,
        exec,
        mime_types,
        desktop,
    })
}

/// Set the default application for a file's type (xdg-mime). The desktop id
/// must be a bare .desktop file name, never a path.
pub fn set_default_app(path: &Path, desktop: &str) -> Result<(), String> {
    if !desktop.ends_with(".desktop") || desktop.contains('/') || desktop.contains("..") {
        return Err("not a .desktop file name".to_string());
    }
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mime = mime_for_extension(&ext);
    let out = std::process::Command::new("xdg-mime")
        .args(["default", desktop, mime])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
}

fn parse_desktop_dir(dir: &Path) -> Vec<AppInfo> {
    let mut out = Vec::new();
    let Ok(rd) = fs::read_dir(dir) else {
        return out;
    };
    for item in rd.flatten() {
        let p = item.path();
        if p.extension().is_some_and(|e| e == "desktop") {
            if let Some(app) = parse_desktop_file(&p) {
                out.push(app);
            }
        }
    }
    out
}

/// All GUI applications from the freedesktop application directories.
/// Duplicates (same desktop file in two dirs) are kept once, first dir wins.
pub fn list_applications() -> Vec<AppInfo> {
    let mut dirs = vec![
        PathBuf::from("/usr/share/applications"),
        PathBuf::from("/usr/local/share/applications"),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        dirs.push(PathBuf::from(home).join(".local/share/applications"));
    }
    let mut out: Vec<AppInfo> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for dir in dirs {
        for app in parse_desktop_dir(&dir) {
            if seen.insert(app.name.clone()) {
                out.push(app);
            }
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

/// Best-effort MIME type for a file extension (used only to match apps).
pub fn mime_for_extension(ext: &str) -> &'static str {
    match ext.to_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "mp4" => "video/mp4",
        "mkv" => "video/x-matroska",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "avi" => "video/x-msvideo",
        "mp3" => "audio/mpeg",
        "flac" => "audio/flac",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "m4a" => "audio/mp4",
        "pdf" => "application/pdf",
        "txt" | "log" => "text/plain",
        "md" => "text/markdown",
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "json" => "application/json",
        "csv" => "text/csv",
        "xml" => "application/xml",
        "zip" => "application/zip",
        "tar" => "application/x-tar",
        "gz" => "application/gzip",
        "7z" => "application/x-7z-compressed",
        "deb" => "application/vnd.debian.binary-package",
        "rpm" => "application/x-rpm",
        _ => "application/octet-stream",
    }
}

fn apps_for_mime(apps: Vec<AppInfo>, mime: &str) -> Vec<AppInfo> {
    apps.into_iter()
        .filter(|a| a.mime_types.iter().any(|m| m == mime))
        .collect()
}

/// Applications that declare they handle this file's type, name-sorted.
pub fn apps_for_path(path: &Path) -> Vec<AppInfo> {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().into_owned())
        .unwrap_or_default();
    apps_for_mime(list_applications(), mime_for_extension(&ext))
}

/// Split an Exec line into argv, honouring single/double quotes. Field
/// codes (%f, %F, %u, %U) are replaced with the file path; the rest
/// (%i, %c, %k, …) are dropped, as the spec prescribes. With no field code
/// at all the file is appended, so the app still gets it.
fn exec_argv(exec: &str, path: &Path) -> Vec<String> {
    let mut argv: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut in_token = false;
    let mut quote: Option<char> = None;
    let mut substituted = false;
    let mut chars = exec.chars().peekable();
    while let Some(c) = chars.next() {
        match quote {
            Some(q) => {
                if c == q {
                    quote = None;
                } else {
                    cur.push(c);
                }
            }
            None => match c {
                '\'' | '"' => {
                    quote = Some(c);
                    in_token = true;
                }
                ' ' | '\t' => {
                    if in_token {
                        argv.push(std::mem::take(&mut cur));
                        in_token = false;
                    }
                }
                '%' => {
                    if let Some(&code) = chars.peek() {
                        chars.next();
                        match code {
                            'f' | 'F' | 'u' | 'U' => {
                                cur.push_str(&path.to_string_lossy());
                                in_token = true;
                                substituted = true;
                            }
                            '%' => {
                                cur.push('%');
                                in_token = true;
                            }
                            _ => {}
                        }
                    }
                }
                _ => {
                    cur.push(c);
                    in_token = true;
                }
            },
        }
    }
    if in_token {
        argv.push(cur);
    }
    if !substituted {
        argv.push(path.to_string_lossy().into_owned());
    }
    argv
}

/// Launch `path` with the given Exec line. Detached, like open_terminal.
pub fn open_with(path: &Path, exec: &str) -> Result<(), String> {
    let argv = exec_argv(exec, path);
    let Some((bin, args)) = argv.split_first() else {
        return Err("Empty Exec line".to_string());
    };
    use std::os::unix::process::CommandExt;
    std::process::Command::new(bin)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .process_group(0)
        .spawn()
        .map_err(|e| format!("Could not launch {}: {}", bin, e))?;
    Ok(())
}

/// Human size: 0 B, 1.5 KB, 2.0 MB, 3.4 GB. Binary units, one decimal.
pub fn format_size(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    if bytes < 1024 {
        return format!("{} B", bytes);
    }
    let mut v = bytes as f64;
    let mut i = 0;
    while v >= 1024.0 && i < UNITS.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    format!("{:.1} {}", v, UNITS[i])
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct GitRepoInfo {
    pub root: String,
    pub branch: String,
    pub is_clean: bool,
    pub ahead: u32,
    pub behind: u32,
    pub statuses: std::collections::HashMap<String, String>,
    pub dir_statuses: std::collections::HashMap<String, String>,
}

/// Query Git status for a folder: branch name, sync counts (ahead/behind),
/// and working-tree change statuses per file and directory.
/// Returns None if the folder is not within a Git repository or git fails.
pub fn get_git_info(folder: &Path) -> Option<GitRepoInfo> {
    let mut repo_root: Option<PathBuf> = None;
    for ancestor in folder.ancestors() {
        if ancestor.join(".git").exists() {
            repo_root = Some(ancestor.to_path_buf());
            break;
        }
    }
    let repo_root = repo_root?;

    let out = std::process::Command::new("git")
        .args(["-c", "core.quotepath=false", "status", "--porcelain=v1", "-b", "-uall"])
        .current_dir(&repo_root)
        .output()
        .ok()?;

    if !out.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut branch = String::from("HEAD");
    let mut ahead = 0u32;
    let mut behind = 0u32;
    let mut is_clean = true;
    let mut statuses = std::collections::HashMap::new();
    let mut dir_statuses = std::collections::HashMap::new();

    let mut lines = stdout.lines();
    if let Some(first_line) = lines.next() {
        if let Some(rest) = first_line.strip_prefix("## ") {
            let mut branch_part = rest;
            if let Some(bracket_start) = branch_part.find('[') {
                if let Some(bracket_end) = branch_part.find(']') {
                    let sync_info = &branch_part[bracket_start + 1..bracket_end];
                    for part in sync_info.split(',') {
                        let p = part.trim();
                        if let Some(n) = p.strip_prefix("ahead ") {
                            ahead = n.trim().parse().unwrap_or(0);
                        } else if let Some(n) = p.strip_prefix("behind ") {
                            behind = n.trim().parse().unwrap_or(0);
                        }
                    }
                }
                branch_part = branch_part[..bracket_start].trim();
            }
            if let Some(dots) = branch_part.find("...") {
                branch = branch_part[..dots].trim().to_string();
            } else {
                branch = branch_part.trim().to_string();
            }
        }
    }

    for line in lines {
        if line.len() < 3 {
            continue;
        }
        is_clean = false;
        let code = &line[0..2];
        let mut path_str = line[3..].trim();
        if let Some(arrow) = path_str.find(" -> ") {
            path_str = &path_str[arrow + 4..];
        }
        let path_clean = path_str.trim_matches('"');
        let abs_path = repo_root.join(path_clean);
        let abs_str = abs_path.to_string_lossy().to_string();

        let status_char = if code.contains('?') {
            "?"
        } else if code.contains('A') {
            "A"
        } else if code.contains('D') {
            "D"
        } else if code.contains('R') {
            "R"
        } else if code.contains('U') {
            "U"
        } else {
            "M"
        };

        statuses.insert(abs_str.clone(), status_char.to_string());

        let mut curr = abs_path.parent();
        while let Some(p) = curr {
            if p == repo_root.as_path() {
                break;
            }
            let dir_str = p.to_string_lossy().to_string();
            dir_statuses.entry(dir_str).or_insert_with(|| status_char.to_string());
            curr = p.parent();
        }
    }

    Some(GitRepoInfo {
        root: repo_root.to_string_lossy().to_string(),
        branch,
        is_clean,
        ahead,
        behind,
        statuses,
        dir_statuses,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::io::Write;

    #[test]
    fn format_size_units() {
        assert_eq!(format_size(0), "0 B");
        assert_eq!(format_size(512), "512 B");
        assert_eq!(format_size(1536), "1.5 KB");
        assert_eq!(format_size(2 * 1024 * 1024), "2.0 MB");
        assert_eq!(format_size(3 * 1024 * 1024 * 1024), "3.0 GB");
    }

    #[test]
    fn git_info_finds_current_repo() {
        let here = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let info = get_git_info(&here);
        assert!(info.is_some(), "should detect git repository for filemon");
        let info = info.unwrap();
        assert!(!info.branch.is_empty(), "branch must not be empty");
        assert!(!info.root.is_empty(), "root must not be empty");
    }

    #[test]
    fn split_name_cases() {
        assert_eq!(split_name("archive.tar.gz"), ("archive.tar", Some(".gz".into())));
        assert_eq!(split_name("README"), ("README", None));
        assert_eq!(split_name(".hidden"), (".hidden", None));
    }

    #[test]
    fn unique_name_avoids_collision() {
        let dir = std::env::temp_dir().join("filemon-test-unique");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        assert_eq!(unique_name(&dir, "a.txt"), "a.txt");
        File::create(dir.join("a.txt")).unwrap();
        assert_eq!(unique_name(&dir, "a.txt"), "a (2).txt");
        File::create(dir.join("a (2).txt")).unwrap();
        assert_eq!(unique_name(&dir, "a.txt"), "a (3).txt");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn validate_names() {
        assert!(validate_new_name("ok name").is_ok());
        assert!(validate_new_name("").is_err());
        assert!(validate_new_name("a/b").is_err());
        assert!(validate_new_name("..").is_err());
    }

    #[test]
    fn copy_move_and_search_roundtrip() {
        let base = std::env::temp_dir().join("filemon-test-ops");
        let _ = fs::remove_dir_all(&base);
        let src = base.join("src");
        let dst = base.join("dst");
        fs::create_dir_all(&src).unwrap();
        fs::create_dir_all(&dst).unwrap();
        let mut f = File::create(src.join("hello.txt")).unwrap();
        f.write_all(b"hi").unwrap();
        fs::create_dir(src.join("sub")).unwrap();
        File::create(src.join("sub/nested.md")).unwrap();

        assert_eq!(copy_paths(&[src.join("hello.txt")], &dst).unwrap(), 1);
        assert!(dst.join("hello.txt").exists());
        // Copy again: must not overwrite, gets a (copy) name.
        assert_eq!(copy_paths(&[src.join("hello.txt")], &dst).unwrap(), 1);
        assert!(dst.join("hello (copy).txt").exists());

        let hits = search(&base, "nested", 10);
        assert_eq!(hits.len(), 1);
        assert!(hits[0].path.ends_with("nested.md"));

        assert_eq!(move_paths(&[dst.join("hello.txt")], &src).unwrap(), 1);
        assert!(src.join("hello.txt").exists());
        assert!(!dst.join("hello.txt").exists());

        let listed = list_dir(&src).unwrap();
        assert!(listed.iter().any(|e| e.name == "sub" && e.is_dir));
        let props = properties(&src.join("hello.txt")).unwrap();
        assert_eq!(props.size, 2);
        assert_eq!(props.kind, "Text file");
        let _ = fs::remove_dir_all(&base);
    }


    #[test]
    fn find_terminal_probe_order() {
        let base = std::env::temp_dir().join("filemon-test-term");
        let _ = fs::remove_dir_all(&base);
        let bin = base.join("bin");
        fs::create_dir_all(&bin).unwrap();
        // Only kitty exists: it is picked. Add foot later: foot wins (first).
        File::create(bin.join("kitty")).unwrap();
        assert_eq!(
            find_terminal_in(&bin.to_string_lossy(), None),
            Some(("kitty".to_string(), vec![]))
        );
        File::create(bin.join("foot")).unwrap();
        assert_eq!(
            find_terminal_in(&bin.to_string_lossy(), None),
            Some(("foot".to_string(), vec![]))
        );
        // $TERMINAL wins over everything on PATH, args split out.
        assert_eq!(
            find_terminal_in(&bin.to_string_lossy(), Some("myterm --app-id x")),
            Some(("myterm".to_string(), vec!["--app-id".to_string(), "x".to_string()]))
        );
        // Nothing on PATH, no $TERMINAL: no terminal.
        let empty = base.join("empty");
        fs::create_dir_all(&empty).unwrap();
        assert_eq!(find_terminal_in(&empty.to_string_lossy(), None), None);
        let _ = fs::remove_dir_all(&base);
    }


    #[test]
    fn open_terminal_rejects_missing_dir() {
        let err = open_terminal(Path::new("/definitely/not/a/real/folder")).unwrap_err();
        assert!(err.contains("Not a folder"), "unexpected error: {}", err);
    }

    #[test]
    fn path_exists_roundtrip() {
        let base = std::env::temp_dir().join("filemon-test-exists");
        let _ = fs::remove_dir_all(&base);
        assert!(!path_exists(&base));
        fs::create_dir_all(&base).unwrap();
        assert!(path_exists(&base));
        assert!(!path_exists(&base.join("nope")));
        let _ = fs::remove_dir_all(&base);
    }


    #[test]
    fn folder_size_sums_nested_tree() {
        let base = std::env::temp_dir().join("filemon-test-fsize");
        let _ = fs::remove_dir_all(&base);
        let sub = base.join("sub");
        fs::create_dir_all(sub.join("empty")).unwrap();
        fs::write(base.join("a.txt"), vec![0u8; 10]).unwrap();
        fs::write(sub.join("b.txt"), vec![0u8; 20]).unwrap();
        let gen = AtomicU64::new(0);
        assert_eq!(folder_size(&base, &gen, 0).unwrap(), 30);
        assert_eq!(folder_size(&sub, &gen, 0).unwrap(), 20);
        assert_eq!(folder_size(&sub.join("empty"), &gen, 0).unwrap(), 0);
        assert!(folder_size(&base.join("nope"), &gen, 0).is_ok());
        // A symlink back to the parent must not loop or double-count.
        std::os::unix::fs::symlink(&base, sub.join("loop")).unwrap();
        assert_eq!(folder_size(&base, &gen, 0).unwrap(), 30);
        let _ = fs::remove_dir_all(&base);
    }


    #[test]
    fn folder_size_cancel_stops_a_big_walk() {
        let base = std::env::temp_dir().join("filemon-test-fsize-cancel");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        for i in 0..1100 {
            fs::write(base.join(format!("f{}.txt", i)), b"x").unwrap();
        }
        // The generation already moved on before the walk starts.
        let gen = AtomicU64::new(1);
        let err = folder_size(&base, &gen, 0).unwrap_err();
        assert_eq!(err, "cancelled");
        let _ = fs::remove_dir_all(&base);
    }


    #[test]
    fn trashinfo_encoding() {
        assert_eq!(
            url_encode_path(Path::new("/home/zyan/My File.txt")),
            "/home/zyan/My%20File.txt"
        );
        // Round trip: the reader must decode what the writer encoded.
        assert_eq!(
            url_decode_path("/home/zyan/My%20File.txt"),
            "/home/zyan/My File.txt"
        );
        assert_eq!(
            parse_trashinfo("[Trash Info]\nPath=/home/zyan/My%20File.txt\nDeletionDate=2026-11-11T19:00:00\n")
                .map(|(p, _)| p),
            Some("/home/zyan/My File.txt".to_string())
        );
    }

    fn seed_trash(
        files_dir: &Path,
        info_dir: &Path,
        orig: &Path,
        name: &str,
        date: &str,
        contents: &[u8],
    ) {
        fs::write(files_dir.join(name), contents).unwrap();
        fs::write(
            info_dir.join(format!("{}.trashinfo", name)),
            format!(
                "[Trash Info]\nPath={}\nDeletionDate={}\n",
                url_encode_path(orig),
                date
            ),
        )
        .unwrap();
    }

    #[test]
    fn trash_list_restore_delete_empty() {
        let base = std::env::temp_dir().join("filemon-test-trash");
        let _ = fs::remove_dir_all(&base);
        let home = base.join("home");
        let files_dir = base.join("Trash/files");
        let info_dir = base.join("Trash/info");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&files_dir).unwrap();
        fs::create_dir_all(&info_dir).unwrap();

        // Two trashed items: a file with a space in its name (decode check)
        // and a folder. The file was deleted later, so it lists first.
        seed_trash(
            &files_dir,
            &info_dir,
            &home.join("my file.txt"),
            "my file.txt",
            "2026-11-11T20:00:00",
            b"hello",
        );
        fs::create_dir(files_dir.join("tree")).unwrap();
        fs::write(files_dir.join("tree/a.txt"), b"a").unwrap();
        fs::write(
            info_dir.join("tree.trashinfo"),
            format!(
                "[Trash Info]\nPath={}\nDeletionDate=2026-11-11T19:00:00\n",
                url_encode_path(&home.join("tree"))
            ),
        )
        .unwrap();

        let listed = list_trash_in(&files_dir, &info_dir);
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].name, "my file.txt");
        assert_eq!(listed[0].original_path.as_deref(), Some(home.join("my file.txt").to_str().unwrap()));
        assert!(listed[0].modified.is_some());
        assert_eq!(listed[1].name, "tree");
        assert!(listed[1].is_dir);
        assert_eq!(listed[1].size, Some(1));

        // Restore the file: it comes back with its content, info file gone.
        assert_eq!(restore_trash_in(&files_dir, &info_dir, &[files_dir.join("my file.txt")]).unwrap(), 1);
        assert_eq!(fs::read(home.join("my file.txt")).unwrap(), b"hello");
        assert!(!info_dir.join("my file.txt.trashinfo").exists());
        assert_eq!(list_trash_in(&files_dir, &info_dir).len(), 1);

        // Restore collision: a file already sits at the original spot.
        seed_trash(
            &files_dir,
            &info_dir,
            &home.join("my file.txt"),
            "my file.txt",
            "2026-11-11T21:00:00",
            b"second",
        );
        assert_eq!(restore_trash_in(&files_dir, &info_dir, &[files_dir.join("my file.txt")]).unwrap(), 1);
        assert_eq!(fs::read(home.join("my file (copy).txt")).unwrap(), b"second");
        assert_eq!(fs::read(home.join("my file.txt")).unwrap(), b"hello");

        // Permanent delete, then empty the rest.
        assert_eq!(delete_trash_in(&files_dir, &info_dir, &[files_dir.join("tree")]).unwrap(), 1);
        assert!(!files_dir.join("tree").exists());
        assert!(!info_dir.join("tree.trashinfo").exists());
        assert_eq!(list_trash_in(&files_dir, &info_dir).len(), 0);
        seed_trash(
            &files_dir,
            &info_dir,
            &home.join("gone.txt"),
            "gone.txt",
            "2026-11-11T22:00:00",
            b"x",
        );
        assert_eq!(empty_trash_in(&files_dir, &info_dir).unwrap(), 1);
        assert_eq!(list_trash_in(&files_dir, &info_dir).len(), 0);
        let _ = fs::remove_dir_all(&base);
    }


    #[test]
    fn drives_have_sizes() {
        // Guards the DiskRefreshKind::nothing() trap: mounts listed but
        // total/free left at 0, which the filter then drops entirely.
        let d = drives();
        assert!(!d.is_empty(), "no drives listed");
        assert!(d.iter().all(|x| x.total > 0), "a drive reports 0 total");
    }

    #[test]
    fn transfer_copy_reports_progress() {
        let base = std::env::temp_dir().join("filemon-test-transfer");
        let _ = fs::remove_dir_all(&base);
        let src = base.join("src");
        let dst = base.join("dst");
        fs::create_dir_all(src.join("sub")).unwrap();
        fs::create_dir_all(&dst).unwrap();
        fs::write(src.join("a.txt"), vec![b'x'; 1000]).unwrap();
        fs::write(src.join("sub").join("b.bin"), vec![b'y'; 5000]).unwrap();
        std::os::unix::fs::symlink("a.txt", src.join("link")).unwrap();
        let cancel = AtomicBool::new(false);
        let seen_total = std::cell::Cell::new(0u64);
        let seen_done = std::cell::Cell::new(0u64);
        let seen_files = std::cell::Cell::new(0usize);
        let out = transfer_files(
            &[src.clone()],
            &dst,
            true,
            &|p| {
                seen_total.set(p.total_bytes);
                seen_done.set(p.done_bytes);
                seen_files.set(p.done_files);
            },
            &cancel,
        )
        .unwrap();
        assert!(!out.cancelled);
        assert_eq!(out.done, 1);
        assert_eq!(seen_total.get(), 6000);
        assert_eq!(seen_done.get(), 6000);
        assert_eq!(seen_files.get(), 3); // a.txt + sub/b.bin + link
        assert_eq!(fs::read(dst.join("src").join("a.txt")).unwrap().len(), 1000);
        assert_eq!(
            fs::read(dst.join("src").join("sub").join("b.bin"))
                .unwrap()
                .len(),
            5000
        );
        assert!(fs::symlink_metadata(dst.join("src").join("link"))
            .unwrap()
            .file_type()
            .is_symlink());
        let _ = fs::remove_dir_all(&base);
    }


    #[test]
    fn transfer_cancel_stops_early() {
        let base = std::env::temp_dir().join("filemon-test-transfer-cancel");
        let _ = fs::remove_dir_all(&base);
        let src = base.join("src");
        let dst = base.join("dst");
        fs::create_dir_all(&src).unwrap();
        fs::create_dir_all(&dst).unwrap();
        fs::write(src.join("big.bin"), vec![0u8; 64 * 1024 * 1024]).unwrap();
        let cancel = AtomicBool::new(false);
        let out = transfer_files(
            &[src.join("big.bin")],
            &dst,
            true,
            &|p| {
                if p.done_bytes >= 8 * 1024 * 1024 {
                    cancel.store(true, Ordering::Relaxed);
                }
            },
            &cancel,
        )
        .unwrap();
        assert!(out.cancelled);
        assert_eq!(out.done, 0);
        let partial = fs::metadata(dst.join("big.bin")).unwrap().len();
        assert!(partial >= 8 * 1024 * 1024, "cancelled too early: {}", partial);
        assert!(partial < 64 * 1024 * 1024, "cancel ignored: {}", partial);
        let _ = fs::remove_dir_all(&base);
    }


    #[test]
    fn transfer_move_same_device_is_instant() {
        let base = std::env::temp_dir().join("filemon-test-transfer-move");
        let _ = fs::remove_dir_all(&base);
        let src = base.join("src");
        let dst = base.join("dst");
        fs::create_dir_all(&src).unwrap();
        fs::create_dir_all(&dst).unwrap();
        fs::write(src.join("m.txt"), vec![b'z'; 2048]).unwrap();
        let cancel = AtomicBool::new(false);
        let seen_done = std::cell::Cell::new(0u64);
        let out = transfer_files(
            &[src.join("m.txt")],
            &dst,
            false,
            &|p| seen_done.set(p.done_bytes),
            &cancel,
        )
        .unwrap();
        assert!(!out.cancelled);
        assert_eq!(out.done, 1);
        assert_eq!(seen_done.get(), 2048);
        assert!(dst.join("m.txt").exists());
        assert!(!src.join("m.txt").exists());
        let _ = fs::remove_dir_all(&base);
    }


    #[test]
    fn zip_roundtrip_restores_tree_and_symlink() {
        let base = std::env::temp_dir().join("filemon-test-zip");
        let _ = fs::remove_dir_all(&base);
        let src = base.join("tree");
        let dst = base.join("out");
        fs::create_dir_all(src.join("sub")).unwrap();
        fs::create_dir_all(&dst).unwrap();
        fs::write(src.join("a.txt"), b"hello zip").unwrap();
        fs::write(src.join("sub").join("b.bin"), vec![7u8; 300]).unwrap();
        std::os::unix::fs::symlink("a.txt", src.join("link")).unwrap();
        let name = compress_paths(&[src.clone()], &dst).unwrap();
        assert_eq!(name, "tree.zip");
        let zip_path = dst.join(&name);
        assert!(zip_path.exists());
        let folder = extract_archive(&zip_path, &dst).unwrap();
        assert_eq!(folder, "tree");
        let out = dst.join(&folder);
        assert_eq!(fs::read(out.join("a.txt")).unwrap(), b"hello zip");
        assert_eq!(fs::read(out.join("sub").join("b.bin")).unwrap().len(), 300);
        assert_eq!(
            fs::read_link(out.join("link")).unwrap().to_string_lossy(),
            "a.txt"
        );
        let _ = fs::remove_dir_all(&base);
    }


    #[test]
    fn zip_slip_entry_writes_nothing() {
        let base = std::env::temp_dir().join("filemon-test-zip-slip");
        let _ = fs::remove_dir_all(&base);
        let dst = base.join("out");
        fs::create_dir_all(&dst).unwrap();
        // Craft an archive with a traversal entry by hand.
        let zip_path = base.join("evil.zip");
        {
            let f = fs::File::create(&zip_path).unwrap();
            let mut w = zip::ZipWriter::new(f);
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            w.start_file("../evil.txt", options).unwrap();
            use std::io::Write as _;
            w.write_all(b"pwned").unwrap();
            w.finish().unwrap();
        }
        assert!(extract_archive(&zip_path, &dst).is_err());
        assert!(!base.join("evil.txt").exists());
        assert!(!dst.join("evil.txt").exists());
        let _ = fs::remove_dir_all(&base);
    }


    #[test]
    fn zip_and_extract_collision_stays_in_dest() {
        // Regression: compress/extract built the collision target from the
        // bare unique_name (a relative path), so the zip/folder landed in
        // the app's working directory instead of the destination folder.
        let base = std::env::temp_dir().join("filemon-test-zip-collision");
        let _ = fs::remove_dir_all(&base);
        let src = base.join("tree");
        let dst = base.join("out");
        fs::create_dir_all(src.join("sub")).unwrap();
        fs::create_dir_all(&dst).unwrap();
        fs::write(src.join("a.txt"), b"collision").unwrap();
        // Extract while "tree" already exists in the destination.
        fs::create_dir_all(dst.join("tree")).unwrap();
        let zip_path = base.join("tree.zip");
        {
            let name = compress_paths(&[src.clone()], &base).unwrap();
            assert_eq!(name, "tree.zip");
        }
        let folder = extract_archive(&zip_path, &dst).unwrap();
        assert_eq!(folder, "tree (copy)");
        assert_eq!(
            fs::read(dst.join("tree (copy)").join("a.txt")).unwrap(),
            b"collision"
        );
        assert!(!std::env::current_dir().unwrap().join("tree (copy)").exists());
        // Compress while "a.txt.zip" already exists in the destination.
        fs::write(dst.join("a.txt"), b"x").unwrap();
        fs::write(dst.join("a.txt.zip"), b"old").unwrap();
        let name = compress_paths(&[dst.join("a.txt")], &dst).unwrap();
        assert_eq!(name, "a.txt (copy).zip");
        assert!(dst.join("a.txt (copy).zip").exists());
        assert!(!std::env::current_dir()
            .unwrap()
            .join("a.txt (copy).zip")
            .exists());
        let _ = fs::remove_dir_all(&base);
    }


    #[test]
    fn desktop_parse_and_exec_substitution() {
        let dir = std::env::temp_dir().join("filemon-test-apps");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("a.desktop"),
            "[Desktop Entry]\nName=Alpha\nExec=alpha --opt %f\nMimeType=image/png;image/jpeg;\n",
        )
        .unwrap();
        fs::write(
            dir.join("b.desktop"),
            "[Desktop Entry]\nName=Hidden One\nExec=hidden\nNoDisplay=true\n",
        )
        .unwrap();
        fs::write(
            dir.join("c.desktop"),
            "[Desktop Entry]\nName=Term\nExec=term\nTerminal=true\n",
        )
        .unwrap();
        fs::write(dir.join("d.txt"), "not a desktop file").unwrap();
        let apps = parse_desktop_dir(&dir);
        assert_eq!(apps.len(), 1);
        assert_eq!(apps[0].name, "Alpha");
        assert_eq!(apps[0].mime_types, vec!["image/png", "image/jpeg"]);
        assert_eq!(
            apps_for_mime(apps.clone(), "image/png").len(),
            1,
            "png matches"
        );
        assert_eq!(
            apps_for_mime(apps, "video/mp4").len(),
            0,
            "mp4 does not match"
        );
        let p = Path::new("/tmp/pic.png");
        assert_eq!(
            exec_argv("alpha --opt %f", p),
            vec!["alpha", "--opt", "/tmp/pic.png"]
        );
        // Unknown field codes are dropped; a bare % is kept as %.
        assert_eq!(
            exec_argv("app %i %c %f %%", p),
            vec!["app", "/tmp/pic.png", "%"]
        );
        // No field code: the file is appended.
        assert_eq!(exec_argv("app --flag", p), vec!["app", "--flag", "/tmp/pic.png"]);
        // Quoted args stay together.
        assert_eq!(
            exec_argv("app \"a b\" %f", p),
            vec!["app", "a b", "/tmp/pic.png"]
        );
        assert_eq!(mime_for_extension("png"), "image/png");
        assert_eq!(mime_for_extension("PNG"), "image/png");
        assert_eq!(mime_for_extension("zzz"), "application/octet-stream");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn archive_listing_sha256_and_permissions() {
        use std::io::Write as _;
        let base = std::env::temp_dir().join("filemon-test-archive");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        // A zip with two files, built with the zip crate itself.
        let zip_path = base.join("a.zip");
        {
            let file = fs::File::create(&zip_path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let opts = zip::write::SimpleFileOptions::default();
            zip.start_file("one.txt", opts).unwrap();
            zip.write_all(b"one").unwrap();
            zip.start_file("sub/two.txt", opts).unwrap();
            zip.write_all(b"two!").unwrap();
            zip.finish().unwrap();
        }
        let entries = list_archive(&zip_path).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].name, "one.txt");
        assert_eq!(entries[0].size, Some(3));
        assert!(!entries[0].is_dir);
        assert_eq!(entries[1].name, "sub/two.txt");
        // A tar built by the system tar.
        let tar_path = base.join("b.tar");
        fs::write(base.join("t.txt"), "tar me\n").unwrap();
        let status = std::process::Command::new("tar")
            .args(["-cf"])
            .arg(&tar_path)
            .args(["-C"])
            .arg(&base)
            .arg("t.txt")
            .status();
        if let Ok(s) = status {
            assert!(s.success());
            let entries = list_archive(&tar_path).unwrap();
            assert_eq!(entries.len(), 1);
            assert_eq!(entries[0].name, "t.txt");
            assert!(entries[0].size.is_none(), "tar listing has no sizes");
        }
        // Error paths: missing file, plain text, plain .gz.
        assert!(list_archive(&base.join("nope.zip")).is_err());
        fs::write(base.join("c.txt"), "not an archive\n").unwrap();
        assert!(list_archive(&base.join("c.txt")).is_err());
        // SHA-256: deterministic, content-sensitive, missing file errors.
        let f = base.join("h.txt");
        fs::write(&f, "hello\n").unwrap();
        let h1 = file_sha256(&f).unwrap();
        let h2 = file_sha256(&f).unwrap();
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 64);
        assert!(h1.chars().all(|c| c.is_ascii_hexdigit()));
        fs::write(&f, "hello?\n").unwrap();
        assert_ne!(file_sha256(&f).unwrap(), h1);
        assert!(file_sha256(&base.join("nope.txt")).is_err());
        // Permissions: set 0o640 and read it back; out-of-range errors.
        use std::os::unix::fs::PermissionsExt;
        let mode = set_permissions(&f, 0o640).unwrap();
        assert_eq!(mode, "640");
        assert_eq!(fs::metadata(&f).unwrap().permissions().mode() & 0o777, 0o640);
        assert!(set_permissions(&f, 0o10000).is_err());
        let _ = fs::remove_dir_all(&base);
    }


    #[test]
    fn thumb_disk_cache() {
        let cache = std::env::temp_dir().join("filemon-test-thumbcache");
        let _ = fs::remove_dir_all(&cache);
        std::env::set_var("FILEMON_THUMB_CACHE", &cache);
        let base = std::env::temp_dir().join("filemon-test-thumb");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        // A real 8x4 PNG, built with the image crate.
        let png_path = base.join("a.png");
        let img = image::RgbImage::from_fn(8, 4, |x, _| image::Rgb([(x * 32) as u8, 0, 0]));
        img.save(&png_path).unwrap();
        // First call generates + writes the cache; second call hits it.
        let first = thumb(&png_path).unwrap();
        assert!(first.starts_with("iVBOR"), "PNG base64");
        assert_eq!(thumb_cache_dir().read_dir().unwrap().count(), 1, "one cached file");
        let second = thumb(&png_path).unwrap();
        assert_eq!(first, second, "cache hit returns identical bytes");
        // Editing the source invalidates the cache (mtime moves).
        std::thread::sleep(std::time::Duration::from_millis(1100));
        let img2 = image::RgbImage::from_fn(8, 4, |_, _| image::Rgb([0, 200, 0]));
        img2.save(&png_path).unwrap();
        let third = thumb(&png_path).unwrap();
        assert_ne!(first, third, "edited source re-renders");
        // Error paths: missing file, text file, garbage video.
        assert!(thumb(&base.join("nope.png")).is_err());
        fs::write(base.join("t.txt"), "not an image\n").unwrap();
        assert!(thumb(&base.join("t.txt")).is_err());
        fs::write(base.join("v.mp4"), b"garbage, not a video").unwrap();
        assert!(thumb(&base.join("v.mp4")).is_err());
        std::env::remove_var("FILEMON_THUMB_CACHE");
        let _ = fs::remove_dir_all(&base);
        let _ = fs::remove_dir_all(&cache);
    }

    #[test]
    fn compare_dirs_matches_names() {
        let base = std::env::temp_dir().join("filemon-test-compare");
        let _ = fs::remove_dir_all(&base);
        let a = base.join("a");
        let b = base.join("b");
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        // Same content, same name: same.
        fs::write(a.join("same.txt"), "identical\n").unwrap();
        fs::write(b.join("same.txt"), "identical\n").unwrap();
        // Same name, different content: different.
        fs::write(a.join("changed.txt"), "aaa\n").unwrap();
        fs::write(b.join("changed.txt"), "bbb\n").unwrap();
        // Same name, different size: different (no hash needed).
        fs::write(a.join("bigger.txt"), "short\n").unwrap();
        fs::write(b.join("bigger.txt"), "much longer content\n").unwrap();
        // Only in a / only in b.
        fs::write(a.join("only-a.txt"), "a\n").unwrap();
        fs::write(b.join("only-b.txt"), "b\n").unwrap();
        // Same-name folders count as same (no recursion).
        fs::create_dir(a.join("sub")).unwrap();
        fs::create_dir(b.join("sub")).unwrap();
        // Hidden file: excluded unless include_hidden.
        fs::write(a.join(".hidden"), "h\n").unwrap();
        let res = compare_dirs(&a, &b, false).unwrap();
        assert_eq!(res.only_a.len(), 1);
        assert_eq!(res.only_a[0].name, "only-a.txt");
        assert_eq!(res.only_b.len(), 1);
        assert_eq!(res.only_b[0].name, "only-b.txt");
        assert_eq!(res.different.len(), 2);
        assert_eq!(res.same, 2, "same.txt + sub");
        let res = compare_dirs(&a, &b, true).unwrap();
        assert_eq!(res.only_a.len(), 2, "hidden file appears with include_hidden");
        // Missing folder errors.
        assert!(compare_dirs(&base.join("nope"), &b, false).is_err());
        let _ = fs::remove_dir_all(&base);
    }


    #[test]
    fn content_search_and_duplicates() {
        let base = std::env::temp_dir().join("filemon-test-content");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("sub")).unwrap();
        fs::write(base.join("a.txt"), "hello world\nsecond line\n").unwrap();
        fs::write(base.join("b.txt"), "nothing here\n").unwrap();
        fs::write(base.join("sub/c.md"), "HELLO again\n").unwrap();
        // Binary file containing the query must be skipped.
        let mut bin = File::create(base.join("bin.dat")).unwrap();
        bin.write_all(b"\x00\x01hello\x00\x02").unwrap();
        // Duplicate pair + a same-size different file.
        fs::write(base.join("dup1.txt"), "same content").unwrap();
        fs::write(base.join("dup2.txt"), "same content").unwrap();
        fs::write(base.join("diff.txt"), "same contenX").unwrap();
        fs::write(base.join("empty.txt"), b"").unwrap();

        let hits = search_content(&base, "hello", 10);
        assert_eq!(hits.len(), 2, "a.txt + sub/c.md, binary skipped");
        assert!(hits.iter().any(|h| h.entry.name == "a.txt" && h.line == 1));
        assert!(hits.iter().any(|h| h.entry.name == "c.md" && h.line == 1));
        assert!(hits.iter().all(|h| !h.snippet.contains('\u{0}')));
        let hits_ci = search_content(&base, "HELLO", 10);
        assert_eq!(hits_ci.len(), 2, "case-insensitive");

        let groups = find_duplicates(&base);
        assert_eq!(groups.len(), 1, "only the identical pair");
        assert_eq!(groups[0].entries.len(), 2);
        assert!(groups[0].entries.iter().any(|e| e.name == "dup1.txt"));
        assert!(groups[0].entries.iter().any(|e| e.name == "dup2.txt"));
        assert_eq!(groups[0].size, 12);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn get_entries_returns_metadata() {
        let base = std::env::temp_dir().join("filemon-test-get-entries");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        let f1 = base.join("test1.txt");
        let f2 = base.join("test2.md");
        fs::write(&f1, "hello").unwrap();
        fs::write(&f2, "world!!").unwrap();

        let entries = get_entries(&[
            f1.to_string_lossy().to_string(),
            f2.to_string_lossy().to_string(),
            base.join("nonexistent.txt").to_string_lossy().to_string(),
        ]);
        assert_eq!(entries.len(), 2);
        assert!(entries.iter().any(|e| e.name == "test1.txt" && e.size == Some(5)));
        assert!(entries.iter().any(|e| e.name == "test2.md" && e.size == Some(7)));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn analyze_space_calculates_recursive_usage() {
        let base = std::env::temp_dir().join("filemon-test-analyze-space");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("dir_a/nested")).unwrap();
        fs::create_dir_all(base.join("dir_b")).unwrap();
        fs::write(base.join("dir_a/file1.txt"), "12345").unwrap(); // 5 bytes
        fs::write(base.join("dir_a/nested/file2.bin"), "1234567890").unwrap(); // 10 bytes -> dir_a = 15 bytes
        fs::write(base.join("dir_b/small.txt"), "ab").unwrap(); // 2 bytes -> dir_b = 2 bytes
        fs::write(base.join("root_file.md"), "hello!").unwrap(); // 6 bytes

        let rep = analyze_space(&base).unwrap();
        assert_eq!(rep.total_size, 23);
        assert_eq!(rep.total_files, 4);
        assert_eq!(rep.items.len(), 3);
        // Largest first: dir_a (15), root_file.md (6), dir_b (2)
        assert_eq!(rep.items[0].name, "dir_a");
        assert_eq!(rep.items[0].size, 15);
        assert_eq!(rep.items[0].file_count, 2);
        assert_eq!(rep.items[1].name, "root_file.md");
        assert_eq!(rep.items[1].size, 6);
        assert_eq!(rep.items[2].name, "dir_b");
        assert_eq!(rep.items[2].size, 2);
        let _ = fs::remove_dir_all(&base);
    }
}
