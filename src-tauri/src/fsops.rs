//! Filesystem operations for FileMon: listing, search, copy/move/delete
//! (delete goes to the freedesktop Trash), rename, create, properties.
//! Pure helpers are unit-tested; Tauri commands in lib.rs are thin wrappers.

use serde::Serialize;
use std::collections::VecDeque;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

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
}

#[derive(Debug, Clone, Serialize)]
pub struct Drive {
    pub name: String,
    pub mount: String,
    pub total: u64,
    pub free: u64,
    pub fs: String,
    pub removable: bool,
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

/// Mounted drives, from sysinfo. Snap/loop mounts are hidden: they are not
/// places a user browses to. Zero-size entries (binds, pseudo-filesystems)
/// are dropped, and the label is the mount point: sysinfo's Linux disk name
/// is the raw device path, which repeats for every mount of one disk.
pub fn drives() -> Vec<Drive> {
    use sysinfo::Disks;
    // Refresh the list AND the sizes: with DiskRefreshKind::nothing() the
    // mounts show up but total/free stay 0, which the filter then drops.
    let disks = Disks::new_with_refreshed_list();
    let mut out: Vec<Drive> = disks
        .iter()
        .filter(|d| {
            let m = d.mount_point().to_string_lossy();
            d.total_space() > 0
                && !m.starts_with("/snap")
                && !m.starts_with("/var/lib/snapd")
                && !d.name().to_string_lossy().starts_with("loop")
        })
        .map(|d| {
            let mount = d.mount_point().to_string_lossy().into_owned();
            Drive {
                name: if mount == "/" {
                    "System disk".into()
                } else {
                    mount.clone()
                },
                mount,
                total: d.total_space(),
                free: d.available_space(),
                fs: d.file_system().to_string_lossy().into_owned(),
                removable: d.is_removable(),
            }
        })
        .collect();
    out.sort_by(|a, b| a.mount.cmp(&b.mount));
    out.dedup_by(|a, b| a.mount == b.mount);
    out
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
        PathBuf::from(unique_name(dest, &name))
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
        PathBuf::from(unique_name(dest, &stem))
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

pub fn read_text(path: &Path, max_bytes: usize) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let end = bytes.len().min(max_bytes);
    Ok(String::from_utf8_lossy(&bytes[..end]).into_owned())
}

pub fn open_path(path: &Path) -> Result<(), String> {
    std::process::Command::new("xdg-open")
        .arg(path)
        .spawn()
        .map_err(|e| e.to_string())?;
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
    fn trashinfo_encoding() {
        assert_eq!(
            url_encode_path(Path::new("/home/zyan/My File.txt")),
            "/home/zyan/My%20File.txt"
        );
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
}
