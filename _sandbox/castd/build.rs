//! castd's binaries get an rpath to the x264 they were built against when it is not the system's: a patched x264
//! (image/build-x264.sh) is picked up by putting its prefix first on PKG_CONFIG_PATH, and the binary then finds it at
//! runtime and otherwise falls back to the system's. cast-core's build script links it; a library's
//! `rustc-link-arg-bins` would reach only that library's own binaries, so the rpath is set here.

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=PKG_CONFIG_PATH");
    let mut link_dirs: Vec<std::path::PathBuf> = Vec::new();
    let mut libs = vec!["x264", "libyuv"];
    if std::env::var_os("CARGO_FEATURE_AUDIO").is_some() {
        libs.extend(["opus", "libpulse-simple"]);
    }
    for lib in libs {
        if let Ok(found) = pkg_config::Config::new().cargo_metadata(false).probe(lib) {
            link_dirs.extend(found.link_paths);
        }
    }
    link_dirs.sort();
    link_dirs.dedup();
    for dir in &link_dirs {
        // The system's own library directory needs no rpath, and one would outrank LD_LIBRARY_PATH.
        if !dir.starts_with("/usr/lib") && !dir.starts_with("/lib") {
            println!("cargo:rustc-link-arg-bins=-Wl,-rpath,{}", dir.display());
        }
    }
}
