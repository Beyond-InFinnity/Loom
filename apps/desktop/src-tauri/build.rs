fn main() {
    println!("cargo:rustc-link-lib=mpv");
    tauri_build::build()
}
