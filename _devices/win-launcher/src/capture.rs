/* THE SCREEN, READ WITHOUT A SCRIPT (2026-10-27). @intentic/desktop-automation captured a Windows screen with an inline
PowerShell script: Add-Type declaring SetProcessDpiAwarenessContext beside CopyFromScreen. That is the shape AMSI scores
as screen-grabbing malware, and on both of the owner's Windows machines Defender refused it, 54 times from 10-09 to 10-26
across `screenshot`, `ui_act` and `device` ("This script contains malicious content and has been blocked by your
antivirus software"). This binary is already on every Windows device, signed, beside the agent, so it does the same
GDI calls itself: no script for a scanner to read. The agent asks it first and keeps the script only as the fallback for
a launcher that predates this.

`--capture <out> [--region <x>,<y>,<width>,<height>]` writes the virtual desktop (or the region of it, in screenshot
pixels from its top-left) to `<out>` as `IRAW`, little-endian u32 width and height, then 4 bytes a pixel, rows top to
bottom, blue-green-red-unused: the agent encodes the PNG, which keeps an image library out of a download this small.
`--frame` prints the virtual desktop as `<width> <height> <left> <top>`. Both are per-monitor DPI aware, as the script
was, so a scaled monitor reads in physical pixels. */

use std::ffi::OsString;
#[cfg(any(windows, test))]
use std::path::PathBuf;

#[cfg(any(windows, test))]
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub struct Region {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[cfg(any(windows, test))]
#[derive(Debug, PartialEq, Eq)]
pub enum Ask {
    Capture {
        out: PathBuf,
        region: Option<Region>,
    },
    Frame,
}

#[cfg(any(windows, test))]
const USAGE: &str = "usage: intentic-launch --capture <out> [--region <x>,<y>,<width>,<height>] | intentic-launch --frame";

/// Whether this command line asks for the screen rather than a launch.
pub fn asked(argv: &[OsString]) -> bool {
    argv.first()
        .is_some_and(|first| first == "--capture" || first == "--frame")
}

#[cfg(any(windows, test))]
fn region_of(text: &str) -> Result<Region, String> {
    let parts: Vec<i32> = text
        .split(',')
        .map(|part| part.trim().parse::<i32>())
        .collect::<Result<_, _>>()
        .map_err(|_| format!("--region takes four whole numbers, x,y,width,height. {USAGE}"))?;
    match parts[..] {
        [x, y, width, height] if width > 0 && height > 0 => Ok(Region {
            x,
            y,
            width,
            height,
        }),
        _ => Err(format!(
            "--region takes x,y,width,height, with a width and height above zero. {USAGE}"
        )),
    }
}

/* The command line, minus argv[0], when `asked` is true. */
#[cfg(any(windows, test))]
pub fn parse(argv: Vec<OsString>) -> Result<Ask, String> {
    let mut rest = argv.into_iter();
    match rest.next() {
        Some(flag) if flag == "--frame" => match rest.next() {
            None => Ok(Ask::Frame),
            Some(_) => Err(format!("--frame takes nothing more. {USAGE}")),
        },
        Some(flag) if flag == "--capture" => {
            let out = rest
                .next()
                .filter(|out| !out.is_empty())
                .ok_or_else(|| format!("--capture needs the file to write. {USAGE}"))?;
            let region = match (rest.next(), rest.next()) {
                (None, _) => None,
                (Some(flag), Some(value)) if flag == "--region" => {
                    Some(region_of(&value.to_string_lossy())?)
                }
                _ => {
                    return Err(format!(
                        "after the file only --region is understood. {USAGE}"
                    ))
                }
            };
            match rest.next() {
                None => Ok(Ask::Capture {
                    out: PathBuf::from(out),
                    region,
                }),
                Some(_) => Err(format!("unexpected arguments after the region. {USAGE}")),
            }
        }
        _ => Err(USAGE.to_string()),
    }
}

/// The raw image file: magic, width, height, then the BGRX rows as GDI wrote them.
#[cfg(any(windows, test))]
pub fn raw_image(width: u32, height: u32, pixels: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(12 + pixels.len());
    out.extend_from_slice(b"IRAW");
    out.extend_from_slice(&width.to_le_bytes());
    out.extend_from_slice(&height.to_le_bytes());
    out.extend_from_slice(pixels);
    out
}

#[cfg(windows)]
mod gdi {
    use super::Region;
    use std::ffi::c_void;

    type Handle = *mut c_void;

    /// BITMAPINFOHEADER, field for field.
    #[repr(C)]
    struct InfoHeader {
        size: u32,
        width: i32,
        height: i32,
        planes: u16,
        bit_count: u16,
        compression: u32,
        size_image: u32,
        x_pels_per_meter: i32,
        y_pels_per_meter: i32,
        clr_used: u32,
        clr_important: u32,
    }

    /// BITMAPINFO with its one (unused) colour.
    #[repr(C)]
    struct Info {
        header: InfoHeader,
        colors: [u32; 1],
    }

    #[link(name = "user32")]
    extern "system" {
        fn SetProcessDpiAwarenessContext(value: isize) -> i32;
        fn GetSystemMetrics(index: i32) -> i32;
        fn GetDC(window: Handle) -> Handle;
        fn ReleaseDC(window: Handle, dc: Handle) -> i32;
    }

    #[link(name = "gdi32")]
    extern "system" {
        fn CreateCompatibleDC(dc: Handle) -> Handle;
        fn CreateDIBSection(
            dc: Handle,
            info: *const Info,
            usage: u32,
            bits: *mut *mut c_void,
            section: Handle,
            offset: u32,
        ) -> Handle;
        fn SelectObject(dc: Handle, object: Handle) -> Handle;
        fn BitBlt(
            dest: Handle,
            x: i32,
            y: i32,
            width: i32,
            height: i32,
            source: Handle,
            source_x: i32,
            source_y: i32,
            rop: u32,
        ) -> i32;
        fn DeleteObject(object: Handle) -> i32;
        fn DeleteDC(dc: Handle) -> i32;
    }

    const PER_MONITOR_AWARE_V2: isize = -4;
    const SM_XVIRTUALSCREEN: i32 = 76;
    const SM_YVIRTUALSCREEN: i32 = 77;
    const SM_CXVIRTUALSCREEN: i32 = 78;
    const SM_CYVIRTUALSCREEN: i32 = 79;
    const SRCCOPY: u32 = 0x00CC_0020;

    /// The virtual desktop in physical pixels: width, height, left, top. Left and top are negative with a monitor left
    /// of, or above, the primary.
    pub fn desktop() -> (i32, i32, i32, i32) {
        // SAFETY: argument-free metric reads; the awareness call only changes how this process is answered, and a
        // Windows older than 10 1703 refuses it and keeps answering unaware, as the script did.
        unsafe {
            SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2);
            (
                GetSystemMetrics(SM_CXVIRTUALSCREEN),
                GetSystemMetrics(SM_CYVIRTUALSCREEN),
                GetSystemMetrics(SM_XVIRTUALSCREEN),
                GetSystemMetrics(SM_YVIRTUALSCREEN),
            )
        }
    }

    /// The desktop, or `region` of it, as top-down BGRX rows: what CopyFromScreen copied, without the script.
    pub fn grab(region: Option<Region>) -> Result<(u32, u32, Vec<u8>), String> {
        let (desk_width, desk_height, left, top) = desktop();
        let area = region.unwrap_or(Region {
            x: 0,
            y: 0,
            width: desk_width,
            height: desk_height,
        });
        let (width, height) = (
            u32::try_from(area.width).map_err(|_| "the area to capture is empty".to_string())?,
            u32::try_from(area.height).map_err(|_| "the area to capture is empty".to_string())?,
        );
        if width == 0 || height == 0 {
            return Err("the area to capture is empty".to_string());
        }
        // SAFETY: GDI calls on handles made and released here; the section's bits are read only while it is alive,
        // and its size is the one asked for (32 bits a pixel, top-down).
        unsafe {
            let screen = GetDC(std::ptr::null_mut());
            if screen.is_null() {
                return Err(
                    "could not open the screen (GetDC): is anyone signed in on this PC?"
                        .to_string(),
                );
            }
            let memory = CreateCompatibleDC(screen);
            let info = Info {
                header: InfoHeader {
                    size: u32::try_from(std::mem::size_of::<InfoHeader>()).unwrap_or(40),
                    width: area.width,
                    // Negative: rows top to bottom, the order a PNG wants.
                    height: -area.height,
                    planes: 1,
                    bit_count: 32,
                    compression: 0,
                    size_image: 0,
                    x_pels_per_meter: 0,
                    y_pels_per_meter: 0,
                    clr_used: 0,
                    clr_important: 0,
                },
                colors: [0],
            };
            let mut bits: *mut c_void = std::ptr::null_mut();
            let section = CreateDIBSection(memory, &info, 0, &mut bits, std::ptr::null_mut(), 0);
            let result = if memory.is_null() || section.is_null() || bits.is_null() {
                Err("could not make a bitmap the size of the screen".to_string())
            } else {
                let previous = SelectObject(memory, section);
                let copied = BitBlt(
                    memory,
                    0,
                    0,
                    area.width,
                    area.height,
                    screen,
                    left + area.x,
                    top + area.y,
                    SRCCOPY,
                );
                let pixels = if copied == 0 {
                    Err("could not copy the screen (BitBlt): the desktop may be locked or on the secure desktop".to_string())
                } else {
                    let length = (width as usize) * (height as usize) * 4;
                    Ok(std::slice::from_raw_parts(bits.cast::<u8>(), length).to_vec())
                };
                SelectObject(memory, previous);
                pixels
            };
            if !section.is_null() {
                DeleteObject(section);
            }
            if !memory.is_null() {
                DeleteDC(memory);
            }
            ReleaseDC(std::ptr::null_mut(), screen);
            result.map(|pixels| (width, height, pixels))
        }
    }
}

/* Answers the ask; any failure goes to stderr, which the agent carries into its own message. */
#[cfg(windows)]
pub fn main(argv: Vec<OsString>) -> std::process::ExitCode {
    use std::io::Write;
    use std::process::ExitCode;
    match parse(argv) {
        Err(why) => {
            eprintln!("{why}");
            ExitCode::FAILURE
        }
        Ok(Ask::Frame) => {
            let (width, height, left, top) = gdi::desktop();
            let _ = writeln!(std::io::stdout(), "{width} {height} {left} {top}");
            ExitCode::SUCCESS
        }
        Ok(Ask::Capture { out, region }) => match gdi::grab(region) {
            Ok((width, height, pixels)) => {
                match std::fs::write(&out, raw_image(width, height, &pixels)) {
                    Ok(()) => ExitCode::SUCCESS,
                    Err(why) => {
                        eprintln!("could not write {}: {why}", out.display());
                        ExitCode::FAILURE
                    }
                }
            }
            Err(why) => {
                eprintln!("{why}");
                ExitCode::FAILURE
            }
        },
    }
}

#[cfg(test)]
mod tests {
    use super::{asked, parse, raw_image, Ask, Region};
    use std::ffi::OsString;
    use std::path::PathBuf;

    fn argv(parts: &[&str]) -> Vec<OsString> {
        parts.iter().map(OsString::from).collect()
    }

    #[test]
    fn only_the_screen_flags_are_screen_asks() {
        assert!(asked(&argv(&["--capture", "C:\\t\\a.raw"])));
        assert!(asked(&argv(&["--frame"])));
        assert!(!asked(&argv(&[
            "--log",
            "x.log",
            "--",
            "agent",
            "--capture"
        ])));
    }

    #[test]
    fn takes_the_file_and_an_optional_region() {
        assert_eq!(
            parse(argv(&["--capture", "C:\\t\\a.raw"])).unwrap(),
            Ask::Capture {
                out: PathBuf::from("C:\\t\\a.raw"),
                region: None
            }
        );
        assert_eq!(
            parse(argv(&["--capture", "a.raw", "--region", "-10,20,300,400"])).unwrap(),
            Ask::Capture {
                out: PathBuf::from("a.raw"),
                region: Some(Region {
                    x: -10,
                    y: 20,
                    width: 300,
                    height: 400
                })
            }
        );
        assert_eq!(parse(argv(&["--frame"])).unwrap(), Ask::Frame);
    }

    #[test]
    fn refuses_what_it_cannot_capture() {
        assert!(parse(argv(&["--capture"])).is_err());
        assert!(parse(argv(&["--capture", "a.raw", "--region", "1,2,0,4"])).is_err());
        assert!(parse(argv(&["--capture", "a.raw", "--region", "1,2,3"])).is_err());
        assert!(parse(argv(&["--capture", "a.raw", "--region"])).is_err());
        assert!(parse(argv(&["--frame", "extra"])).is_err());
    }

    #[test]
    fn the_raw_file_is_magic_size_then_rows() {
        let raw = raw_image(2, 1, &[1, 2, 3, 0, 4, 5, 6, 0]);
        assert_eq!(&raw[..4], b"IRAW");
        assert_eq!(u32::from_le_bytes(raw[4..8].try_into().unwrap()), 2);
        assert_eq!(u32::from_le_bytes(raw[8..12].try_into().unwrap()), 1);
        assert_eq!(&raw[12..], &[1, 2, 3, 0, 4, 5, 6, 0]);
    }
}
