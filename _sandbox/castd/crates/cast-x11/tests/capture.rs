//! cast-x11's capture against a real X server, with nothing but this test drawing on it: XDamage reports what the
//! test filled, and the pixels come back the same whichever way they are read: in place from Xvfb's `-shmem`
//! framebuffer, with MIT-SHM GetImage (how a person's own Xorg `:0` is read), and with plain GetImage (a server that
//! cannot share memory). Then RandR resizes the screen and the capture sees it must be rebuilt. Needs Xvfb, and stands
//! down with its reason without it (`CASTD_TEST_XVFB`).

use cast_core::capture::{Capture, ScreenSource};
use cast_core::geometry::{Band, Rect};
use cast_core::wake::wait_any;
use cast_x11::X11Screen;
use cast_x11::capture::Capturer;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{ChangeGCAux, ConnectionExt as _, CreateGCAux, Rectangle};
use x11rb::wrapper::ConnectionExt as _;

/// An Xvfb that dies with the test.
struct Xvfb(Child, String);

impl Drop for Xvfb {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn xvfb_binary() -> Option<PathBuf> {
    let p =
        PathBuf::from(std::env::var("CASTD_TEST_XVFB").unwrap_or_else(|_| "/usr/bin/Xvfb".into()));
    p.exists().then_some(p)
}

/// An Xvfb on a free display of `range` (each test its own, as they run side by side), 320x240 at depth 24, its
/// framebuffer in shared memory when `shmem`.
fn xvfb(bin: &Path, mut range: std::ops::Range<u32>, shmem: bool) -> Xvfb {
    let n = range
        .find(|n| {
            !Path::new(&format!("/tmp/.X{n}-lock")).exists()
                && !Path::new(&format!("/tmp/.X11-unix/X{n}")).exists()
        })
        .expect("a free display");
    let mut cmd = Command::new(bin);
    cmd.arg(format!(":{n}"))
        .args(["-screen", "0", "320x240x24", "-nolisten", "tcp"]);
    if shmem {
        cmd.arg("-shmem");
    }
    let mut child = cmd
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("Xvfb starts");
    let display = format!(":{n}");
    let until = Instant::now() + Duration::from_secs(10);
    while x11rb::rust_connection::RustConnection::connect(Some(&display)).is_err() {
        assert!(Instant::now() < until, "Xvfb {display} did not come up");
        std::thread::sleep(Duration::from_millis(20));
    }
    // The server answering is this one, not another that took the display first.
    assert!(
        child.try_wait().unwrap().is_none(),
        "Xvfb {display} exited: the display was taken"
    );
    Xvfb(child, display)
}

/// Fills `r` of the root window with `rgb`, as a client drawing on the screen would.
fn fill(display: &str, r: Rect, rgb: u32) {
    let (conn, n) = x11rb::rust_connection::RustConnection::connect(Some(display)).unwrap();
    let root = conn.setup().roots[n].root;
    let gc = conn.generate_id().unwrap();
    conn.create_gc(gc, root, &CreateGCAux::new().foreground(rgb))
        .unwrap();
    conn.change_gc(
        gc,
        &ChangeGCAux::new()
            .subwindow_mode(x11rb::protocol::xproto::SubwindowMode::INCLUDE_INFERIORS),
    )
    .unwrap();
    conn.poly_fill_rectangle(
        root,
        gc,
        &[Rectangle {
            x: r.x as i16,
            y: r.y as i16,
            width: r.w as u16,
            height: r.h as u16,
        }],
    )
    .unwrap();
    conn.sync().unwrap();
}

/// Pumps the capture until its damage covers `r`, then grabs the damaged rows.
fn damage_covering(cap: &mut dyn Capture, r: Rect) -> Band {
    let until = Instant::now() + Duration::from_secs(5);
    loop {
        cap.pump().unwrap();
        let covered =
            cap.damage().changes.iter().any(|&(x0, y0, x1, y1)| {
                x0 <= r.x && y0 <= r.y && x1 >= r.x + r.w && y1 >= r.y + r.h
            });
        if covered {
            let band = cap.damage().take_band().expect("a damaged band");
            cap.grab(band).unwrap();
            return band;
        }
        assert!(Instant::now() < until, "no damage for {r:?} within 5 s");
        if let Some(w) = cap.waitable() {
            wait_any(&[w], 50);
        }
    }
}

/// The BGRX pixel at (x, y) of what the capture holds.
fn pixel(cap: &dyn Capture, x: u32, y: u32) -> [u8; 4] {
    let (px, stride) = cap.pixels().expect("pixels in memory");
    let at = y as usize * stride + x as usize * 4;
    px[at..at + 4].try_into().unwrap()
}

/// Draws, captures and compares, on a capture made by `open`.
fn check(display: &str, mut cap: Box<dyn Capture>, what: &str) {
    assert_eq!((cap.area().w, cap.area().h), (320, 240), "{what}");
    let r = Rect {
        x: 40,
        y: 50,
        w: 64,
        h: 32,
    };
    fill(display, r, 0x00c0_2010);
    let band = damage_covering(cap.as_mut(), r);
    assert!(band.y0 <= r.y && band.y1 >= r.y + r.h, "{what}: {band:?}");
    // BGRX: blue, green, red.
    assert_eq!(
        &pixel(cap.as_ref(), 41, 51)[..3],
        &[0x10, 0x20, 0xc0],
        "{what}: inside"
    );
    assert_ne!(
        &pixel(cap.as_ref(), 39, 51)[..3],
        &[0x10, 0x20, 0xc0],
        "{what}: outside"
    );
    // The exact copy a local viewer gets, and the screenshot, show the same.
    let copy = cap.region(r).unwrap();
    assert_eq!(copy.len(), 64 * 32 * 4, "{what}");
    assert!(
        copy.chunks(4).all(|p| p[..3] == [0x10, 0x20, 0xc0]),
        "{what}: region"
    );
    let shot = cap.snapshot().unwrap();
    let at = (60 * 320 + 50) * 4;
    assert_eq!(&shot[at..at + 3], &[0x10, 0x20, 0xc0], "{what}: snapshot");
}

#[test]
fn a_real_x_server_is_captured_in_place_with_mit_shm_and_with_plain_getimage() {
    let Some(bin) = xvfb_binary() else {
        eprintln!("cast-x11 capture test stands down: needs Xvfb (CASTD_TEST_XVFB)");
        return;
    };
    let fb = xvfb(&bin, 300..350, true);
    let direct = Capturer::open(Some(&fb.1), None, true).unwrap();
    assert!(direct.direct, "Xvfb -shmem's framebuffer was not found");
    check(&fb.1, Box::new(direct), "in place");

    let plain_server = xvfb(&bin, 300..350, false);
    let shm = Capturer::open(Some(&plain_server.1), None, true).unwrap();
    assert!(!shm.direct && shm.shared, "MIT-SHM GetImage expected");
    check(&plain_server.1, Box::new(shm), "MIT-SHM");
    let plain = Capturer::open(Some(&plain_server.1), None, false).unwrap();
    assert!(!plain.direct && !plain.shared, "plain GetImage expected");
    check(&plain_server.1, Box::new(plain), "plain GetImage");
}

#[test]
fn randr_resizes_the_screen_and_the_capture_sees_it() {
    let Some(bin) = xvfb_binary() else {
        eprintln!("cast-x11 resize test stands down: needs Xvfb (CASTD_TEST_XVFB)");
        return;
    };
    let x = xvfb(&bin, 350..400, false);
    let randr = cast_x11::screen::Screen::open(Some(&x.1), None).unwrap();
    let mut screen = X11Screen::new(Some(x.1.clone()), Some(randr));
    assert_eq!(screen.resize_limits().map(|(_, max)| max), Some((320, 240)));
    let mut cap = screen.open(None).unwrap();
    assert!(!cap.needs_rebuild());
    screen.resize(200, 160).unwrap();
    let until = Instant::now() + Duration::from_secs(5);
    while !cap.needs_rebuild() {
        cap.pump().unwrap();
        assert!(
            Instant::now() < until,
            "the capture never heard of the resize"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    let cap = screen.open(None).unwrap();
    assert_eq!(
        (cap.area().w, cap.area().h, cap.screen()),
        (200, 160, (200, 160))
    );
    // A crop of the new screen is a capture of its own.
    let crop = screen
        .open(Some(Rect {
            x: 10,
            y: 20,
            w: 101,
            h: 64,
        }))
        .unwrap();
    assert_eq!(
        (crop.area(), crop.cropped()),
        (
            Rect {
                x: 10,
                y: 20,
                w: 100,
                h: 64
            },
            true
        )
    );
}
