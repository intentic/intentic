/* The menu entry: what Explorer shows, and what it does when picked. */
use std::ffi::c_void;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};

use windows::Win32::Foundation::{
    CLASS_E_CLASSNOTAVAILABLE, CLASS_E_NOAGGREGATION, E_NOTIMPL, E_POINTER, HMODULE,
};
use windows::Win32::System::Com::{CoTaskMemFree, IBindCtx, IClassFactory, IClassFactory_Impl};
use windows::Win32::System::LibraryLoader::GetModuleFileNameW;
use windows::Win32::UI::Shell::{
    IEnumExplorerCommand, IExplorerCommand, IExplorerCommand_Impl, IShellItemArray, SHStrDupW,
    ECF_DEFAULT, ECS_ENABLED, SIGDN_FILESYSPATH,
};
use windows_core::{
    implement, IUnknown, Interface, Ref, Result, BOOL, GUID, HRESULT, HSTRING, PWSTR,
};

/// The class the package manifest names (AppxManifest.xml `com:Class` and every `desktop5:Verb`).
pub const CLSID: GUID = GUID::from_u128(0x36429087_24a5_49c9_892f_91db79a64196);

/// The app this entry starts, beside this DLL in the install folder: tauri names it after the Cargo package
/// (src-tauri/Cargo.toml `intentic-desktop`), and the NSIS hooks call it `${MAINBINARYNAME}.exe`.
const APP: &str = "intentic-desktop.exe";

const TITLE: &str = "Open with Intentic";

/// Objects alive in this process, for DllCanUnloadNow: the surrogate unloads the DLL once Explorer lets go of them.
static LIVE: AtomicUsize = AtomicUsize::new(0);

pub fn in_use() -> bool {
    LIVE.load(Ordering::SeqCst) > 0
}

pub unsafe fn class_object(clsid: *const GUID, iid: *const GUID, out: *mut *mut c_void) -> HRESULT {
    if out.is_null() || clsid.is_null() || iid.is_null() {
        return E_POINTER;
    }
    *out = std::ptr::null_mut();
    if *clsid != CLSID {
        return CLASS_E_CLASSNOTAVAILABLE;
    }
    let factory: IClassFactory = Factory::new().into();
    factory.query(iid, out)
}

#[implement(IClassFactory)]
struct Factory;

impl Factory {
    fn new() -> Self {
        LIVE.fetch_add(1, Ordering::SeqCst);
        Factory
    }
}

impl Drop for Factory {
    fn drop(&mut self) {
        LIVE.fetch_sub(1, Ordering::SeqCst);
    }
}

impl IClassFactory_Impl for Factory_Impl {
    fn CreateInstance(
        &self,
        outer: Ref<'_, IUnknown>,
        iid: *const GUID,
        out: *mut *mut c_void,
    ) -> Result<()> {
        if out.is_null() || iid.is_null() {
            return Err(E_POINTER.into());
        }
        unsafe { *out = std::ptr::null_mut() };
        if outer.is_some() {
            return Err(CLASS_E_NOAGGREGATION.into());
        }
        let command: IExplorerCommand = OpenWithIntentic::new().into();
        unsafe { command.query(iid, out) }.ok()
    }

    fn LockServer(&self, lock: BOOL) -> Result<()> {
        if lock.as_bool() {
            LIVE.fetch_add(1, Ordering::SeqCst);
        } else {
            LIVE.fetch_sub(1, Ordering::SeqCst);
        }
        Ok(())
    }
}

#[implement(IExplorerCommand)]
struct OpenWithIntentic;

impl OpenWithIntentic {
    fn new() -> Self {
        LIVE.fetch_add(1, Ordering::SeqCst);
        OpenWithIntentic
    }
}

impl Drop for OpenWithIntentic {
    fn drop(&mut self) {
        LIVE.fetch_sub(1, Ordering::SeqCst);
    }
}

impl IExplorerCommand_Impl for OpenWithIntentic_Impl {
    fn GetTitle(&self, _items: Ref<'_, IShellItemArray>) -> Result<PWSTR> {
        unsafe { SHStrDupW(&HSTRING::from(TITLE)) }
    }

    /// The app's own icon, the one its window and the taskbar show.
    fn GetIcon(&self, _items: Ref<'_, IShellItemArray>) -> Result<PWSTR> {
        let app = app_path().ok_or_else(|| windows_core::Error::from(E_NOTIMPL))?;
        unsafe { SHStrDupW(&HSTRING::from(format!("{},0", app.display()))) }
    }

    fn GetToolTip(&self, _items: Ref<'_, IShellItemArray>) -> Result<PWSTR> {
        Err(E_NOTIMPL.into())
    }

    fn GetCanonicalName(&self) -> Result<GUID> {
        Ok(CLSID)
    }

    fn GetState(&self, _items: Ref<'_, IShellItemArray>, _ok_to_be_slow: BOOL) -> Result<u32> {
        Ok(ECS_ENABLED.0 as u32)
    }

    /// Every picked item's path to one launch of the app, which opens each in a window of its own (src-tauri/src/local.rs
    /// `open_args`), or hands them to the copy already running (the single-instance plugin). On the empty space of a
    /// folder Explorer passes the folder itself. std quotes each argument the way the app's runtime splits them, so a
    /// drive root arrives as `E:\` here rather than as the `E:"` the classic verb's `"%V"` produces.
    fn Invoke(&self, items: Ref<'_, IShellItemArray>, _context: Ref<'_, IBindCtx>) -> Result<()> {
        let items = items.ok()?;
        let mut paths = Vec::new();
        unsafe {
            for index in 0..items.GetCount()? {
                let item = items.GetItemAt(index)?;
                // Items with no path on disk (a library, a phone, a search result's container) are skipped: the app
                // opens folders and files, and nothing else could be handed to it.
                if let Ok(path) = item.GetDisplayName(SIGDN_FILESYSPATH) {
                    paths.push(path.to_string().unwrap_or_default());
                    CoTaskMemFree(Some(path.0 as *const c_void));
                }
            }
        }
        paths.retain(|path| !path.is_empty());
        if paths.is_empty() {
            return Ok(());
        }
        let app = app_path().ok_or_else(|| windows_core::Error::from(E_NOTIMPL))?;
        Command::new(app)
            .args(&paths)
            .spawn()
            .map(drop)
            .map_err(windows_core::Error::from)
    }

    fn GetFlags(&self) -> Result<u32> {
        Ok(ECF_DEFAULT.0 as u32)
    }

    fn EnumSubCommands(&self) -> Result<IEnumExplorerCommand> {
        Err(E_NOTIMPL.into())
    }
}

/// This DLL's own path.
pub fn dll_path() -> Option<PathBuf> {
    let module = crate::MODULE.load(Ordering::SeqCst);
    if module.is_null() {
        return None;
    }
    let mut buffer = vec![0u16; 32_768];
    let length = unsafe { GetModuleFileNameW(Some(HMODULE(module)), &mut buffer) } as usize;
    if length == 0 || length >= buffer.len() {
        return None;
    }
    Some(PathBuf::from(String::from_utf16_lossy(&buffer[..length])))
}

/// The folder this DLL was loaded from: the app's install folder, where the package's external location points.
pub fn install_dir() -> Option<PathBuf> {
    dll_path()?.parent().map(PathBuf::from)
}

pub fn app_path() -> Option<PathBuf> {
    install_dir().map(|dir| dir.join(APP))
}
