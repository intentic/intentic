//! The monitors attached to the desktop, as DXGI enumerates them (the adapter each one is on, its output) joined with
//! what the display configuration says about it (the monitor's own name, its EDID and its connector). A monitor's id is
//! a hash of its EDID's manufacturer and product, its connector's kind and instance and its target id: it stays the same
//! across reboots, a change of resolution or arrangement, and another monitor being plugged in, where `\\.\DISPLAYn`
//! numbers do not.

use windows::Win32::Devices::Display::{
    DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME, DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME,
    DISPLAYCONFIG_MODE_INFO, DISPLAYCONFIG_OUTPUT_TECHNOLOGY_INTERNAL, DISPLAYCONFIG_PATH_INFO,
    DISPLAYCONFIG_SOURCE_DEVICE_NAME, DISPLAYCONFIG_TARGET_DEVICE_NAME, DisplayConfigGetDeviceInfo,
    GetDisplayConfigBufferSizes, QDC_ONLY_ACTIVE_PATHS, QueryDisplayConfig,
};
use windows::Win32::Foundation::{ERROR_SUCCESS, RECT};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, DXGI_ADAPTER_DESC1, DXGI_OUTPUT_DESC, IDXGIAdapter1, IDXGIFactory1,
    IDXGIOutput,
};
use windows::Win32::Graphics::Gdi::HMONITOR;
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};

/// PCI vendor ids of the adapters whose encoders cast-win drives.
pub const NVIDIA: u32 = 0x10de;
pub const INTEL: u32 = 0x8086;
pub const AMD: u32 = 0x1002;

/// One monitor attached to the desktop.
#[derive(Clone)]
pub struct Display {
    /// Stable: a hash of the monitor's EDID and connector (else of its GDI name), 10 hex digits.
    pub id: String,
    /// The monitor's own name (`DELL U2720Q`), else its GDI name.
    pub name: String,
    /// `\\.\DISPLAY1`: what GDI and the display configuration call its source.
    pub gdi: String,
    /// Where it sits on the virtual desktop, in physical pixels (the process is per-monitor DPI aware).
    pub rect: RECT,
    /// Effective DPI over 96: 1.5 at 150%.
    pub scale: f64,
    pub primary: bool,
    pub monitor: HMONITOR,
    pub output: IDXGIOutput,
    pub adapter: Adapter,
}

// The DXGI objects are free-threaded.
unsafe impl Send for Display {}
unsafe impl Sync for Display {}

impl Display {
    pub fn width(&self) -> u32 {
        (self.rect.right - self.rect.left).max(0) as u32
    }

    pub fn height(&self) -> u32 {
        (self.rect.bottom - self.rect.top).max(0) as u32
    }
}

/// A display adapter (GPU), as DXGI names it.
#[derive(Clone)]
pub struct Adapter {
    pub adapter: IDXGIAdapter1,
    pub name: String,
    pub vendor: u32,
    /// The adapter's LUID, which tells two adapter objects for the same GPU apart from two GPUs.
    pub luid: i64,
    /// Microsoft's Basic Render Driver (WARP): no encoder behind it.
    pub software: bool,
}

unsafe impl Send for Adapter {}
unsafe impl Sync for Adapter {}

impl Adapter {
    fn from(adapter: IDXGIAdapter1, desc: &DXGI_ADAPTER_DESC1) -> Adapter {
        Adapter {
            adapter,
            name: from_wide(&desc.Description),
            vendor: desc.VendorId,
            luid: ((desc.AdapterLuid.HighPart as i64) << 32) | desc.AdapterLuid.LowPart as i64,
            // DXGI_ADAPTER_FLAG_SOFTWARE
            software: desc.Flags & 2 != 0,
        }
    }

    pub fn is_nvidia(&self) -> bool {
        self.vendor == NVIDIA
    }
}

/// Text from a zero-terminated (or full) UTF-16 buffer.
pub fn from_wide(s: &[u16]) -> String {
    let len = s.iter().position(|&c| c == 0).unwrap_or(s.len());
    String::from_utf16_lossy(&s[..len])
}

/// UTF-16 with a terminating zero, for wide-string APIs.
pub fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain([0]).collect()
}

/// Every hardware adapter, in DXGI's order (the one the desktop prefers first).
pub fn adapters() -> Vec<Adapter> {
    let mut out = Vec::new();
    // SAFETY: plain factory creation.
    let Ok(factory) = (unsafe { CreateDXGIFactory1::<IDXGIFactory1>() }) else {
        return out;
    };
    let mut i = 0;
    // SAFETY: enumeration until DXGI says there are no more.
    while let Ok(adapter) = unsafe { factory.EnumAdapters1(i) } {
        i += 1;
        if let Ok(desc) = unsafe { adapter.GetDesc1() } {
            let a = Adapter::from(adapter, &desc);
            if !a.software {
                out.push(a);
            }
        }
    }
    out
}

/// Every monitor attached to the desktop, the primary first, then left to right and top to bottom.
pub fn displays() -> Vec<Display> {
    let names = config_names();
    let mut out: Vec<Display> = Vec::new();
    // SAFETY: plain factory creation.
    let Ok(factory) = (unsafe { CreateDXGIFactory1::<IDXGIFactory1>() }) else {
        return out;
    };
    let mut a = 0;
    while let Ok(adapter) = unsafe { factory.EnumAdapters1(a) } {
        a += 1;
        let Ok(adesc) = (unsafe { adapter.GetDesc1() }) else {
            continue;
        };
        let info = Adapter::from(adapter.clone(), &adesc);
        let mut o = 0;
        while let Ok(output) = unsafe { adapter.EnumOutputs(o) } {
            o += 1;
            let Ok(desc) = (unsafe { output.GetDesc() }) else {
                continue;
            };
            if !desc.AttachedToDesktop.as_bool() {
                continue;
            }
            let gdi = from_wide(&desc.DeviceName);
            // The same output can be listed under two adapters on a hybrid laptop; the first (the one the desktop
            // renders on, in DXGI's order) keeps it.
            if out.iter().any(|d| d.gdi == gdi) {
                continue;
            }
            let named = names.iter().find(|n| n.gdi == gdi);
            let key = named.map_or(gdi.as_str(), |n| n.stable.as_str());
            out.push(Display {
                id: id_of(key),
                name: match named {
                    Some(n) if !n.friendly.is_empty() => n.friendly.clone(),
                    Some(n) if n.internal => "Built-in display".to_string(),
                    _ => gdi.clone(),
                },
                rect: desc.DesktopCoordinates,
                scale: scale_of(&desc),
                primary: desc.DesktopCoordinates.left == 0 && desc.DesktopCoordinates.top == 0,
                monitor: desc.Monitor,
                gdi,
                output,
                adapter: info.clone(),
            });
        }
    }
    out.sort_by_key(|d| (!d.primary, d.rect.top, d.rect.left));
    out
}

/// The monitor with this id, if it is still attached.
pub fn find(id: &str) -> Option<Display> {
    displays().into_iter().find(|d| d.id == id)
}

fn scale_of(desc: &DXGI_OUTPUT_DESC) -> f64 {
    let (mut x, mut y) = (96u32, 96u32);
    // SAFETY: a monitor handle DXGI just gave out, and two numbers to fill.
    match unsafe { GetDpiForMonitor(desc.Monitor, MDT_EFFECTIVE_DPI, &mut x, &mut y) } {
        Ok(()) if x > 0 => x as f64 / 96.0,
        _ => 1.0,
    }
}

/// 10 hex digits of FNV-1a over the key: short enough for a session name, stable for the same monitor and port.
pub fn id_of(path: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in path.to_ascii_lowercase().bytes() {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{:010x}", h & 0xff_ffff_ffff)
}

/// What the display configuration says about each active source: (GDI name, monitor name, device path), for a probe.
pub fn config() -> Vec<(String, String, String)> {
    config_names()
        .into_iter()
        .map(|n| (n.gdi, n.friendly, format!("{} {}", n.stable, n.path)))
        .collect()
}

/// What the display configuration says about one active source.
struct ConfigName {
    gdi: String,
    friendly: String,
    path: String,
    /// What names the monitor and the connector it is on: the EDID's manufacturer and product, the connector's kind
    /// and instance, and the target's id on its adapter. Not the device path, which Windows sometimes leaves empty
    /// (seen on rog, 2026-11-20: present on one run, empty on the next).
    stable: String,
    /// A laptop's own panel.
    internal: bool,
}

fn config_names() -> Vec<ConfigName> {
    let mut out = Vec::new();
    let (mut np, mut nm) = (0u32, 0u32);
    // SAFETY: two counts to fill.
    if unsafe { GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut np, &mut nm) }
        != ERROR_SUCCESS
    {
        return out;
    }
    let mut paths = vec![DISPLAYCONFIG_PATH_INFO::default(); np as usize];
    let mut modes = vec![DISPLAYCONFIG_MODE_INFO::default(); nm as usize];
    // SAFETY: buffers of the sizes just asked for, and their counts.
    if unsafe {
        QueryDisplayConfig(
            QDC_ONLY_ACTIVE_PATHS,
            &mut np,
            paths.as_mut_ptr(),
            &mut nm,
            modes.as_mut_ptr(),
            None,
        )
    } != ERROR_SUCCESS
    {
        return out;
    }
    for p in &paths[..np as usize] {
        let mut source = DISPLAYCONFIG_SOURCE_DEVICE_NAME::default();
        source.header.r#type = DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME;
        source.header.size = std::mem::size_of::<DISPLAYCONFIG_SOURCE_DEVICE_NAME>() as u32;
        source.header.adapterId = p.sourceInfo.adapterId;
        source.header.id = p.sourceInfo.id;
        let mut target = DISPLAYCONFIG_TARGET_DEVICE_NAME::default();
        target.header.r#type = DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME;
        target.header.size = std::mem::size_of::<DISPLAYCONFIG_TARGET_DEVICE_NAME>() as u32;
        target.header.adapterId = p.targetInfo.adapterId;
        target.header.id = p.targetInfo.id;
        // SAFETY: headers sized for the structs they head.
        let ok = unsafe {
            DisplayConfigGetDeviceInfo(&mut source.header) == 0
                && DisplayConfigGetDeviceInfo(&mut target.header) == 0
        };
        if ok {
            out.push(ConfigName {
                gdi: from_wide(&source.viewGdiDeviceName),
                friendly: from_wide(&target.monitorFriendlyDeviceName),
                path: from_wide(&target.monitorDevicePath),
                stable: format!(
                    "{:04x}:{:04x}:{}:{}:{}",
                    target.edidManufactureId,
                    target.edidProductCodeId,
                    target.outputTechnology.0,
                    target.connectorInstance,
                    p.targetInfo.id
                ),
                internal: target.outputTechnology == DISPLAYCONFIG_OUTPUT_TECHNOLOGY_INTERNAL,
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_id_is_stable_short_and_case_blind() {
        let a = id_of("e509:0CE4:-2147483648:0:8388688");
        assert_eq!(a.len(), 10);
        assert_eq!(a, id_of("e509:0ce4:-2147483648:0:8388688"));
        assert_ne!(a, id_of(r"\\.\DISPLAY1"));
    }
}
