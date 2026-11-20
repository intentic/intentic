//! The X cursor's shape and two-way clipboard, on an X connection of their own (voxl's, extended to HTML and to
//! PRIMARY). Setting the clipboard takes CLIPBOARD (and PRIMARY, for text) and answers once the server has registered
//! castd as owner, so a Ctrl+V injected right after pastes the new contents. A copy in the window (any other owner)
//! is fetched in every format castd carries and sent to the viewers (`Hub::clipboard_changed`); the cursor goes to
//! `Hub::set_cursor`.

use cast_core::clipboard::{ClipContent, MAX_IMAGE};
use cast_core::hub::Hub;
use nix::poll::{PollFd, PollFlags, poll};
use nix::unistd::{read, write};
use std::os::fd::{AsFd, OwnedFd};
use std::sync::Arc;
use std::sync::mpsc;
use x11rb::connection::Connection;
use x11rb::protocol::Event;
use x11rb::protocol::xfixes::{self, ConnectionExt as _};
use x11rb::protocol::xproto::{
    self, AtomEnum, ConnectionExt as _, EventMask, PropMode, WindowClass,
};
use x11rb::rust_connection::RustConnection;
use x11rb::wrapper::ConnectionExt as _;

/// Sets the remote clipboard and returns once the X server has registered castd as owner.
#[derive(Clone)]
pub struct ClipboardHandle {
    tx: mpsc::Sender<(ClipContent, mpsc::SyncSender<()>)>,
    wake_w: Arc<OwnedFd>,
}

impl ClipboardHandle {
    pub fn set_blocking(&self, content: ClipContent) {
        let (done_tx, done_rx) = mpsc::sync_channel(1);
        if self.tx.send((content, done_tx)).is_ok() {
            let _ = write(&*self.wake_w, &[1u8]);
            let _ = done_rx.recv_timeout(std::time::Duration::from_millis(300));
        }
    }
}

struct Atoms {
    clipboard: u32,
    primary: u32,
    targets: u32,
    timestamp: u32,
    utf8: u32,
    text: u32,
    text_plain: u32,
    text_plain_utf8: u32,
    html: u32,
    png: u32,
    incr: u32,
    prop: u32,
}

impl Atoms {
    fn text_targets(&self) -> [u32; 5] {
        [
            self.utf8,
            self.text_plain_utf8,
            self.text_plain,
            self.text,
            u32::from(AtomEnum::STRING),
        ]
    }
}

fn atom(c: &RustConnection, name: &str) -> Result<u32, String> {
    Ok(c.intern_atom(false, name.as_bytes())
        .map_err(|e| e.to_string())?
        .reply()
        .map_err(|e| e.to_string())?
        .atom)
}

/// A copy in the window being read: the format asked for now, those still to ask for, and what came so far.
struct Fetch {
    current: Option<u32>,
    queue: Vec<u32>,
    got: ClipContent,
    /// An INCR transfer of the current target: its bytes so far.
    incr: Option<Vec<u8>>,
}

pub fn spawn(display: Option<String>, hub: Arc<Hub>) -> Result<ClipboardHandle, String> {
    let (conn, n) = RustConnection::connect(display.as_deref()).map_err(|e| e.to_string())?;
    let root = conn.setup().roots[n].root;
    conn.xfixes_query_version(5, 0)
        .map_err(|e| e.to_string())?
        .reply()
        .map_err(|e| e.to_string())?;
    let win = conn.generate_id().map_err(|e| e.to_string())?;
    conn.create_window(
        0,
        win,
        root,
        -10,
        -10,
        1,
        1,
        0,
        WindowClass::INPUT_ONLY,
        0,
        &xproto::CreateWindowAux::new().event_mask(EventMask::PROPERTY_CHANGE),
    )
    .map_err(|e| e.to_string())?;
    let atoms = Atoms {
        clipboard: atom(&conn, "CLIPBOARD")?,
        primary: u32::from(AtomEnum::PRIMARY),
        targets: atom(&conn, "TARGETS")?,
        timestamp: atom(&conn, "TIMESTAMP")?,
        utf8: atom(&conn, "UTF8_STRING")?,
        text: atom(&conn, "TEXT")?,
        text_plain: atom(&conn, "text/plain")?,
        text_plain_utf8: atom(&conn, "text/plain;charset=utf-8")?,
        html: atom(&conn, "text/html")?,
        png: atom(&conn, "image/png")?,
        incr: atom(&conn, "INCR")?,
        prop: atom(&conn, "CASTD_CLIP")?,
    };
    conn.xfixes_select_cursor_input(root, xfixes::CursorNotifyMask::DISPLAY_CURSOR)
        .map_err(|e| e.to_string())?;
    // Viewers draw the cursor themselves. Xvfb's software cursor is painted into the framebuffer castd reads, which
    // would show a second, lagging cursor and turn every pointer move into an encode, so hide it while connected.
    conn.xfixes_hide_cursor(root).map_err(|e| e.to_string())?;
    conn.xfixes_select_selection_input(
        root,
        atoms.clipboard,
        xfixes::SelectionEventMask::SET_SELECTION_OWNER,
    )
    .map_err(|e| e.to_string())?;
    conn.flush().map_err(|e| e.to_string())?;
    let (tx, rx) = mpsc::channel::<(ClipContent, mpsc::SyncSender<()>)>();
    let (wake_r, wake_w) = cast_core::wake::wake_pipe().map_err(|e| e.to_string())?;
    let wake_w = Arc::new(wake_w);
    std::thread::Builder::new()
        .name("desktop".into())
        .spawn(move || {
            let mut owned: Option<ClipContent> = None;
            // What the viewers were last sent or last set, so neither side's copy comes back as a change.
            let mut last: Option<ClipContent> = None;
            let mut fetch: Option<Fetch> = None;
            let mut cursor_serial = None;
            send_cursor(&conn, &hub, &mut cursor_serial);
            loop {
                let mut drain = [0u8; 64];
                while matches!(read(&wake_r, &mut drain), Ok(n) if n > 0) {}
                while let Ok((content, done)) = rx.try_recv() {
                    last = Some(content.clone());
                    let text = content.text.is_some();
                    owned = Some(content);
                    let _ = conn.set_selection_owner(win, atoms.clipboard, x11rb::CURRENT_TIME);
                    if text {
                        let _ = conn.set_selection_owner(win, atoms.primary, x11rb::CURRENT_TIME);
                    }
                    // Round trip: ownership is in effect once this returns.
                    let _ = conn.get_selection_owner(atoms.clipboard).map(|c| c.reply());
                    let _ = done.send(());
                }
                let ev = match conn.poll_for_event() {
                    Ok(Some(ev)) => ev,
                    Ok(None) => {
                        let mut p = [
                            PollFd::new(conn.stream().as_fd(), PollFlags::POLLIN),
                            PollFd::new(wake_r.as_fd(), PollFlags::POLLIN),
                        ];
                        let _ = poll(&mut p, 1000u16);
                        continue;
                    }
                    Err(e) => {
                        log::error!("desktop X connection: {e}");
                        return;
                    }
                };
                match ev {
                    Event::XfixesCursorNotify(_) => send_cursor(&conn, &hub, &mut cursor_serial),
                    Event::XfixesSelectionNotify(e) => {
                        if e.selection == atoms.clipboard
                            && e.owner != win
                            && e.owner != x11rb::NONE
                        {
                            // Ask what the new owner offers, then fetch what castd carries of it.
                            fetch = Some(Fetch {
                                current: None,
                                queue: Vec::new(),
                                got: ClipContent::default(),
                                incr: None,
                            });
                            let _ = conn.convert_selection(
                                win,
                                atoms.clipboard,
                                atoms.targets,
                                atoms.prop,
                                x11rb::CURRENT_TIME,
                            );
                            let _ = conn.flush();
                        }
                    }
                    Event::SelectionNotify(e) => {
                        let Some(f) = fetch.as_mut() else {
                            continue;
                        };
                        let reply = (e.property != x11rb::NONE)
                            .then(|| {
                                conn.get_property(
                                    true,
                                    win,
                                    atoms.prop,
                                    AtomEnum::ANY,
                                    0,
                                    u32::MAX / 4,
                                )
                                .ok()?
                                .reply()
                                .ok()
                            })
                            .flatten();
                        if e.target == atoms.targets && f.current.is_none() {
                            let offered: Vec<u32> = reply
                                .as_ref()
                                .and_then(|r| r.value32().map(|v| v.collect()))
                                .unwrap_or_default();
                            f.queue = wanted(&atoms, &offered);
                        } else if let Some(r) = reply {
                            if r.type_ == atoms.incr {
                                // The value follows in pieces, one PropertyNotify each.
                                f.incr = Some(Vec::new());
                                continue;
                            }
                            take(&atoms, &mut f.got, e.target, r.value);
                        }
                        next_fetch(&conn, &atoms, win, &mut fetch, &hub, &mut last);
                    }
                    Event::PropertyNotify(e)
                        if e.atom == atoms.prop && e.state == xproto::Property::NEW_VALUE =>
                    {
                        let Some(f) = fetch.as_mut() else {
                            continue;
                        };
                        if f.incr.is_none() {
                            continue;
                        }
                        let Ok(Ok(r)) = conn
                            .get_property(true, win, atoms.prop, AtomEnum::ANY, 0, u32::MAX / 4)
                            .map(|c| c.reply())
                        else {
                            continue;
                        };
                        if r.value.is_empty() {
                            let data = f.incr.take().unwrap_or_default();
                            if let Some(target) = f.current {
                                take(&atoms, &mut f.got, target, data);
                            }
                            next_fetch(&conn, &atoms, win, &mut fetch, &hub, &mut last);
                        } else if let Some(buf) = f.incr.as_mut()
                            && buf.len() + r.value.len() <= MAX_IMAGE
                        {
                            buf.extend_from_slice(&r.value);
                        }
                        let _ = conn.flush();
                    }
                    Event::SelectionRequest(e) => answer(&conn, &atoms, owned.as_ref(), &e),
                    Event::SelectionClear(e) if e.selection == atoms.clipboard => {
                        owned = None;
                    }
                    _ => {}
                }
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(ClipboardHandle { tx, wake_w })
}

/// The formats castd fetches from what an owner offers, in order: one text, HTML, a PNG.
fn wanted(atoms: &Atoms, offered: &[u32]) -> Vec<u32> {
    let mut q = Vec::new();
    if let Some(&t) = [
        atoms.utf8,
        atoms.text_plain_utf8,
        u32::from(AtomEnum::STRING),
    ]
    .iter()
    .find(|t| offered.contains(t))
    {
        q.push(t);
    }
    if offered.contains(&atoms.html) {
        q.push(atoms.html);
    }
    if offered.contains(&atoms.png) {
        q.push(atoms.png);
    }
    q
}

/// Files one fetched format's bytes into `got`.
fn take(atoms: &Atoms, got: &mut ClipContent, target: u32, data: Vec<u8>) {
    if data.is_empty() {
        return;
    }
    if target == atoms.png {
        if data.len() <= MAX_IMAGE {
            got.png = Some(data);
        }
    } else if target == atoms.html {
        got.html = Some(decode_text(&data));
    } else if target == u32::from(AtomEnum::STRING) {
        // STRING is Latin-1.
        got.text = Some(data.iter().map(|&b| b as char).collect());
    } else {
        got.text = Some(decode_text(&data));
    }
}

/// UTF-8, or UTF-16 behind a byte order mark (Firefox writes its HTML so).
fn decode_text(data: &[u8]) -> String {
    let utf16 = |le: bool| {
        let units: Vec<u16> = data[2..]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| {
                if le {
                    u16::from_le_bytes([c[0], c[1]])
                } else {
                    u16::from_be_bytes([c[0], c[1]])
                }
            })
            .collect();
        String::from_utf16_lossy(&units)
    };
    match data {
        [0xff, 0xfe, ..] => utf16(true),
        [0xfe, 0xff, ..] => utf16(false),
        _ => String::from_utf8_lossy(data)
            .trim_end_matches('\0')
            .to_string(),
    }
}

/// Moves a copy along: asks for the next format, or sends what came once none is left.
fn next_fetch(
    conn: &RustConnection,
    atoms: &Atoms,
    win: u32,
    fetch: &mut Option<Fetch>,
    hub: &Hub,
    last: &mut Option<ClipContent>,
) {
    let Some(mut f) = fetch.take() else {
        return;
    };
    if f.queue.is_empty() {
        publish(hub, f.got, last);
        return;
    }
    let target = f.queue.remove(0);
    f.current = Some(target);
    let _ = conn.convert_selection(
        win,
        atoms.clipboard,
        target,
        atoms.prop,
        x11rb::CURRENT_TIME,
    );
    let _ = conn.flush();
    *fetch = Some(f);
}

/// Sends a copy made in the window to every viewer that may drive it: a read-only viewer's own clipboard is not
/// someone else's to write.
fn publish(hub: &Hub, got: ClipContent, last: &mut Option<ClipContent>) {
    if got.is_empty() || last.as_ref() == Some(&got) {
        return;
    }
    hub.clipboard_changed(&got);
    *last = Some(got);
}

/// Answers another client's request for what castd owns: CLIPBOARD in every format it holds, PRIMARY as text.
fn answer(
    conn: &RustConnection,
    atoms: &Atoms,
    owned: Option<&ClipContent>,
    e: &xproto::SelectionRequestEvent,
) {
    let prop = if e.property == x11rb::NONE {
        e.target
    } else {
        e.property
    };
    let ok = owned.is_some_and(|c| {
        let primary = e.selection == atoms.primary;
        if e.selection != atoms.clipboard && !primary {
            return false;
        }
        let text = c.text.as_deref();
        let html = c.html.as_deref().filter(|_| !primary);
        let png = c.png.as_deref().filter(|_| !primary);
        let set8 = |ty: u32, data: &[u8]| {
            conn.change_property8(PropMode::REPLACE, e.requestor, prop, ty, data)
                .is_ok()
        };
        if e.target == atoms.targets {
            let mut list = vec![atoms.targets, atoms.timestamp];
            if text.is_some() {
                list.extend(atoms.text_targets());
            }
            if html.is_some() {
                list.push(atoms.html);
            }
            if png.is_some() {
                list.push(atoms.png);
            }
            conn.change_property32(PropMode::REPLACE, e.requestor, prop, AtomEnum::ATOM, &list)
                .is_ok()
        } else if e.target == atoms.timestamp {
            conn.change_property32(
                PropMode::REPLACE,
                e.requestor,
                prop,
                AtomEnum::INTEGER,
                &[e.time],
            )
            .is_ok()
        } else if atoms.text_targets().contains(&e.target) {
            match text {
                Some(t) if e.target == u32::from(AtomEnum::STRING) => {
                    // STRING is Latin-1; what it cannot say becomes '?'.
                    let latin1: Vec<u8> = t
                        .chars()
                        .map(|c| if (c as u32) < 0x100 { c as u8 } else { b'?' })
                        .collect();
                    set8(e.target, &latin1)
                }
                Some(t) => set8(e.target, t.as_bytes()),
                None => false,
            }
        } else if e.target == atoms.html {
            html.is_some_and(|h| set8(atoms.html, h.as_bytes()))
        } else if e.target == atoms.png {
            png.is_some_and(|p| set8(atoms.png, p))
        } else {
            false
        }
    });
    let notify = xproto::SelectionNotifyEvent {
        response_type: xproto::SELECTION_NOTIFY_EVENT,
        sequence: 0,
        time: e.time,
        requestor: e.requestor,
        selection: e.selection,
        target: e.target,
        property: if ok { prop } else { x11rb::NONE },
    };
    let _ = conn.send_event(false, e.requestor, EventMask::NO_EVENT, notify);
    let _ = conn.flush();
}

/// The CSS keyword for a standard X cursor name, where there is one.
pub fn css_cursor(name: &str) -> Option<&'static str> {
    Some(match name {
        "left_ptr" | "default" | "arrow" | "top_left_arrow" => "default",
        "xterm" | "text" | "ibeam" => "text",
        "vertical-text" => "vertical-text",
        "hand1" | "hand2" | "pointer" | "pointing_hand" => "pointer",
        "watch" | "wait" => "wait",
        "left_ptr_watch" | "progress" | "half-busy" => "progress",
        "crosshair" | "cross" | "tcross" => "crosshair",
        "fleur" | "move" | "all-scroll" | "size_all" => "move",
        "question_arrow" | "help" | "whats_this" => "help",
        "not-allowed" | "crossed_circle" | "forbidden" => "not-allowed",
        "no-drop" => "no-drop",
        "grab" | "openhand" => "grab",
        "grabbing" | "closedhand" | "dnd-none" => "grabbing",
        "copy" | "dnd-copy" => "copy",
        "alias" | "dnd-link" | "link" => "alias",
        "context-menu" => "context-menu",
        "cell" | "plus" => "cell",
        "zoom-in" => "zoom-in",
        "zoom-out" => "zoom-out",
        "sb_h_double_arrow" | "ew-resize" | "h_double_arrow" | "size_hor" => "ew-resize",
        "sb_v_double_arrow" | "ns-resize" | "v_double_arrow" | "size_ver" => "ns-resize",
        "col-resize" | "split_h" => "col-resize",
        "row-resize" | "split_v" => "row-resize",
        "nesw-resize" | "size_bdiag" | "fd_double_arrow" => "nesw-resize",
        "nwse-resize" | "size_fdiag" | "bd_double_arrow" => "nwse-resize",
        "n-resize" | "top_side" => "n-resize",
        "s-resize" | "bottom_side" => "s-resize",
        "e-resize" | "right_side" => "e-resize",
        "w-resize" | "left_side" => "w-resize",
        "ne-resize" | "top_right_corner" => "ne-resize",
        "nw-resize" | "top_left_corner" => "nw-resize",
        "se-resize" | "bottom_right_corner" => "se-resize",
        "sw-resize" | "bottom_left_corner" => "sw-resize",
        "none" => "none",
        _ => return None,
    })
}

fn send_cursor(conn: &RustConnection, hub: &Hub, last_serial: &mut Option<u32>) {
    let Ok(Ok(img)) = conn.xfixes_get_cursor_image_and_name().map(|c| c.reply()) else {
        return;
    };
    if *last_serial == Some(img.cursor_serial) {
        return;
    }
    *last_serial = Some(img.cursor_serial);
    let (w, h) = (img.width as usize, img.height as usize);
    let name = String::from_utf8_lossy(&img.name).to_string();
    let mut rgba = Vec::with_capacity(w * h * 4);
    for &p in img.cursor_image.iter().take(w * h) {
        let a = (p >> 24) & 0xff;
        // XFixes hands premultiplied ARGB; PNG wants it straight.
        let un = |c: u32| {
            (c * 255 + a / 2)
                .checked_div(a)
                .map_or(0, |v| v.min(255) as u8)
        };
        rgba.extend_from_slice(&[
            un((p >> 16) & 0xff),
            un((p >> 8) & 0xff),
            un(p & 0xff),
            a as u8,
        ]);
    }
    hub.set_cursor(cast_core::clipboard::cursor(
        w as u32,
        h as u32,
        &rgba,
        (u32::from(img.xhot), u32::from(img.yhot)),
        css_cursor(&name),
    ));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standard_cursor_names_become_css_keywords() {
        assert_eq!(css_cursor("left_ptr"), Some("default"));
        assert_eq!(css_cursor("xterm"), Some("text"));
        assert_eq!(css_cursor("hand2"), Some("pointer"));
        assert_eq!(css_cursor("sb_h_double_arrow"), Some("ew-resize"));
        assert_eq!(css_cursor("some-app-cursor"), None);
    }

    #[test]
    fn clipboard_text_decodes_utf8_and_bom_utf16() {
        assert_eq!(decode_text("zażółć".as_bytes()), "zażółć");
        assert_eq!(decode_text(&[0xff, 0xfe, b'h', 0, b'i', 0]), "hi");
        assert_eq!(decode_text(&[0xfe, 0xff, 0, b'h', 0, b'i']), "hi");
        assert_eq!(decode_text(b"x\0"), "x");
    }
}
