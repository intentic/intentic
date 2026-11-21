//! A virtual desktop for a computer with no display at all (a server on a text console, a machine nobody is logged in
//! to graphically): remoted starts an X server of its own, Xvfb (or Xorg with the dummy driver where Xvfb is absent),
//! and on it the desktop session installed on the machine, else a window manager there is, as the user remoted runs
//! as. It is streamed exactly as castd streams the sandbox's own desktop: XDamage capture read in place from Xvfb's
//! `-shmem` framebuffer, and RandR resizing to the driving viewer's box.
//!
//! The desktop outlives its viewers: a person who closes the tab finds their windows where they left them. It ends
//! with remoted (the agent stopping it when the last remote switch goes off), or when its session exits (the person
//! logged out), after which the next viewer starts a fresh one. Nothing is installed: what is missing is named, per
//! distribution, in `/info`.

use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use cast_core::capture::{Capture, ScreenSource};
use cast_core::geometry::{Rect, ResizeLimits};
use cast_x11::screen::Screen;

/// The largest screen a viewer's box may make the desktop: Xvfb's framebuffer is allocated at it (33 MB), and every
/// smaller size is a RandR mode within it.
pub const MAX_SIZE: (u32, u32) = (3840, 2160);

/// The size the desktop starts at, before a viewer says its own.
pub const INITIAL_SIZE: (u32, u32) = (1920, 1080);

/// Desktop sessions and window managers known to run on an X server with no GPU, the lightest complete desktop first.
/// GNOME and KDE (which want OpenGL compositing) come after every lighter one, and only as named in `xsessions`.
const SESSIONS: &[(&str, &[&str])] = &[
    ("Xfce", &["startxfce4"]),
    ("MATE", &["mate-session"]),
    ("LXQt", &["startlxqt"]),
    ("LXDE", &["startlxde"]),
    ("Cinnamon", &["cinnamon-session"]),
    ("Openbox", &["openbox-session"]),
    ("IceWM", &["icewm-session"]),
    ("Fluxbox", &["startfluxbox"]),
    ("i3", &["i3"]),
    ("Plasma", &["startplasma-x11"]),
    ("GNOME", &["gnome-session"]),
];

/// Window managers alone, when no session is installed: a desktop with nothing but windows.
const WINDOW_MANAGERS: &[&str] = &[
    "xfwm4", "openbox", "icewm", "fluxbox", "marco", "metacity", "fvwm", "twm",
];

/// How remoted would start a virtual desktop on this computer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub server: Server,
    /// The session's name as `/info` shows it, and the command.
    pub session: (String, Vec<String>),
    /// `dbus-run-session`, when there is one, to give the session a bus of its own.
    pub bus: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Server {
    Xvfb(PathBuf),
    /// Xorg and the dummy driver: the server runs as remoted's user only where Xorg allows it (root, or a wrapper set
    /// to `needs_root_rights=no`).
    XorgDummy(PathBuf),
}

/// What is missing for a virtual desktop: package names for this distribution, and the words.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Missing {
    pub packages: Vec<String>,
    pub words: String,
}

/// Looks for an X server and a session on `PATH` (and `/usr/bin`, for a service started with a bare one).
pub fn plan() -> Result<Plan, Missing> {
    let server = match which("Xvfb") {
        Some(xvfb) => Some(Server::Xvfb(xvfb)),
        None => which("Xorg")
            .filter(|_| dummy_driver().is_some())
            .map(Server::XorgDummy),
    };
    let session = find_session();
    let distro = Distro::here();
    let mut packages = Vec::new();
    let mut words = Vec::new();
    if server.is_none() {
        packages.push(distro.xvfb().to_owned());
        words.push("an X server to draw the desktop on (Xvfb)");
    }
    if session.is_none() {
        packages.push(distro.desktop().to_owned());
        words.push("a desktop session or window manager (Xfce, for one)");
    }
    match (server, session) {
        (Some(server), Some(session)) => Ok(Plan {
            server,
            session,
            bus: which("dbus-run-session"),
        }),
        _ => Err(Missing {
            words: format!(
                "this computer has no display, and a virtual desktop needs {}: install {}",
                words.join(" and "),
                packages.join(" and ")
            ),
            packages,
        }),
    }
}

fn find_session() -> Option<(String, Vec<String>)> {
    for (name, command) in SESSIONS {
        if which(command[0]).is_some() {
            return Some((
                (*name).to_owned(),
                command.iter().map(|c| (*c).to_owned()).collect(),
            ));
        }
    }
    // Something else the display managers know of (a session the list does not name).
    if let Ok(dir) = std::fs::read_dir("/usr/share/xsessions") {
        let mut entries: Vec<_> = dir.flatten().map(|e| e.path()).collect();
        entries.sort();
        for path in entries {
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            let field = |key: &str| {
                text.lines()
                    .find_map(|l| l.strip_prefix(key))
                    .map(|v| v.trim().to_owned())
            };
            if let Some(exec) = field("Exec=") {
                let command: Vec<String> = exec.split_whitespace().map(str::to_owned).collect();
                if command.first().is_some_and(|c| which(c).is_some()) {
                    let name = field("Name=").unwrap_or_else(|| command[0].clone());
                    return Some((name, command));
                }
            }
        }
    }
    WINDOW_MANAGERS
        .iter()
        .find(|wm| which(wm).is_some())
        .map(|wm| ((*wm).to_owned(), vec![(*wm).to_owned()]))
}

/// A program on `PATH`, or in the system's bin directories when `PATH` is bare.
pub fn which(program: &str) -> Option<PathBuf> {
    let path = std::env::var("PATH").unwrap_or_default();
    path.split(':')
        .filter(|d| !d.is_empty())
        .chain(["/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin"])
        .map(|d| Path::new(d).join(program))
        .find(|p| is_executable(p))
}

fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

fn dummy_driver() -> Option<PathBuf> {
    [
        "/usr/lib/xorg/modules/drivers/dummy_drv.so",
        "/usr/lib64/xorg/modules/drivers/dummy_drv.so",
        "/usr/lib/x86_64-linux-gnu/xorg/modules/drivers/dummy_drv.so",
    ]
    .iter()
    .map(PathBuf::from)
    .find(|p| p.exists())
}

/// The package names a distribution gives what a virtual desktop needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Distro {
    Debian,
    Fedora,
    Arch,
    Suse,
    Other,
}

impl Distro {
    pub fn here() -> Distro {
        let text = std::fs::read_to_string("/etc/os-release").unwrap_or_default();
        Self::from_os_release(&text)
    }

    pub fn from_os_release(text: &str) -> Distro {
        let field = |key: &str| {
            text.lines()
                .find_map(|l| l.strip_prefix(key))
                .map(|v| v.trim_matches('"').to_ascii_lowercase())
                .unwrap_or_default()
        };
        let ids = format!("{} {}", field("ID="), field("ID_LIKE="));
        let has = |id: &str| ids.split_whitespace().any(|w| w == id);
        if has("debian") || has("ubuntu") {
            Distro::Debian
        } else if has("fedora") || has("rhel") || has("centos") {
            Distro::Fedora
        } else if has("arch") {
            Distro::Arch
        } else if has("suse") || has("opensuse") {
            Distro::Suse
        } else {
            Distro::Other
        }
    }

    pub fn xvfb(self) -> &'static str {
        match self {
            Distro::Debian => "xvfb",
            Distro::Fedora | Distro::Suse => "xorg-x11-server-Xvfb",
            Distro::Arch => "xorg-server-xvfb",
            Distro::Other => "Xvfb",
        }
    }

    pub fn desktop(self) -> &'static str {
        match self {
            Distro::Debian | Distro::Arch => "xfce4",
            Distro::Fedora => "@xfce-desktop-environment",
            Distro::Suse => "patterns-xfce-xfce",
            Distro::Other => "Xfce",
        }
    }
}

/// A virtual desktop remoted started: its X server and session, ended when dropped.
pub struct Desktop {
    pub display: String,
    pub authority: PathBuf,
    pub session_name: String,
    server: Child,
    session: Child,
    /// The RandR client whose modes the desktop's sizes are: kept for the desktop's life, since the server reverts a
    /// client's modes when it disconnects.
    randr: Arc<Mutex<Screen>>,
    dir: PathBuf,
    /// Dropped after the processes were ended (fields drop after `Drop::drop`).
    _keeper: Keeper,
}

impl Desktop {
    /// Starts the X server and the session, and waits (10 s at most) for the server to take connections.
    pub fn start(plan: &Plan) -> Result<Desktop, String> {
        let started = Instant::now();
        let dir = runtime_dir()?;
        forget_stale(&dir);
        let number = free_display().ok_or("no free X display number between :90 and :199")?;
        let display = format!(":{number}");
        let authority = dir.join(format!("Xauthority-{number}"));
        write_authority(&authority, number)?;
        let keeper = Keeper::start()?;
        let mut server = start_server(&keeper, plan, number, &authority, &dir)?;
        if let Err(e) = wait_for_server(
            &display,
            &authority,
            &mut server,
            &dir.join(format!("{number}.log")),
        ) {
            end(&mut server);
            return Err(e);
        }
        cast_x11::connect::set_authority(Some(authority.clone()));
        let mut randr = match Screen::open(Some(&display), Some(MAX_SIZE)) {
            Ok(randr) => randr,
            Err(e) => {
                end(&mut server);
                return Err(format!("the virtual desktop cannot be resized: {e}"));
            }
        };
        if let Err(e) = randr.resize(INITIAL_SIZE.0, INITIAL_SIZE.1) {
            log::warn!("virtual desktop: resizing to {INITIAL_SIZE:?} failed: {e}");
        }
        let session_log = dir.join(format!("session-{number}.log"));
        let session = match start_session(&keeper, plan, &display, &authority, &session_log)
            .and_then(|session| settled(session, &plan.session.0, &session_log))
        {
            Ok(session) => session,
            Err(e) => {
                end(&mut server);
                return Err(e);
            }
        };
        log::info!(
            "virtual desktop {display} started: {} on {} in {} ms",
            plan.session.0,
            match &plan.server {
                Server::Xvfb(_) => "Xvfb",
                Server::XorgDummy(_) => "Xorg (dummy)",
            },
            started.elapsed().as_millis()
        );
        Ok(Desktop {
            display,
            authority,
            session_name: plan.session.0.clone(),
            server,
            session,
            randr: Arc::new(Mutex::new(randr)),
            dir,
            _keeper: keeper,
        })
    }

    /// What the server leaves in /tmp when it does not get to clean up.
    fn leftovers(&self) -> Vec<PathBuf> {
        let number = self.display.trim_start_matches(':');
        vec![
            PathBuf::from(format!("/tmp/.X{number}-lock")),
            PathBuf::from(format!("/tmp/.X11-unix/X{number}")),
        ]
    }

    /// Whether the X server and the session both still run.
    pub fn alive(&mut self) -> bool {
        matches!(self.server.try_wait(), Ok(None)) && matches!(self.session.try_wait(), Ok(None))
    }

    /// The desktop as a screen the pipeline captures and resizes.
    pub fn source(&self) -> VirtualScreen {
        VirtualScreen {
            display: self.display.clone(),
            randr: self.randr.clone(),
        }
    }

    /// The desktop's current size.
    pub fn size(&self) -> Option<(u32, u32)> {
        let (conn, n) = cast_x11::connect::connect(Some(&self.display)).ok()?;
        use x11rb::connection::Connection;
        let root = &conn.setup().roots[n];
        Some((
            u32::from(root.width_in_pixels),
            u32::from(root.height_in_pixels),
        ))
    }
}

impl Drop for Desktop {
    fn drop(&mut self) {
        // The session's whole process group (its own setsid), then the server; X clients the group missed end with
        // the server's connections.
        // SIGTERM first: an X server killed outright leaves its lock file and socket in /tmp behind it.
        let group = self.session.id() as i32;
        unsafe {
            libc::kill(-group, libc::SIGTERM);
            libc::kill(self.server.id() as i32, libc::SIGTERM);
        }
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline
            && (matches!(self.session.try_wait(), Ok(None))
                || matches!(self.server.try_wait(), Ok(None)))
        {
            std::thread::sleep(Duration::from_millis(50));
        }
        unsafe {
            libc::kill(-group, libc::SIGKILL);
        }
        let _ = self.server.kill();
        let _ = self.session.wait();
        let _ = self.server.wait();
        for leftover in self.leftovers() {
            let _ = std::fs::remove_file(leftover);
        }
        let number = self.display.trim_start_matches(':');
        let _ = std::fs::remove_file(self.dir.join(format!("{number}.log")));
        let _ = std::fs::remove_file(self.dir.join(format!("session-{number}.log")));
        let _ = std::fs::remove_file(&self.authority);
        let _ = std::fs::remove_dir(&self.dir);
        log::info!("virtual desktop {} ended", self.display);
    }
}

/// Ends a server that started but is not kept: SIGTERM, so it removes its lock file and socket, then SIGKILL after 2 s.
fn end(child: &mut Child) {
    unsafe {
        libc::kill(child.id() as i32, libc::SIGTERM);
    }
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline && matches!(child.try_wait(), Ok(None)) {
        std::thread::sleep(Duration::from_millis(20));
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// A virtual desktop's screen: the whole display, resizable within [`MAX_SIZE`].
pub struct VirtualScreen {
    display: String,
    randr: Arc<Mutex<Screen>>,
}

impl ScreenSource for VirtualScreen {
    fn open(&mut self, crop: Option<Rect>) -> Result<Box<dyn Capture>, String> {
        Ok(Box::new(cast_x11::capture::Capturer::new(
            Some(&self.display),
            crop,
        )?))
    }

    fn resize_limits(&self) -> Option<ResizeLimits> {
        Some(self.randr.lock().expect("randr poisoned").limits())
    }

    fn resize(&mut self, w: u32, h: u32) -> Result<(), String> {
        self.randr.lock().expect("randr poisoned").resize(w, h)
    }
}

/// Where the desktop's cookie and configuration live: `$XDG_RUNTIME_DIR/intentic-remoted`, else a directory of this
/// user's in /tmp; 0700 either way.
fn runtime_dir() -> Result<PathBuf, String> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    let uid = unsafe { libc::geteuid() };
    let dir = std::env::var_os("XDG_RUNTIME_DIR")
        .map(|d| PathBuf::from(d).join("intentic-remoted"))
        .unwrap_or_else(|| PathBuf::from(format!("/tmp/intentic-remoted-{uid}")));
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&dir)
        .map_err(|e| format!("{}: {e}", dir.display()))?;
    let meta = std::fs::metadata(&dir).map_err(|e| e.to_string())?;
    use std::os::unix::fs::MetadataExt;
    if meta.uid() != uid {
        return Err(format!("{} belongs to someone else", dir.display()));
    }
    let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    Ok(dir)
}

/// Removes what a remoted that did not end cleanly left in its directory: cookies and logs of displays no longer
/// served.
fn forget_stale(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let number = name
            .strip_prefix("Xauthority-")
            .or_else(|| {
                name.strip_prefix("session-")
                    .and_then(|n| n.strip_suffix(".log"))
            })
            .or_else(|| name.strip_suffix(".log"))
            .or_else(|| {
                name.strip_prefix("xorg-dummy-")
                    .and_then(|n| n.strip_suffix(".conf"))
            })
            .or_else(|| {
                name.strip_prefix("Xorg-")
                    .and_then(|n| n.strip_suffix(".log"))
            });
        if let Some(number) = number
            && !Path::new(&format!("/tmp/.X{number}-lock")).exists()
        {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// The first display number from 90 with neither a socket nor a lock file.
fn free_display() -> Option<u32> {
    (90..200).find(|n| {
        !Path::new(&format!("/tmp/.X11-unix/X{n}")).exists()
            && !Path::new(&format!("/tmp/.X{n}-lock")).exists()
    })
}

/// A cookie file for display `number` with a fresh random MIT-MAGIC-COOKIE-1, 0600.
fn write_authority(path: &Path, number: u32) -> Result<(), String> {
    use std::io::{Read, Write};
    use std::os::unix::fs::OpenOptionsExt;
    let mut cookie = [0u8; 16];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut cookie))
        .map_err(|e| format!("/dev/urandom: {e}"))?;
    let host = std::fs::read_to_string("/proc/sys/kernel/hostname")
        .map(|h| h.trim().to_owned())
        .unwrap_or_default();
    let mut bytes = 256u16.to_be_bytes().to_vec();
    for field in [
        host.as_bytes(),
        number.to_string().as_bytes(),
        b"MIT-MAGIC-COOKIE-1".as_slice(),
        &cookie,
    ] {
        bytes.extend((field.len() as u16).to_be_bytes());
        bytes.extend(field);
    }
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| format!("{}: {e}", path.display()))?;
    file.write_all(&bytes).map_err(|e| e.to_string())
}

/// The thread the desktop's processes are started from, alive as long as the desktop. `PR_SET_PDEATHSIG` fires when
/// the *thread* that forked a child ends, not the process: started from one of tokio's blocking threads, which end after
/// ten idle seconds, the X server was killed under its viewers (seen on z440, 2026-11-20).
struct Keeper {
    asks:
        Option<std::sync::mpsc::Sender<(Command, std::sync::mpsc::Sender<std::io::Result<Child>>)>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Keeper {
    fn start() -> Result<Keeper, String> {
        let (asks, asked) =
            std::sync::mpsc::channel::<(Command, std::sync::mpsc::Sender<std::io::Result<Child>>)>(
            );
        let thread = std::thread::Builder::new()
            .name("virtual-desktop".into())
            .spawn(move || {
                while let Ok((mut command, answer)) = asked.recv() {
                    let _ = answer.send(command.spawn());
                }
            })
            .map_err(|e| format!("the desktop's thread did not start: {e}"))?;
        Ok(Keeper {
            asks: Some(asks),
            thread: Some(thread),
        })
    }

    fn spawn(&self, command: Command) -> std::io::Result<Child> {
        let (answer, answered) = std::sync::mpsc::channel();
        self.asks
            .as_ref()
            .and_then(|asks| asks.send((command, answer)).ok())
            .ok_or_else(|| std::io::Error::other("the desktop's thread ended"))?;
        answered
            .recv()
            .unwrap_or_else(|_| Err(std::io::Error::other("the desktop's thread ended")))
    }
}

impl Drop for Keeper {
    fn drop(&mut self) {
        drop(self.asks.take());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// Children remoted starts die with it (`PR_SET_PDEATHSIG`, from the [`Keeper`]'s thread), and the session gets a
/// process group of its own.
fn tie_to_remoted(command: &mut Command, own_group: bool) {
    unsafe {
        command.pre_exec(move || {
            if own_group {
                libc::setsid();
            }
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM);
            Ok(())
        });
    }
}

fn start_server(
    keeper: &Keeper,
    plan: &Plan,
    number: u32,
    authority: &Path,
    dir: &Path,
) -> Result<Child, String> {
    let display = format!(":{number}");
    let (w, h) = MAX_SIZE;
    let mut command = match &plan.server {
        Server::Xvfb(xvfb) => {
            let mut c = Command::new(xvfb);
            c.args([
                display.as_str(),
                "-screen",
                "0",
                &format!("{w}x{h}x24"),
                // castd reads the framebuffer in place from this segment.
                "-shmem",
                "-nolisten",
                "tcp",
                "-noreset",
                "-dpi",
                "96",
                "-auth",
            ])
            .arg(authority);
            c
        }
        Server::XorgDummy(xorg) => {
            let config = dir.join(format!("xorg-dummy-{number}.conf"));
            std::fs::write(&config, dummy_config(w, h)).map_err(|e| e.to_string())?;
            let mut c = Command::new(xorg);
            c.args([display.as_str(), "-noreset", "-nolisten", "tcp", "-auth"])
                .arg(authority)
                .args(["-logfile"])
                .arg(dir.join(format!("Xorg-{number}.log")))
                .arg("-config")
                .arg(&config);
            c
        }
    };
    // The server's own words go to a file beside its cookie: the reason it gives when it does not start.
    let log =
        std::fs::File::create(dir.join(format!("{number}.log"))).map_err(|e| e.to_string())?;
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(log));
    tie_to_remoted(&mut command, false);
    keeper
        .spawn(command)
        .map_err(|e| format!("the X server did not start: {e}"))
}

fn dummy_config(w: u32, h: u32) -> String {
    format!(
        "Section \"Device\"\n  Identifier \"remoted\"\n  Driver \"dummy\"\n  VideoRam 256000\nEndSection\n\
         Section \"Monitor\"\n  Identifier \"remoted\"\n  HorizSync 5.0-1000.0\n  VertRefresh 5.0-200.0\nEndSection\n\
         Section \"Screen\"\n  Identifier \"remoted\"\n  Device \"remoted\"\n  Monitor \"remoted\"\n  DefaultDepth 24\n\
         \x20 SubSection \"Display\"\n    Depth 24\n    Virtual {w} {h}\n  EndSubSection\nEndSection\n"
    )
}

/// Waits for the server to take a connection with the cookie, or to exit (its stderr's last lines are the reason).
fn wait_for_server(
    display: &str,
    authority: &Path,
    server: &mut Child,
    log: &Path,
) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(10);
    let (number, _) = cast_x11::connect::local_display(display).ok_or("a bad display")?;
    let socket = format!("/tmp/.X11-unix/X{number}");
    loop {
        if let Ok(Some(status)) = server.try_wait() {
            let words = std::fs::read_to_string(log).unwrap_or_default();
            let tail: Vec<&str> = words
                .lines()
                .filter(|l| !l.trim().is_empty())
                .rev()
                .take(3)
                .collect();
            return Err(format!(
                "the X server exited ({status}): {}",
                tail.into_iter().rev().collect::<Vec<_>>().join(" / ")
            ));
        }
        if Path::new(&socket).exists() && cookie_connects(display, authority) {
            return Ok(());
        }
        if Instant::now() > deadline {
            return Err("the X server did not take connections within 10 s".into());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn cookie_connects(display: &str, authority: &Path) -> bool {
    let before = cast_x11::connect::authority();
    cast_x11::connect::set_authority(Some(authority.to_path_buf()));
    let ok = cast_x11::connect::connect(Some(display)).is_ok();
    cast_x11::connect::set_authority(before);
    ok
}

/// How long a session has to stay up before it counts as started: a window manager missing its theme (openbox) or a
/// session missing its bus exits within a few hundred milliseconds.
const SESSION_SETTLES: Duration = Duration::from_millis(800);

/// The session, once it lasted [`SESSION_SETTLES`]; one that exited sooner is an error with its own last words.
fn settled(mut session: Child, name: &str, log: &Path) -> Result<Child, String> {
    let deadline = Instant::now() + SESSION_SETTLES;
    while Instant::now() < deadline {
        if let Ok(Some(status)) = session.try_wait() {
            let words = std::fs::read_to_string(log).unwrap_or_default();
            let tail: Vec<&str> = words
                .lines()
                .filter(|l| !l.trim().is_empty())
                .rev()
                .take(2)
                .collect();
            return Err(format!(
                "the desktop session ({name}) exited at once ({status}){}",
                if tail.is_empty() {
                    String::new()
                } else {
                    format!(
                        ": {}",
                        tail.into_iter().rev().collect::<Vec<_>>().join(" / ")
                    )
                }
            ));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Ok(session)
}

fn start_session(
    keeper: &Keeper,
    plan: &Plan,
    display: &str,
    authority: &Path,
    log: &Path,
) -> Result<Child, String> {
    let (_, command) = &plan.session;
    let mut argv: Vec<String> = Vec::new();
    // startxfce4 starts a bus of its own when there is none; the rest are given one.
    if let Some(bus) = &plan.bus
        && command[0] != "startxfce4"
    {
        argv.push(bus.display().to_string());
        argv.push("--".into());
    }
    argv.extend(command.iter().cloned());
    let mut c = Command::new(&argv[0]);
    c.args(&argv[1..])
        .env("DISPLAY", display)
        .env("XAUTHORITY", authority)
        .env("XDG_SESSION_TYPE", "x11")
        .env_remove("WAYLAND_DISPLAY")
        .env_remove("DBUS_SESSION_BUS_ADDRESS")
        .env_remove("SESSION_MANAGER")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(
            std::fs::File::create(log)
                .map(Stdio::from)
                .unwrap_or_else(|_| Stdio::null()),
        );
    if let Some(home) = super::session::home_of(unsafe { libc::geteuid() }) {
        c.current_dir(&home).env("HOME", home);
    }
    tie_to_remoted(&mut c, true);
    keeper.spawn(c).map_err(|e| {
        format!(
            "the desktop session ({}) did not start: {e}",
            argv.join(" ")
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_distribution_names_its_own_packages() {
        let debian = "PRETTY_NAME=\"Debian GNU/Linux 13 (trixie)\"\nID=debian\n";
        let ubuntu = "ID=ubuntu\nID_LIKE=debian\n";
        let fedora = "ID=fedora\n";
        let arch = "ID=arch\n";
        let mint = "ID=linuxmint\nID_LIKE=\"ubuntu debian\"\n";
        assert_eq!(Distro::from_os_release(debian), Distro::Debian);
        assert_eq!(Distro::from_os_release(ubuntu).xvfb(), "xvfb");
        assert_eq!(Distro::from_os_release(mint), Distro::Debian);
        assert_eq!(
            Distro::from_os_release(fedora).xvfb(),
            "xorg-x11-server-Xvfb"
        );
        assert_eq!(Distro::from_os_release(arch).xvfb(), "xorg-server-xvfb");
        assert_eq!(Distro::from_os_release("ID=gentoo\n"), Distro::Other);
    }

    #[test]
    fn a_cookie_file_holds_one_local_entry_for_the_display() {
        let dir = std::env::temp_dir().join(format!("remoted-xauth-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("Xauthority-93");
        write_authority(&path, 93).unwrap();
        let (name, data) = cast_x11::connect::cookie(&path, 93).expect("a cookie for :93");
        assert_eq!(name, b"MIT-MAGIC-COOKIE-1");
        assert_eq!(data.len(), 16);
        assert_eq!(cast_x11::connect::cookie(&path, 94), None);
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
