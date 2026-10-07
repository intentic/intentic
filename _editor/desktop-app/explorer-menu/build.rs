/* The package manifest for the package register.rs signs on the user's PC (AppxManifest.xml says who else fills it). */
use std::collections::BTreeSet;
use std::path::Path;

/// The subject of the certificate register.rs makes, and so the publisher of the package it signs. register.rs reads
/// it back as `env!("EXPLORER_MENU_PUBLISHER")`.
const PUBLISHER: &str = "CN=Intentic Explorer Menu";

fn main() {
    let conf_path = Path::new("../src-tauri/tauri.conf.json");
    println!("cargo:rerun-if-changed={}", conf_path.display());
    println!("cargo:rerun-if-changed=AppxManifest.xml");

    let template = std::fs::read_to_string("AppxManifest.xml").expect("AppxManifest.xml reads");
    check_file_types(&template, conf_path);

    // The version is the template's own fingerprint rather than the release's: the same manifest keeps the same
    // version from one update to the next, which is how register.rs knows an update needs no new registration (and no
    // admin prompt), and a changed manifest always gets a different one.
    let fingerprint = fnv1a(template.as_bytes());
    let version = format!(
        "1.{}.{}.0",
        (fingerprint >> 16) & 0xffff,
        fingerprint & 0xffff
    );
    let manifest = template
        .replace("{PUBLISHER}", PUBLISHER)
        .replace("{VERSION}", &version);
    assert!(
        !manifest.contains("{PUBLISHER}") && !manifest.contains("{VERSION}"),
        "AppxManifest.xml has an unfilled placeholder"
    );
    let out = std::env::var("OUT_DIR").expect("cargo sets OUT_DIR");
    std::fs::write(Path::new(&out).join("AppxManifest.xml"), manifest).expect("manifest writes");
    println!("cargo:rustc-env=EXPLORER_MENU_PUBLISHER={PUBLISHER}");
    println!("cargo:rustc-env=EXPLORER_MENU_VERSION={version}");
}

/// The menu is offered on the document types the installer associates with the app (tauri.conf.json), and on no
/// others: a .exe or a .png is not offered to an app that cannot show it. The manifest lists them by hand, so that the
/// release's packer reads the same file this crate does; this is what keeps the two lists one.
fn check_file_types(template: &str, conf_path: &Path) {
    let conf: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(conf_path).expect("tauri.conf.json reads"))
            .expect("tauri.conf.json parses");
    let associated: BTreeSet<String> = conf["bundle"]["fileAssociations"]
        .as_array()
        .expect("tauri.conf.json has bundle.fileAssociations")
        .iter()
        .flat_map(|association| association["ext"].as_array().cloned().unwrap_or_default())
        .filter_map(|ext| {
            ext.as_str()
                .map(|ext| format!(".{}", ext.to_ascii_lowercase()))
        })
        .collect();
    let listed: BTreeSet<String> = template
        .split("<desktop5:ItemType Type=\"")
        .skip(1)
        .filter_map(|rest| rest.split('"').next())
        .filter(|kind| kind.starts_with('.'))
        .map(str::to_string)
        .collect();
    assert_eq!(
        listed, associated,
        "AppxManifest.xml's file ItemTypes differ from tauri.conf.json's fileAssociations; list the same extensions in both"
    );
}

fn fnv1a(bytes: &[u8]) -> u32 {
    bytes.iter().fold(0x811c_9dc5u32, |hash, byte| {
        (hash ^ u32::from(*byte)).wrapping_mul(0x0100_0193)
    })
}
