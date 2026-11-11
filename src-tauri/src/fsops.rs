//! Filesystem operations for FileMon: listing, search, copy/move/delete
//! (delete goes to the freedesktop Trash), rename, create, properties.
//! Pure helpers are unit-tested; Tauri commands in lib.rs are thin wrappers.

use serde::Serialize;
use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};

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
/// places a user browses to.
pub fn drives() -> Vec<Drive> {
    use sysinfo::{DiskRefreshKind, Disks};
    let disks = Disks::new_with_refreshed_list_specifics(DiskRefreshKind::nothing());
    let mut out: Vec<Drive> = disks
        .iter()
        .filter(|d| {
            let m = d.mount_point().to_string_lossy();
            !m.starts_with("/snap")
                && !m.starts_with("/var/lib/snapd")
                && !d.name().to_string_lossy().starts_with("loop")
        })
        .map(|d| Drive {
            name: {
                let n = d.name().to_string_lossy().into_owned();
                if n.is_empty() {
                    d.mount_point().to_string_lossy().into_owned()
                } else {
                    n
                }
            },
            mount: d.mount_point().to_string_lossy().into_owned(),
            total: d.total_space(),
            free: d.available_space(),
            fs: d.file_system().to_string_lossy().into_owned(),
            removable: d.is_removable(),
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
}
