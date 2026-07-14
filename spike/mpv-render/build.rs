fn main() {
    // By default link the system libmpv (libmpv.so, from libmpv-dev).
    //
    // For the EGL/VAAPI zero-copy spike (LOOM_SPIKE_EGL=1) set LOOM_MPV_PREFIX to
    // a locally-built modern libmpv (scripts/build-libmpv.sh installs to
    // vendor/mpv-prefix): jammy's 0.34.1 aborts the VA surface probe, so the
    // interop only engages with the newer build.  Its SONAME is libmpv.so.2
    // (vs the distro's libmpv.so.1), so the two never collide; we add the
    // multiarch libdir to the link search AND as an rpath so it loads at runtime
    // without LD_LIBRARY_PATH.
    println!("cargo:rerun-if-env-changed=LOOM_MPV_PREFIX");
    if let Ok(prefix) = std::env::var("LOOM_MPV_PREFIX") {
        let libdir = format!("{prefix}/lib/x86_64-linux-gnu");
        println!("cargo:rustc-link-search=native={libdir}");
        println!("cargo:rustc-link-arg=-Wl,-rpath,{libdir}");
    }
    println!("cargo:rustc-link-lib=mpv");
}
