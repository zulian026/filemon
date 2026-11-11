//! FileMon — Windows Explorer-style file manager for Linux.
//! Thin Tauri command layer over `fsops`.

mod fsops;

use fsops::{Drive, Entry, Properties};
use std::path::PathBuf;

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
            delete_paths,
            rename_path,
            new_folder,
            new_file,
            get_properties,
            read_text,
            open_path,
            format_size
        ])
        .run(tauri::generate_context!())
        .expect("error while running FileMon");
}
