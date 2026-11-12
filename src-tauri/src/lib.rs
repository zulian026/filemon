//! FileMon — Windows Explorer-style file manager for Linux.
//! Thin Tauri command layer over `fsops`.

mod fsops;

use fsops::{Drive, Entry, Properties, TransferOutcome};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Emitter;

/// One transfer at a time: a second paste/drop while one runs is rejected.
static TRANSFER_BUSY: AtomicBool = AtomicBool::new(false);
static TRANSFER_CANCEL: AtomicBool = AtomicBool::new(false);

#[tauri::command]
fn get_home() -> String {
    fsops::home_dir().to_string_lossy().into_owned()
}

#[tauri::command]
fn list_dir(path: String) -> Result<Vec<Entry>, String> {
    fsops::list_dir(&PathBuf::from(path))
}

#[tauri::command]
fn get_drives() -> Vec<Drive> {
    fsops::drives()
}

#[tauri::command]
fn search_files(root: String, query: String) -> Vec<Entry> {
    fsops::search(&PathBuf::from(root), &query, 200)
}

#[tauri::command]
fn copy_paths(paths: Vec<String>, dest: String) -> Result<usize, String> {
    let srcs: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
    fsops::copy_paths(&srcs, &PathBuf::from(dest))
}

#[tauri::command]
fn move_paths(paths: Vec<String>, dest: String) -> Result<usize, String> {
    let srcs: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
    fsops::move_paths(&srcs, &PathBuf::from(dest))
}

#[tauri::command]
fn delete_paths(paths: Vec<String>) -> Result<usize, String> {
    let srcs: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
    fsops::delete_paths(&srcs)
}

#[tauri::command]
fn rename_path(path: String, new_name: String) -> Result<String, String> {
    fsops::rename_path(&PathBuf::from(path), &new_name)
}

#[tauri::command]
fn new_folder(parent: String, name: String) -> Result<String, String> {
    fsops::new_folder(&PathBuf::from(parent), &name)
}

#[tauri::command]
fn new_file(parent: String, name: String) -> Result<String, String> {
    fsops::new_file(&PathBuf::from(parent), &name)
}

#[tauri::command]
fn get_properties(path: String) -> Result<Properties, String> {
    fsops::properties(&PathBuf::from(path))
}

#[tauri::command]
fn read_text(path: String) -> Result<String, String> {
    fsops::read_text(&PathBuf::from(path), 8192)
}

#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    fsops::open_path(&PathBuf::from(path))
}

#[tauri::command]
fn open_terminal(path: String) -> Result<(), String> {
    fsops::open_terminal(&PathBuf::from(path))
}

#[tauri::command]
fn start_transfer(
    app: tauri::AppHandle,
    paths: Vec<String>,
    dest: String,
    copy: bool,
) -> Result<TransferOutcome, String> {
    if TRANSFER_BUSY
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("A transfer is already running".to_string());
    }
    TRANSFER_CANCEL.store(false, Ordering::SeqCst);
    let srcs: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
    let result = fsops::transfer_files(
        &srcs,
        &PathBuf::from(dest),
        copy,
        &|p| {
            let _ = app.emit("transfer-progress", p);
        },
        &TRANSFER_CANCEL,
    );
    TRANSFER_BUSY.store(false, Ordering::SeqCst);
    result
}

#[tauri::command]
fn cancel_transfer() {
    TRANSFER_CANCEL.store(true, Ordering::SeqCst);
}

#[tauri::command]
fn compress_paths(paths: Vec<String>, dest: String) -> Result<String, String> {
    let srcs: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
    fsops::compress_paths(&srcs, &PathBuf::from(dest))
}

#[tauri::command]
fn extract_archive(path: String, dest: String) -> Result<String, String> {
    fsops::extract_archive(&PathBuf::from(path), &PathBuf::from(dest))
}

#[tauri::command]
fn list_trash() -> Vec<Entry> {
    fsops::list_trash()
}

#[tauri::command]
fn restore_trash(paths: Vec<String>) -> Result<usize, String> {
    let ps: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
    fsops::restore_trash(&ps)
}

#[tauri::command]
fn delete_trash(paths: Vec<String>) -> Result<usize, String> {
    let ps: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
    fsops::delete_trash(&ps)
}

#[tauri::command]
fn empty_trash() -> Result<usize, String> {
    fsops::empty_trash()
}

#[tauri::command]
fn format_size(bytes: u64) -> String {
    fsops::format_size(bytes)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_home,
            list_dir,
            get_drives,
            search_files,
            copy_paths,
            move_paths,
            start_transfer,
            cancel_transfer,
            compress_paths,
            extract_archive,
            list_trash,
            restore_trash,
            delete_trash,
            empty_trash,
            delete_paths,
            rename_path,
            new_folder,
            new_file,
            get_properties,
            read_text,
            open_path,
            open_terminal,
            format_size
        ])
        .run(tauri::generate_context!())
        .expect("error while running FileMon");
}
