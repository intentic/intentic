/* The release build passes its version to `tauri build` as a config override (build-desktop.sh), which is what stamps the installer. */
fn main() {
    let version = std::env::var("INTENTIC_VERSION")
        .ok()
        .filter(|version| !version.is_empty())
        .unwrap_or_else(|| "0.0.0".to_string());
    println!("cargo:rustc-env=INTENTIC_VERSION={version}");
    println!("cargo:rerun-if-env-changed=INTENTIC_VERSION");
    tauri_build::build();
}
