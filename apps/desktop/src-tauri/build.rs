fn main() {
    // Link a locally-built modern libmpv (scripts/build-libmpv.sh → LOOM_MPV_PREFIX)
    // when set — needed for the EGL/VAAPI zero-copy render path (LOOM_RENDER_EGL);
    // jammy's system libmpv 0.34.1 aborts the VA surface probe.  Its SONAME is
    // libmpv.so.2 (vs the distro's libmpv.so.1) so the two never collide; add the
    // multiarch libdir to the link search + rpath so it loads without
    // LD_LIBRARY_PATH.  Unset → links the system libmpv exactly as before.
    println!("cargo:rerun-if-env-changed=LOOM_MPV_PREFIX");
    if let Ok(prefix) = std::env::var("LOOM_MPV_PREFIX") {
        let libdir = format!("{prefix}/lib/x86_64-linux-gnu");
        println!("cargo:rustc-link-search=native={libdir}");
        println!("cargo:rustc-link-arg=-Wl,-rpath,{libdir}");
    }
    println!("cargo:rustc-link-lib=mpv");
    tauri_build::build()
}
