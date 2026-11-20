//! Binds x264's C API with bindgen and links x264, libyuv, and (with the `audio` feature) Opus and PulseAudio, all from
//! pkg-config. With the `nvenc` feature it also binds NVENC's API from the ffnvcodec headers (Debian's
//! libffmpeg-nvenc-dev); nothing NVIDIA's is linked, the driver's library is opened at runtime. A patched x264 (image/build-x264.sh) is picked up by putting its prefix first on PKG_CONFIG_PATH; its
//! library directory is embedded as an rpath, so the binary finds it at runtime and otherwise falls back to the system's.

fn main() {
    let x264 = pkg_config::probe_library("x264").expect("x264 (apt-get install libx264-dev)");
    let mut link_dirs: Vec<std::path::PathBuf> = x264.link_paths.clone();
    match pkg_config::probe_library("libyuv") {
        Ok(lib) => link_dirs.extend(lib.link_paths),
        // libyuv's CMake install writes no libyuv.pc, so Debian's package has none: link it from the default path.
        Err(_) => println!("cargo:rustc-link-lib=yuv"),
    }
    if std::env::var_os("CARGO_FEATURE_AUDIO").is_some() {
        for lib in ["opus", "libpulse-simple"] {
            let found = pkg_config::probe_library(lib).unwrap_or_else(|e| {
                panic!("{lib} (apt-get install libopus-dev libpulse-dev): {e}")
            });
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

    let mut builder = bindgen::Builder::default()
        .header_contents("wrap.h", "#include <stdint.h>\n#include <x264.h>\n")
        .allowlist_function("x264_.*")
        .allowlist_type("x264_.*")
        .allowlist_var("X264_.*")
        .layout_tests(false)
        // Edition 2024 wants `unsafe extern` blocks.
        .rust_edition(bindgen::RustEdition::Edition2024);
    for dir in &x264.include_paths {
        builder = builder.clang_arg(format!("-I{}", dir.display()));
    }
    let mut code = builder.generate().expect("bindgen x264").to_string();
    // x264.h renames x264_encoder_open after the library's build number (a macro bindgen cannot follow): alias whichever
    // build this x264 is.
    let open = code
        .split(|c: char| !(c.is_alphanumeric() || c == '_'))
        .find(|word| {
            word.strip_prefix("x264_encoder_open_")
                .is_some_and(|n| n.chars().all(|c| c.is_ascii_digit()))
        })
        .expect("x264_encoder_open_<build> in x264.h")
        .to_string();
    code.push_str(&format!("\npub use {open} as x264_encoder_open;\n"));
    let out = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap());
    std::fs::write(out.join("x264.rs"), code).unwrap();
    if std::env::var_os("CARGO_FEATURE_NVENC").is_some() {
        nvenc_bindings(&out);
    }
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=PKG_CONFIG_PATH");
}

/// NVENC's types, from `ffnvcodec/nvEncodeAPI.h`, and what bindgen cannot carry over: the GUIDs (initialised `static
/// const` structs) and each struct's version (function-like macros), read off the header's text.
fn nvenc_bindings(out: &std::path::Path) {
    let lib = pkg_config::Config::new()
        .cargo_metadata(false)
        .probe("ffnvcodec")
        .expect("ffnvcodec headers for the nvenc feature (apt-get install libffmpeg-nvenc-dev)");
    let header = lib
        .include_paths
        .iter()
        .chain([std::path::PathBuf::from("/usr/include")].iter())
        .map(|d| d.join("ffnvcodec/nvEncodeAPI.h"))
        .find(|p| p.exists())
        .expect("ffnvcodec/nvEncodeAPI.h");
    let mut code = bindgen::Builder::default()
        .header(header.to_string_lossy())
        .allowlist_type("_?NV_ENC.*|NV_ENCODE_API_FUNCTION_LIST|NVENCSTATUS|GUID|PNVENC.*")
        .allowlist_var("NVENCAPI_(MAJOR|MINOR)_VERSION|NVENC_INFINITE_GOPLENGTH")
        .layout_tests(false)
        .derive_default(true)
        // NV_ENC_PARAMS_RC_VBR rather than _NV_ENC_PARAMS_RC_MODE_NV_ENC_PARAMS_RC_VBR: the header's own names.
        .prepend_enum_name(false)
        .rust_edition(bindgen::RustEdition::Edition2024)
        .generate()
        .expect("bindgen nvEncodeAPI.h")
        .to_string();
    let text = std::fs::read_to_string(&header).unwrap();
    let words = |l: &str| -> Vec<String> {
        l.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
            .filter(|w| !w.is_empty())
            .map(String::from)
            .collect()
    };
    let lines: Vec<&str> = text.lines().collect();
    for (i, line) in lines.iter().enumerate() {
        let w = words(line);
        // static const GUID NAME =\n{ 0x..., 0x..., 0x..., { 0x.. x8 } };
        if w.len() >= 4 && w[0] == "static" && w[1] == "const" && w[2] == "GUID" {
            let name = &w[3];
            let body: String = lines[i..(i + 3).min(lines.len())].join(" ");
            let nums: Vec<String> = body
                .split(|c: char| !(c.is_ascii_hexdigit() || c == 'x'))
                .filter(|t| t.starts_with("0x"))
                .map(String::from)
                .collect();
            if nums.len() == 11 {
                code.push_str(&format!(
                    "pub const {name}: GUID = GUID {{ Data1: {}, Data2: {}, Data3: {}, Data4: [{}] }};\n",
                    nums[0],
                    nums[1],
                    nums[2],
                    nums[3..].join(", ")
                ));
            }
        }
        // #define NAME_VER NVENCAPI_STRUCT_VERSION(n)   or   (NVENCAPI_STRUCT_VERSION(n) | ( 1u<<31 ))
        if w.len() >= 4
            && w[0] == "define"
            && w[1].ends_with("_VER")
            && line.contains("NVENCAPI_STRUCT_VERSION(")
        {
            let n = line
                .split("NVENCAPI_STRUCT_VERSION(")
                .nth(1)
                .and_then(|r| r.split(')').next())
                .and_then(|n| n.trim().parse::<u32>().ok());
            if let Some(n) = n {
                let high = if line.contains("1u<<31") || line.contains("1<<31") {
                    " | (1u32 << 31)"
                } else {
                    ""
                };
                code.push_str(&format!(
                    "pub const {}: u32 = struct_version({n}){high};\n",
                    w[1]
                ));
            }
        }
    }
    code.push_str(
        "pub const NVENCAPI_VERSION: u32 = NVENCAPI_MAJOR_VERSION | (NVENCAPI_MINOR_VERSION << 24);\n\
         pub const fn struct_version(v: u32) -> u32 { NVENCAPI_VERSION | (v << 16) | (0x7 << 28) }\n",
    );
    std::fs::write(out.join("nvenc.rs"), code).unwrap();
    println!("cargo:rerun-if-changed={}", header.display());
}
