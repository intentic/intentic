/* WHAT VERSION THIS BUILD IS, AS A STRING THE CODE CAN READ.
 *
 * The release build passes its version to `tauri build` as a config override (build-desktop.sh), which is
 * what stamps the installer, the bundle metadata and the updater manifest. It does not reach Rust:
 * `CARGO_PKG_VERSION` comes from Cargo.toml, which stays at `0.0.0` for every build this repo ever cuts —
 * so the app's own screens and, more importantly, the release it pins its `ic` download to (commands.rs)
 * would all be reasoning about a version no release has.
 *
 * So the same value is handed in through the environment and stamped here. Unset — every `tauri dev`, every
 * local `tauri build` — leaves `0.0.0`, which is exactly the value those decisions read as "not a release".
 */
fn main() {
    let version = std::env::var("INTENTIC_VERSION")
        .ok()
        .filter(|version| !version.is_empty())
        .unwrap_or_else(|| "0.0.0".to_string());
    println!("cargo:rustc-env=INTENTIC_VERSION={version}");
    println!("cargo:rerun-if-env-changed=INTENTIC_VERSION");
    tauri_build::build();
}
