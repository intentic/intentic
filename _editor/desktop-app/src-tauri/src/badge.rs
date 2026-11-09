use std::sync::Mutex;
use std::time::Duration;

use tauri::image::Image;
use tauri::{AppHandle, Manager, Webview, Window};

use crate::setup_link::BadgeArgs;

/* Mirror tabSignal.ts on the native tray/taskbar/dock: needs-you count, away completion check, running dot or unreachable grey.
 * The page supplies both drawings through intentic://badge so native and web marks agree; tray tooltip explains the state.
 * Windows uses a taskbar overlay; Linux counts use com.canonical.Unity.LauncherEntry. Avoid redundant flashing or progress bars. */

/// The tray's id (lib.rs `create_tray`).
pub const TRAY: &str = "main";

/// Every tooltip opens with the app's name, which is all the tray says while nothing is marked.
const NAME: &str = "Intentic";

/// The widest image a badge puts up. The page draws 64 pixels for the tray and 32 for the overlay; this bounds what a
/// link can make the platform scale.
const IMAGE_SIDE_MAX: u32 = 256;

/// What the badge last put up, kept for a taskbar button Windows makes anew (a window coming back from the tray) and
/// so a dock is told a count only when it moves.
#[derive(Default)]
pub struct Badge(Mutex<Standing>);

#[derive(Default)]
struct Standing {
    /// The mark alone, for the overlay of each face's taskbar button. Read on Windows only, kept everywhere: one shape.
    #[cfg_attr(not(windows), allow(dead_code))]
    overlay: Option<Image<'static>>,
    /// The open sandbox's logo for the window's icon, or none for the app's own.
    window: Option<Image<'static>>,
    /// The count a Linux dock was last told.
    count: Option<u32>,
    /// The taskbar identity the frame's button was last given (Windows), so a badge that names the same sandbox with
    /// the same logo leaves the button where it is.
    identity: Option<Identity>,
}

/// A PNG the page drew, read as an image, or nothing for one that is not a PNG or is too large to be an icon.
fn image_of(png: &[u8]) -> Option<Image<'static>> {
    let image = Image::from_bytes(png).ok()?;
    (image.width() <= IMAGE_SIDE_MAX && image.height() <= IMAGE_SIDE_MAX).then_some(image)
}

/// The tray's tooltip for what the page said the mark means, or the app's name alone.
fn tooltip_of(said: Option<&str>) -> String {
    match said {
        Some(said) => format!("{NAME} · {said}"),
        None => NAME.to_string(),
    }
}

/// Put the workspace tab's mark on the app's icon. An image that will not decode is the app's own icon, never a
/// blank one.
pub fn show(app: &AppHandle, args: BadgeArgs) {
    let icon = args.icon.as_deref().and_then(image_of);
    if let Some(tray) = app.tray_by_id(TRAY) {
        let icon = icon.or_else(|| app.default_window_icon().cloned().map(Image::to_owned));
        if let Err(error) = tray.set_icon(icon) {
            eprintln!("intentic: the tray icon could not be marked: {error}");
        }
        let _ = tray.set_tooltip(Some(tooltip_of(args.tooltip.as_deref())));
    }
    let overlay = args.overlay.as_deref().and_then(image_of);
    let count = args.count;
    let window = args.window.as_deref().and_then(image_of);
    let identity = identity_of(
        app,
        args.sandbox.as_ref(),
        args.window.as_deref().filter(|_| window.is_some()),
    );
    let (tell_dock, moved) = {
        let badge = app.state::<Badge>();
        let mut standing = badge.0.lock().unwrap();
        standing.overlay = overlay;
        standing.window = window;
        let moved = standing.identity.as_ref() != Some(&identity);
        standing.identity = Some(identity.clone());
        (standing.count.replace(count) != Some(count), moved)
    };
    if let Some(frame) = crate::frame::frame(app) {
        if moved {
            identity_now(app, &frame, identity);
        }
        window_icon_now(app, &frame);
        overlay_now(app, &frame);
        if moved {
            overlay_later(app);
        }
    }
    if tell_dock {
        dock(app, count);
    }
}

/// A face has just come on screen (shown.rs): the frame both faces are drawn in carries the app's taskbar button, and a
/// floating panel or a document's window keeps a button of its own, unmarked, as a second window of an app does. Windows
/// makes that button anew each time the frame comes back from the tray, with no overlay, and only once the shell has got
/// round to it, so the mark is put back a moment later and once more after that rather than straight away, when there
/// is no button yet to put it on.
pub fn window_shown(window: &Webview) {
    if is_face(window.label()) {
        overlay_later(window.app_handle());
    }
}

/// The overlay put back on a taskbar button Windows has just made anew: a frame back from the tray, or one whose
/// identity moved it to another button ([`identity_now`]).
fn overlay_later(app: &AppHandle) {
    if !cfg!(windows) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        for wait in [Duration::from_millis(300), Duration::from_millis(1500)] {
            tokio::time::sleep(wait).await;
            if let Some(frame) = crate::frame::frame(&app) {
                overlay_now(&app, &frame);
            }
        }
    });
}

fn is_face(label: &str) -> bool {
    crate::frame::is_face(label)
}

/// The frame's own icon, which the taskbar button and the dock tile show: the open sandbox's logo, or the app's.
fn window_icon_now(app: &AppHandle, window: &Window) {
    let logo = app.state::<Badge>().0.lock().unwrap().window.clone();
    taskbar_icon_now(window, logo.clone());
    let Some(icon) = logo.or_else(|| app.default_window_icon().cloned().map(Image::to_owned))
    else {
        return;
    };
    if let Err(error) = window.set_icon(icon) {
        eprintln!("intentic: the window's icon could not be set: {error}");
    }
}

/// Windows' taskbar button draws the window's big icon, and Tauri's `set_icon` sets only the small one (the title bar,
/// Alt+Tab), so without this the button kept the executable's icon while the tray showed the sandbox's logo. No logo
/// takes the big icon off again, and the button goes back to the executable's, at every size it carries.
#[cfg(windows)]
fn taskbar_icon_now(window: &Window, logo: Option<Image<'static>>) {
    let frame = window.clone();
    if let Err(error) = window.run_on_main_thread(move || big_icon::put(&frame, logo.as_ref())) {
        eprintln!("intentic: the taskbar button's icon could not be set: {error}");
    }
}

#[cfg(not(windows))]
fn taskbar_icon_now(_window: &Window, _logo: Option<Image<'static>>) {}

/// The frame's `ICON_BIG`, made and owned here: Windows keeps the handle, not a copy, so the one put up last lives
/// until the next replaces it.
#[cfg(windows)]
mod big_icon {
    use std::sync::atomic::{AtomicIsize, Ordering};

    use tauri::image::Image;
    use tauri::Window;
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateIcon, DestroyIcon, SendMessageW, HICON, ICON_BIG, WM_SETICON,
    };

    /// The handle this module last put up, or 0. Only ever touched on the main thread.
    static PUT: AtomicIsize = AtomicIsize::new(0);

    pub fn put(window: &Window, logo: Option<&Image<'_>>) {
        let Ok(hwnd) = window.hwnd() else {
            return;
        };
        let raw = logo.and_then(icon_of).map_or(0, |icon| icon.0 as isize);
        // SAFETY: the frame's own window, given a handle made just above or none; the one it replaces is ours and is
        // no longer the window's once the message returns, so it is freed after.
        unsafe {
            SendMessageW(
                hwnd,
                WM_SETICON,
                Some(WPARAM(ICON_BIG as usize)),
                Some(LPARAM(raw)),
            );
            let before = PUT.swap(raw, Ordering::Relaxed);
            if before != 0 {
                let _ = DestroyIcon(HICON(before as *mut _));
            }
        }
    }

    /// An icon of the image's RGBA, its alpha kept: a 32-bit colour plane in BGRA order, and an AND mask of nothing,
    /// one bit a pixel in rows padded to 16 bits, which Windows ignores where the colour has alpha.
    fn icon_of(image: &Image<'_>) -> Option<HICON> {
        let (width, height) = (image.width(), image.height());
        let bgra: Vec<u8> = image
            .rgba()
            .chunks_exact(4)
            .flat_map(|pixel| [pixel[2], pixel[1], pixel[0], pixel[3]])
            .collect();
        let mask = vec![0u8; (width as usize).div_ceil(16) * 2 * height as usize];
        // SAFETY: both planes are sized for width × height as CreateIcon reads them, and outlive the call.
        unsafe {
            CreateIcon(
                None,
                width as i32,
                height as i32,
                1,
                32,
                mask.as_ptr(),
                bgra.as_ptr(),
            )
        }
        .ok()
    }
}

/* THE FRAME'S TASKBAR IDENTITY (Windows).
 *
 * A pinned taskbar button is drawn with its shortcut's icon, never the window's, and the shortcut Windows makes when the
 * reader pins a running button takes its icon from the window's relaunch properties (or the executable's, the lotus,
 * when it names none). One identity for every sandbox meant one pin, and the lotus on it in every sandbox: pinned on
 * rog on 2026-11-07, the button kept the lotus while `ICON_BIG` wore the logo. So the button is the open sandbox's own,
 * as Chrome gives each profile its own: an id per sandbox, a relaunch icon that is the sandbox's logo written to a file,
 * a relaunch command that opens that sandbox, and its name. A pin made from it wears that logo and opens that sandbox;
 * switching sandboxes moves the window to the other sandbox's button. Without a sandbox the button is the app's own,
 * under an id that matches no Start menu shortcut: one that did (`SetLnkAppUserModelId`, which toasts need, notice.rs)
 * would draw the shortcut's icon whatever the window wore. */

/// What the frame's taskbar button belongs to. Kept, so a launch starts under the identity the app last had (and a pin's
/// launch under the pin's own) rather than appearing as the app's and jumping into place once the page has loaded.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Identity {
    /// The open sandbox, or none for the app's own button.
    sandbox: Option<String>,
    /// The sandbox's name, which a pin made from the button is labelled with.
    name: Option<String>,
    /// The sandbox's logo as an icon file, which a pin made from the button wears. None is the executable's icon.
    icon: Option<std::path::PathBuf>,
}

impl Identity {
    const APP: Self = Self {
        sandbox: None,
        name: None,
        icon: None,
    };
}

/// Where the logos are written as icons, and the identity kept between launches.
fn taskbar_dir(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_local_data_dir()
        .ok()
        .map(|dir| dir.join("taskbar"))
}

const KEPT: &str = "identity.json";

/// The button the badge's sandbox and logo make. The logo is written once per picture, under a name of its own: Windows
/// caches an icon by its file's path, and a pin keeps the path it was made with, so a file is never written over.
fn identity_of(
    app: &AppHandle,
    sandbox: Option<&crate::setup_link::BadgeSandbox>,
    logo: Option<&[u8]>,
) -> Identity {
    // Only Windows' taskbar has buttons to give an identity, and nowhere else is a logo written for one.
    let Some(sandbox) = sandbox.filter(|_| cfg!(windows)) else {
        return Identity::APP;
    };
    let icon = logo.zip(taskbar_dir(app)).and_then(|(png, dir)| {
        let path = dir.join(icon_file_name(&sandbox.id, png));
        if path.is_file() {
            return Some(path);
        }
        let written = std::fs::create_dir_all(&dir).and_then(|()| std::fs::write(&path, ico_of(png)?));
        match written {
            Ok(()) => Some(path),
            Err(error) => {
                eprintln!("intentic: the sandbox's logo could not be kept for its taskbar button: {error}");
                None
            }
        }
    });
    Identity {
        sandbox: Some(sandbox.id.clone()),
        name: sandbox.name.clone(),
        icon,
    }
}

/// `<sandbox>-<the picture's digest>.ico`: the sandbox's id is a file name's characters already (`is_sandbox_id`).
fn icon_file_name(sandbox: &str, png: &[u8]) -> String {
    use sha2::Digest;
    let digest = sha2::Sha256::digest(png);
    let short: String = digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("{sandbox}-{short}.ico")
}

/// An icon file holding the PNG as it is, which Windows reads since Vista: one entry, its size in the directory (0 is
/// 256), the PNG after the header.
fn ico_of(png: &[u8]) -> std::io::Result<Vec<u8>> {
    let image = image_of(png).ok_or_else(|| std::io::Error::other("not an icon"))?;
    let side = |pixels: u32| u8::try_from(pixels).unwrap_or(0);
    let length = u32::try_from(png.len()).map_err(std::io::Error::other)?;
    let mut ico = Vec::with_capacity(22 + png.len());
    ico.extend_from_slice(&[0, 0, 1, 0, 1, 0]);
    ico.extend_from_slice(&[side(image.width()), side(image.height()), 0, 0]);
    ico.extend_from_slice(&1u16.to_le_bytes());
    ico.extend_from_slice(&32u16.to_le_bytes());
    ico.extend_from_slice(&length.to_le_bytes());
    ico.extend_from_slice(&22u32.to_le_bytes());
    ico.extend_from_slice(png);
    Ok(ico)
}

/// The id a sandbox's button goes by: the app's own followed by the sandbox's, inside the 128 characters an id may have.
#[cfg_attr(not(windows), allow(dead_code))]
fn taskbar_id(base: &str, identity: &Identity) -> String {
    match &identity.sandbox {
        Some(sandbox) => format!("{base}.sandbox.{sandbox}"),
        None => format!("{base}.window"),
    }
}

/// What a pin made from the button runs: the app, at the sandbox where there is one (setup_link.rs `shell_target`).
#[cfg_attr(not(windows), allow(dead_code))]
fn relaunch_args(identity: &Identity) -> String {
    match &identity.sandbox {
        Some(sandbox) => format!(" intentic://shell?open=sandbox&id={sandbox}"),
        None => String::new(),
    }
}

/// The identity a frame about to be shown for the first time starts with: the sandbox a link this launch carries opens
/// (a pin's launch), when the app has given that sandbox a button before, or else the one it last had.
fn starting_identity(app: &AppHandle) -> Identity {
    if !cfg!(windows) {
        return Identity::APP;
    }
    let kept: Option<Kept> =
        taskbar_dir(app).and_then(|dir| crate::state::read_json(&dir.join(KEPT)));
    let Some(kept) = kept else {
        return Identity::APP;
    };
    let launched = std::env::args()
        .skip(1)
        .find_map(|arg| launched_sandbox(&arg));
    let identity = launched
        .and_then(|sandbox| {
            kept.known
                .into_iter()
                .find(|known| known.sandbox.as_deref() == Some(sandbox.as_str()))
        })
        .unwrap_or(kept.last);
    // A logo file cleared away since keeps the executable's icon rather than naming one that is not there.
    Identity {
        icon: identity.icon.filter(|icon| icon.is_file()),
        ..identity
    }
}

/// The sandbox a `intentic://shell?open=sandbox&id=…` argument opens.
fn launched_sandbox(arg: &str) -> Option<String> {
    match crate::setup_link::parse_link(arg, crate::setup_link::Source::External)? {
        crate::setup_link::Link::Shell(crate::setup_link::ShellTarget::Sandbox { id, .. }) => {
            Some(id)
        }
        _ => None,
    }
}

/// The identity last given, and each sandbox's last one, between launches.
#[derive(serde::Serialize, serde::Deserialize)]
struct Kept {
    last: Identity,
    known: Vec<Identity>,
}

/// The most sandboxes whose last identity is kept for a pin's launch.
const KNOWN_MAX: usize = 64;

fn keep(app: &AppHandle, identity: &Identity) {
    let Some(dir) = taskbar_dir(app).filter(|_| cfg!(windows)) else {
        return;
    };
    let path = dir.join(KEPT);
    let mut known = crate::state::read_json::<Kept>(&path)
        .map(|kept| kept.known)
        .unwrap_or_default();
    if identity.sandbox.is_some() {
        known.retain(|other| other.sandbox != identity.sandbox);
        known.insert(0, identity.clone());
        known.truncate(KNOWN_MAX);
    }
    if std::fs::create_dir_all(&dir).is_ok() {
        crate::state::write_json(
            &path,
            &Kept {
                last: identity.clone(),
                known,
            },
        );
    }
}

/// The frame's taskbar identity before it is first shown: the taskbar reads a window's id when it makes its button.
pub fn own_taskbar_button(app: &AppHandle, window: &Window) {
    let identity = starting_identity(app);
    put_identity(app, window, &identity);
    app.state::<Badge>().0.lock().unwrap().identity = Some(identity);
}

/// The button moved to another identity: Windows makes the window a button under the new id at once, wearing the
/// relaunch icon, and the identity is kept for the next launch.
fn identity_now(app: &AppHandle, window: &Window, identity: Identity) {
    keep(app, &identity);
    let (handle, frame) = (app.clone(), window.clone());
    if let Err(error) = window.run_on_main_thread(move || put_identity(&handle, &frame, &identity))
    {
        eprintln!("intentic: the taskbar button could not be moved: {error}");
    }
}

#[cfg(windows)]
fn put_identity(app: &AppHandle, window: &Window, identity: &Identity) {
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let exe = std::env::current_exe().ok();
    let relaunch = exe.as_deref().map(|exe| taskbar_identity::Relaunch {
        command: format!("\"{}\"{}", exe.display(), relaunch_args(identity)),
        name: match &identity.name {
            Some(name) => format!("{name} · Intentic"),
            None => "Intentic".to_string(),
        },
        icon: match &identity.icon {
            Some(icon) => format!("{},0", icon.display()),
            None => format!("{},0", exe.display()),
        },
    });
    if let Err(error) = taskbar_identity::put(
        hwnd,
        &taskbar_id(&app.config().identifier, identity),
        relaunch.as_ref(),
    ) {
        eprintln!("intentic: the taskbar button could not be given its identity: {error}");
    }
}

#[cfg(not(windows))]
fn put_identity(_app: &AppHandle, _window: &Window, _identity: &Identity) {}

#[cfg(windows)]
mod taskbar_identity {
    use windows::Win32::Foundation::{HWND, PROPERTYKEY};
    use windows::Win32::System::Com::StructuredStorage::{
        PropVariantChangeType, PROPVARIANT, PVCHF_DEFAULT,
    };
    use windows::Win32::System::Variant::VT_LPWSTR;
    use windows::Win32::UI::Shell::PropertiesSystem::{
        IPropertyStore, SHGetPropertyStoreForWindow,
    };

    /// `PKEY_AppUserModel_*` (propkey.h), named here rather than through the `Win32_Storage_EnhancedStorage` feature.
    const fn key(pid: u32) -> PROPERTYKEY {
        PROPERTYKEY {
            fmtid: windows::core::GUID::from_u128(0x9f4c2855_9f79_4b39_a8d0_e1d42de1d5f3),
            pid,
        }
    }
    const RELAUNCH_COMMAND: PROPERTYKEY = key(2);
    const RELAUNCH_ICON: PROPERTYKEY = key(3);
    const RELAUNCH_NAME: PROPERTYKEY = key(4);
    const ID: PROPERTYKEY = key(5);

    /// What a pin made from the button runs, is called and wears.
    pub struct Relaunch {
        pub command: String,
        pub name: String,
        /// `path,index`: the sandbox's logo file, or the executable's own icon.
        pub icon: String,
    }

    /// The shell reads these properties as `VT_LPWSTR`; `PROPVARIANT::from(&str)` is a `VT_BSTR`.
    fn text(value: &str) -> windows::core::Result<PROPVARIANT> {
        let mut wide = PROPVARIANT::default();
        // SAFETY: both are valid PROPVARIANTs; the converted copy owns its own string, freed when it drops.
        unsafe {
            PropVariantChangeType(
                &mut wide,
                &PROPVARIANT::from(value),
                PVCHF_DEFAULT,
                VT_LPWSTR,
            )?
        };
        Ok(wide)
    }

    /// The relaunch properties first and the id last: the taskbar reads them all when the id changes, and they count
    /// only beside one.
    pub fn put(hwnd: HWND, id: &str, relaunch: Option<&Relaunch>) -> windows::core::Result<()> {
        // SAFETY: the frame's own window, on the thread that made it.
        let store: IPropertyStore = unsafe { SHGetPropertyStoreForWindow(hwnd)? };
        let mut values = Vec::with_capacity(4);
        if let Some(relaunch) = relaunch {
            values.push((RELAUNCH_COMMAND, text(&relaunch.command)?));
            values.push((RELAUNCH_NAME, text(&relaunch.name)?));
            values.push((RELAUNCH_ICON, text(&relaunch.icon)?));
        }
        values.push((ID, text(id)?));
        for (key, value) in &values {
            // SAFETY: a key and a value that outlive the call; the store copies what it keeps.
            unsafe { store.SetValue(key, value)? };
        }
        // SAFETY: as above.
        unsafe { store.Commit() }
    }
}

/// The overlay on the frame's taskbar button, as the badge stands. A hidden frame has no button to mark, and gets its
/// mark when it is shown again ([`window_shown`]).
#[cfg(windows)]
fn overlay_now(app: &AppHandle, window: &Window) {
    if !matches!(window.is_visible(), Ok(true)) {
        return;
    }
    let overlay = app.state::<Badge>().0.lock().unwrap().overlay.clone();
    let _ = window.set_overlay_icon(overlay);
}

#[cfg(not(windows))]
fn overlay_now(_app: &AppHandle, _window: &Window) {}

/// The count on a Linux dock's icon for the app, through the signal Unity defined and every dock that draws a count
/// listens for. tao's own `set_badge_count` speaks it only while Unity itself is running, which no desktop since 2017
/// is, so the app sends the signal itself, naming the desktop entry its packages install (`<productName>.desktop`, as
/// tauri-bundler names it). An AppImage has no such entry, and no dock draws anything for it.
#[cfg(target_os = "linux")]
fn dock(app: &AppHandle, count: u32) {
    let entry = format!("application://{}.desktop", app.package_info().name);
    crate::notice::later(move || {
        let Some(bus) = crate::notice::session_bus() else {
            return;
        };
        let mut properties = std::collections::HashMap::new();
        properties.insert("count", zbus::wire::Variant::I64(i64::from(count)));
        properties.insert("count-visible", zbus::wire::Variant::Bool(count > 0));
        if let Err(error) = tauri::async_runtime::block_on(bus.emit_signal(
            None::<&str>,
            "/dev/intentic/desktop/launcher",
            "com.canonical.Unity.LauncherEntry",
            "Update",
            &(entry.as_str(), properties),
        )) {
            eprintln!("intentic: the dock could not be told the count: {error}");
        }
    });
}

#[cfg(not(target_os = "linux"))]
fn dock(_app: &AppHandle, _count: u32) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tooltip_names_the_app_and_then_what_the_mark_means() {
        assert_eq!(tooltip_of(None), "Intentic");
        assert_eq!(tooltip_of(Some("2 need you")), "Intentic · 2 need you");
    }

    #[test]
    fn only_the_two_faces_carry_the_taskbar_mark() {
        assert!(is_face(crate::windows::WORKSPACE));
        assert!(is_face(crate::windows::HOME));
        assert!(!is_face("floating-chat"));
        assert!(!is_face("files-1"));
    }

    fn sandbox(id: &str, icon: Option<&str>) -> Identity {
        Identity {
            sandbox: Some(id.into()),
            name: Some("Game".into()),
            icon: icon.map(Into::into),
        }
    }

    /// Each sandbox's button is its own, so a pin made from it is that sandbox's; without one the button is the app's,
    /// under an id no Start menu shortcut carries.
    #[test]
    fn each_sandbox_has_a_taskbar_button_of_its_own() {
        assert_eq!(
            taskbar_id("dev.intentic.desktop", &Identity::APP),
            "dev.intentic.desktop.window"
        );
        let id = taskbar_id("dev.intentic.desktop", &sandbox(&"x".repeat(64), None));
        assert_eq!(
            id,
            format!("dev.intentic.desktop.sandbox.{}", "x".repeat(64))
        );
        // The most an AppUserModelID may be.
        assert!(id.len() <= 128);
    }

    /// A pin opens the sandbox it was made in, through the link a shell opens one with.
    #[test]
    fn a_pin_opens_its_sandbox() {
        assert_eq!(relaunch_args(&Identity::APP), "");
        let args = relaunch_args(&sandbox("sbx_1", None));
        assert_eq!(launched_sandbox(args.trim()), Some("sbx_1".to_string()));
        assert_eq!(launched_sandbox("intentic://shell?open=device"), None);
        assert_eq!(launched_sandbox("--autostart"), None);
    }

    /// A logo is a file of its own per picture, since Windows caches an icon by its path and a pin keeps the path.
    #[test]
    fn each_logo_is_written_once_under_a_name_of_its_own() {
        let one = icon_file_name("sbx", b"one");
        assert_eq!(one, icon_file_name("sbx", b"one"));
        assert_ne!(one, icon_file_name("sbx", b"two"));
        assert_ne!(one, icon_file_name("other", b"one"));
        assert!(one.starts_with("sbx-") && one.ends_with(".ico"));
    }

    #[test]
    fn a_logo_becomes_an_icon_file_holding_its_png() {
        let png = include_bytes!("../icons/32x32.png");
        let ico = ico_of(png).expect("a PNG the page could have drawn");
        // Reserved, type 1 (icon), one image; 32 × 32 at 32 bits, its length, and its place right after the directory.
        assert_eq!(&ico[..6], &[0, 0, 1, 0, 1, 0]);
        assert_eq!(&ico[6..8], &[32, 32]);
        assert_eq!(
            u32::from_le_bytes(ico[14..18].try_into().unwrap()) as usize,
            png.len()
        );
        assert_eq!(u32::from_le_bytes(ico[18..22].try_into().unwrap()), 22);
        assert_eq!(&ico[22..], png);
        assert!(ico_of(b"not a png").is_err());
    }

    #[test]
    fn an_image_that_is_not_an_icon_is_not_put_up() {
        assert!(image_of(b"\x89PNG\r\n\x1a\nnot really").is_none());
        let icon = include_bytes!("../icons/32x32.png");
        let image = image_of(icon).expect("the app's own icon reads");
        assert_eq!((image.width(), image.height()), (32, 32));
        // Wider than any icon: the 512-pixel one the bundle carries.
        assert!(image_of(include_bytes!("../icons/icon.png")).is_none());
    }
}
