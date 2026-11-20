//! Links what the enabled features ask for, from pkg-config: x264 (bound with bindgen), libyuv, Opus and PulseAudio. With
//! `nvenc` it binds NVENC's API from the ffnvcodec headers (Debian's libffmpeg-nvenc-dev); nothing NVIDIA's is linked,
//! the driver's library is opened at runtime. With no feature it links nothing and needs neither pkg-config nor clang,
//! which is how it builds for Windows. A binary that wants an rpath to a patched x264 sets it in its own build script
//! (castd's): a library's `rustc-link-arg-bins` reaches only its own binaries.

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=PKG_CONFIG_PATH");
    #[cfg(feature = "x264")]
    x264_bindings();
    #[cfg(feature = "libyuv")]
    {
        // libyuv's CMake install writes no libyuv.pc, so Debian's package has none: link it from the default path.
        if pkg_config::probe_library("libyuv").is_err() {
            println!("cargo:rustc-link-lib=yuv");
        }
    }
    #[cfg(feature = "opus")]
    probe("opus", "apt-get install libopus-dev");
    #[cfg(feature = "pulse")]
    probe("libpulse-simple", "apt-get install libpulse-dev");
    #[cfg(feature = "nvenc")]
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux") {
        nvenc_bindings(&out_dir());
    }
}

#[cfg(any(feature = "opus", feature = "pulse"))]
fn probe(lib: &str, hint: &str) {
    if let Err(e) = pkg_config::probe_library(lib) {
        panic!("{lib} ({hint}): {e}");
    }
}

#[cfg(any(feature = "x264", feature = "nvenc"))]
fn out_dir() -> std::path::PathBuf {
    std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap())
}

#[cfg(feature = "x264")]
fn x264_bindings() {
    let x264 = pkg_config::probe_library("x264").expect("x264 (apt-get install libx264-dev)");
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
    std::fs::write(out_dir().join("x264.rs"), code).unwrap();
}

/// NVENC's types, from `ffnvcodec/nvEncodeAPI.h`, and what bindgen cannot carry over: the GUIDs (initialised `static
/// const` structs) and each struct's version (function-like macros), read off the header's text.
#[cfg(feature = "nvenc")]
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
