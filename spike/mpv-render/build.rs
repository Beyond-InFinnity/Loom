fn main() {
    // Link the system libmpv (libmpv.so, from libmpv-dev).
    println!("cargo:rustc-link-lib=mpv");
}
