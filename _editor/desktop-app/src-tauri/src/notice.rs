use std::sync::mpsc::{self, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::setup_link::NoticeArgs;

/* THE SYSTEM'S NOTIFICATIONS, PUT UP FOR THE WORKSPACE WHILE THE READER IS ELSEWHERE — a toast on Windows, a
notification of the desktop's on Linux.

The workspace page decides everything about one (the web's desktopNotices.ts): that the reader is away, that the news
is worth it (something needs them, a turn somebody started has finished), its words, the route a press opens and
whether it makes a sound. A push notification cannot reach this window (the webview takes no web push), so without
this an agent that stopped to ask something waited, unheard, behind a tray icon. The app only puts them up, takes one
down when the page says it is settled (an ask answered from the phone), clears them all when the reader is back
(`clear`) and when the app ends, and brings a pressed one's route up in the workspace.

A notification makes the system's own sound, so Do Not Disturb and Focus assist silence it as they silence every other
app, and a page that rings its own chime for it asks for none (`silent`).

On Windows a press comes back as a link through the OS (`intentic://notice?do=open&token=…`, the toast's protocol
activation), which reaches this app whether the toast was pressed as it appeared or later in the notification centre,
and a running app gets it through the second launch's hand-over like any other link. That needs no COM activator and no
handler kept alive per toast. The token is minted here for each notification and means nothing outside this run. On
Linux the press is the server's `ActionInvoked` signal for the notification's `default` action. */

/// The most notifications the app keeps track of: what a notification centre keeps for one app, with room to spare.
/// The oldest beyond it is taken down.
const KEPT: usize = 32;

/// One notification the page asked for and the app put up.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Posted {
    /// The page's name for what it is about: the same key again replaces it.
    key: String,
    /// The app's own name for it, on the toast's link and as its tag.
    token: String,
    /// The workspace route a press on it opens.
    path: Option<String>,
}

/// What is up, oldest first.
#[derive(Debug, Default)]
struct Book {
    posted: Vec<Posted>,
}

impl Book {
    /// Record a notification; answers the one it replaces (the page's last under the same key), and any the cap took
    /// out to make room.
    fn post(
        &mut self,
        key: &str,
        token: String,
        path: Option<String>,
    ) -> (Option<Posted>, Vec<Posted>) {
        let replaced = self.take_key(key);
        self.posted.push(Posted {
            key: key.to_string(),
            token,
            path,
        });
        let over = self.posted.len().saturating_sub(KEPT);
        let pushed_out = self.posted.drain(..over).collect();
        (replaced, pushed_out)
    }

    fn take_key(&mut self, key: &str) -> Option<Posted> {
        let at = self.posted.iter().position(|posted| posted.key == key)?;
        Some(self.posted.remove(at))
    }

    fn take_token(&mut self, token: &str) -> Option<Posted> {
        let at = self
            .posted
            .iter()
            .position(|posted| posted.token == token)?;
        Some(self.posted.remove(at))
    }

    fn take_all(&mut self) -> Vec<Posted> {
        std::mem::take(&mut self.posted)
    }
}

/// The app's notifications, as the page asked for them.
#[derive(Default)]
pub struct Notices(Mutex<Book>);

/// A fresh token: letters and digits only (setup_link.rs `is_notice_token`), and never one an outside link could guess.
fn mint_token() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// Put up the page's notification, replacing the one it had under the same key.
pub fn show(app: &AppHandle, args: NoticeArgs) {
    let token = mint_token();
    let (replaced, pushed_out) =
        app.state::<Notices>()
            .0
            .lock()
            .unwrap()
            .post(&args.key, token.clone(), args.path.clone());
    let app = app.clone();
    later(move || {
        for gone in &pushed_out {
            platform::withdraw(&app, gone);
        }
        platform::show(&app, &token, replaced.as_ref(), &args);
    });
}

/// Take down the page's notification under `key`, which is no longer true.
pub fn withdraw(app: &AppHandle, key: &str) {
    let Some(posted) = app.state::<Notices>().0.lock().unwrap().take_key(key) else {
        return;
    };
    let app = app.clone();
    later(move || platform::withdraw(&app, &posted));
}

/// Take down every notification the app put up: the reader is back, and the workspace in front of them says it all.
pub fn clear(app: &AppHandle) {
    let all = app.state::<Notices>().0.lock().unwrap().take_all();
    if all.is_empty() {
        return;
    }
    let app = app.clone();
    later(move || platform::clear(&app, &all));
}

/// How long the app's end waits for its notifications to go: they are worth tidying away, not worth a hung quit.
const CLEAR_ON_EXIT: Duration = Duration::from_secs(1);

/// The app is ending: nothing it put up can be answered once it has gone, so none of it stays behind.
pub fn clear_before_exit(app: &AppHandle) {
    let all = app.state::<Notices>().0.lock().unwrap().take_all();
    if all.is_empty() {
        return;
    }
    let (done, finished) = mpsc::channel();
    let app = app.clone();
    later(move || {
        platform::clear(&app, &all);
        let _ = done.send(());
    });
    let _ = finished.recv_timeout(CLEAR_ON_EXIT);
}

/// Where a press on a notification the app put up about this computer itself goes (machine_sandbox.rs): This device,
/// in the main window, rather than a route of the workspace. Never a page's: a page's path is held to a rooted route
/// (setup_link.rs), which this is not.
pub const THIS_DEVICE: &str = "intentic-app:device";

/// A press on one of the app's notifications: the workspace, at the route it was about, or This device for one about
/// this computer. A token this run did not issue, or one already pressed, is the workspace as it stands.
pub fn open(app: &AppHandle, token: &str) {
    let posted = app.state::<Notices>().0.lock().unwrap().take_token(token);
    match posted.and_then(|posted| posted.path) {
        Some(path) if path == THIS_DEVICE => crate::windows::show_device(app),
        Some(path) => crate::windows::show_workspace_at(app, Some(&path)),
        None => crate::windows::show_workspace(app),
    }
}

/// Whether the system shows the app's notifications at all, as far as the app can ask: Windows says it of each app
/// (`ToastNotifier.Setting`: the switch for all notifications, the app's own, a policy); a Linux desktop says only
/// whether a notification service answers, and keeps its per-app switches to itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
// Each platform says only some of these (see `platform::standing`): Windows never finds no service, Linux never a switch.
#[allow(dead_code)]
pub enum Standing {
    On,
    /// Every app's notifications are off (Windows: Settings ▸ System ▸ Notifications).
    OffForUser,
    /// This app's are.
    OffForApp,
    /// An administrator's policy has them off.
    OffByPolicy,
    /// No notification service answers on this desktop.
    NoService,
    Unknown,
}

impl Standing {
    /// The word the page reads (the web's desktopNotices.ts `DesktopNoticeSetting`).
    pub fn word(self) -> &'static str {
        match self {
            Standing::On => "on",
            Standing::OffForUser => "off-user",
            Standing::OffForApp => "off-app",
            Standing::OffByPolicy => "off-policy",
            Standing::NoService => "none",
            Standing::Unknown => "unknown",
        }
    }
}

/// The event the answer to `notice?do=status` is dispatched as, into the window that asked.
const STANDING_EVENT: &str = "intentic-desktop-notices";

fn standing_script(standing: Standing) -> String {
    format!(
        "window.dispatchEvent(new CustomEvent('{STANDING_EVENT}', {{ detail: {{ setting: \"{}\" }} }}));",
        standing.word()
    )
}

/// The page asked whether its notifications can show (its settings, as they open and after a test): asked of the
/// system on the desktop thread, and answered into `window`.
pub fn status(app: &AppHandle, window: &str) {
    let app = app.clone();
    let window = window.to_string();
    later(move || {
        let standing = platform::standing(&app);
        if let Some(window) = app.get_webview_window(&window) {
            let _ = window.eval(standing_script(standing));
        }
    });
}

/* ONE THREAD FOR WHAT THE APP SAYS TO THE DESKTOP: a notification or a dock count is a call into the system (WinRT,
D-Bus) that can take as long as a notification server takes to start, so none of it runs on the event loop or on a
worker of the async runtime, and the calls stay in the order they were asked for. */

type Job = Box<dyn FnOnce() + Send>;

/// Run `job` on the app's desktop thread, after everything asked of it before. A thread that could not be started is
/// the caller's: the job runs where it was asked.
pub(crate) fn later(job: impl FnOnce() + Send + 'static) {
    static WORKER: OnceLock<Option<Sender<Job>>> = OnceLock::new();
    let worker = WORKER.get_or_init(|| {
        let (send, receive) = mpsc::channel::<Job>();
        std::thread::Builder::new()
            .name("intentic-desktop".into())
            .spawn(move || {
                platform::enter();
                for job in receive {
                    job();
                }
            })
            .map_err(|error| eprintln!("intentic: no thread for notifications: {error}"))
            .ok()
            .map(|_| send)
    });
    match worker {
        Some(send) => {
            if let Err(mpsc::SendError(job)) = send.send(Box::new(job)) {
                job();
            }
        }
        None => job(),
    }
}

/// A toast's XML: its two lines, its link back (protocol activation, see above) and, when it asks for none, no sound.
/// Every value is escaped, so a title cannot close an element.
#[cfg(any(windows, test))]
fn toast_xml(token: &str, args: &NoticeArgs) -> String {
    let launch = escape_xml(&format!("intentic://notice?do=open&token={token}"));
    let mut xml = format!(
        "<toast launch=\"{launch}\" activationType=\"protocol\"><visual><binding template=\"ToastGeneric\"><text>{}</text>",
        escape_xml(&args.title)
    );
    if let Some(body) = &args.body {
        xml.push_str(&format!("<text>{}</text>", escape_xml(body)));
    }
    xml.push_str("</binding></visual>");
    if args.silent {
        xml.push_str("<audio silent=\"true\"/>");
    }
    xml.push_str("</toast>");
    xml
}

/// Text as XML character data or an attribute value: the five characters that mean something there, escaped.
#[cfg(any(windows, target_os = "linux", test))]
fn escape_xml(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for character in text.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&apos;"),
            _ => escaped.push(character),
        }
    }
    escaped
}

#[cfg(windows)]
mod platform {
    use tauri::AppHandle;
    use windows::core::HSTRING;
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};

    use super::Posted;
    use crate::setup_link::NoticeArgs;

    /// Every toast of the app's is in one group, so one can be taken down by its tag.
    const GROUP: &str = "intentic";

    /// The id Windows shows a toast under when the app has no Start menu shortcut of its own, as a copy run from the
    /// build tree has not: PowerShell's, as tauri-plugin-notification does. Windows shows no toast at all for an id
    /// no shortcut carries.
    const POWERSHELL: &str =
        "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

    /// The desktop thread joins the multithreaded apartment once, before its first WinRT call.
    pub fn enter() {
        // SAFETY: called once, first thing on the thread it initialises, and never paired with an uninitialise: the
        // thread lives as long as the process.
        let _ = unsafe {
            windows::Win32::System::Com::CoInitializeEx(
                None,
                windows::Win32::System::Com::COINIT_MULTITHREADED,
            )
        };
    }

    /// The app's own id, which the installer puts on its Start menu shortcut (tauri-bundler's
    /// `SetLnkAppUserModelId`, the bundle identifier), or PowerShell's for a copy that was never installed.
    fn app_id(app: &AppHandle) -> (String, bool) {
        let from_build_tree = std::env::current_exe().ok().is_some_and(|exe| {
            exe.parent().is_some_and(|dir| {
                ["debug", "release"]
                    .iter()
                    .any(|profile| dir.ends_with(std::path::Path::new("target").join(profile)))
            })
        });
        if tauri::is_dev() || from_build_tree {
            return (POWERSHELL.to_string(), false);
        }
        (app.config().identifier.clone(), true)
    }

    pub fn show(app: &AppHandle, token: &str, replaced: Option<&Posted>, args: &NoticeArgs) {
        if let Some(replaced) = replaced {
            withdraw(app, replaced);
        }
        let (id, _) = app_id(app);
        if let Err(error) = put_up(&id, token, args) {
            eprintln!("intentic: the notification could not be shown: {error}");
        }
    }

    fn put_up(id: &str, token: &str, args: &NoticeArgs) -> windows::core::Result<()> {
        let document = XmlDocument::new()?;
        document.LoadXml(&HSTRING::from(super::toast_xml(token, args)))?;
        let toast = ToastNotification::CreateToastNotification(&document)?;
        toast.SetTag(&HSTRING::from(token))?;
        toast.SetGroup(&HSTRING::from(GROUP))?;
        ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(id))?.Show(&toast)
    }

    pub fn withdraw(app: &AppHandle, posted: &Posted) {
        let (id, _) = app_id(app);
        let _ = ToastNotificationManager::History().and_then(|history| {
            history.RemoveGroupedTagWithId(
                &HSTRING::from(posted.token.as_str()),
                &HSTRING::from(GROUP),
                &HSTRING::from(id),
            )
        });
    }

    pub fn standing(app: &AppHandle) -> super::Standing {
        use super::Standing;
        use windows::UI::Notifications::NotificationSetting;
        let (id, _) = app_id(app);
        let setting = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(id))
            .and_then(|notifier| notifier.Setting());
        match setting {
            Ok(NotificationSetting::Enabled) => Standing::On,
            Ok(NotificationSetting::DisabledForUser) => Standing::OffForUser,
            Ok(NotificationSetting::DisabledByGroupPolicy) => Standing::OffByPolicy,
            Ok(
                NotificationSetting::DisabledForApplication
                | NotificationSetting::DisabledByManifest,
            ) => Standing::OffForApp,
            Ok(_) | Err(_) => Standing::Unknown,
        }
    }

    /// Every toast under the app's own id goes, which also tidies away any a run that crashed left behind. Under
    /// PowerShell's id only the app's own, by tag: the rest are PowerShell's.
    pub fn clear(app: &AppHandle, all: &[Posted]) {
        match app_id(app) {
            (id, true) => {
                let _ = ToastNotificationManager::History()
                    .and_then(|history| history.ClearWithId(&HSTRING::from(id)));
            }
            (_, false) => {
                for posted in all {
                    withdraw(app, posted);
                }
            }
        }
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use std::collections::HashMap;
    use std::sync::{LazyLock, Mutex, OnceLock};

    use tauri::{AppHandle, Manager};
    use zbus::blocking::Connection;
    use zbus::zvariant::Value;

    use super::{session_bus, Notices, Posted};
    use crate::setup_link::{NoticeArgs, NoticeKind};

    const SERVER: &str = "org.freedesktop.Notifications";
    const PATH: &str = "/org/freedesktop/Notifications";

    /// The server's id for each notification up, by the app's token: what a press and a close come back with. Only
    /// the desktop thread writes it, after the server has answered, so a withdrawal queued behind a notification
    /// finds the id it needs.
    static SERVED: LazyLock<Mutex<HashMap<String, u32>>> = LazyLock::new(Mutex::default);

    pub fn enter() {}

    pub fn show(app: &AppHandle, token: &str, replaced: Option<&Posted>, args: &NoticeArgs) {
        let Some(bus) = session_bus() else {
            return;
        };
        listen(app, bus);
        // The same key again updates the notification in place rather than putting a second one up beside it.
        let replaces = replaced
            .and_then(|replaced| SERVED.lock().unwrap().remove(&replaced.token))
            .unwrap_or(0);
        match notify(app, bus, replaces, args) {
            Ok(id) => {
                SERVED.lock().unwrap().insert(token.to_string(), id);
            }
            Err(error) => eprintln!("intentic: the notification could not be shown: {error}"),
        }
    }

    fn notify(
        app: &AppHandle,
        bus: &Connection,
        replaces: u32,
        args: &NoticeArgs,
    ) -> zbus::Result<u32> {
        let info = app.package_info();
        let body = match &args.body {
            Some(body) if markup(bus) => super::escape_xml(body),
            Some(body) => body.clone(),
            None => String::new(),
        };
        let mut hints: HashMap<&str, Value> = HashMap::new();
        // The entry its packages install, so the desktop names the notification after the app, draws its icon, and
        // files it under the app's own notification settings.
        hints.insert("desktop-entry", Value::from(info.name.as_str()));
        hints.insert("urgency", Value::U8(1));
        if args.silent {
            hints.insert("suppress-sound", Value::Bool(true));
        } else {
            // The freedesktop sound theme's names, which a desktop that plays notification sounds plays only when
            // asked for one.
            let sound = match args.kind {
                NoticeKind::Asks => "message-new-instant",
                NoticeKind::Finished => "complete",
            };
            hints.insert("sound-name", Value::from(sound));
        }
        let reply = bus.call_method(
            Some(SERVER),
            PATH,
            Some(SERVER),
            "Notify",
            &(
                info.name.as_str(),
                replaces,
                // The icon its packages install, named after the binary (tauri-bundler `list_icon_files`).
                info.crate_name,
                args.title.as_str(),
                body.as_str(),
                // `default` is the press on the notification itself; the label is what a server that draws it as a
                // button shows.
                vec!["default", "Open"],
                hints,
                -1_i32,
            ),
        )?;
        reply.body().deserialize::<u32>()
    }

    /// Whether the server draws markup in a body, which is then escaped; one that does not shows the text as it is.
    fn markup(bus: &Connection) -> bool {
        static MARKUP: OnceLock<bool> = OnceLock::new();
        *MARKUP.get_or_init(|| {
            bus.call_method(Some(SERVER), PATH, Some(SERVER), "GetCapabilities", &())
                .ok()
                .and_then(|reply| reply.body().deserialize::<Vec<String>>().ok())
                .is_some_and(|capabilities| capabilities.iter().any(|it| it == "body-markup"))
        })
    }

    fn close(bus: &Connection, id: u32) {
        let _ = bus.call_method(
            Some(SERVER),
            PATH,
            Some(SERVER),
            "CloseNotification",
            &(id,),
        );
    }

    pub fn withdraw(_app: &AppHandle, posted: &Posted) {
        let id = SERVED.lock().unwrap().remove(&posted.token);
        if let (Some(bus), Some(id)) = (session_bus(), id) {
            close(bus, id);
        }
    }

    pub fn clear(app: &AppHandle, all: &[Posted]) {
        for posted in all {
            withdraw(app, posted);
        }
    }

    /// Whether a notification service answers: all a Linux desktop says. Its own switch for the app, and Do Not
    /// Disturb, are not anybody's to ask.
    pub fn standing(_app: &AppHandle) -> super::Standing {
        let Some(bus) = session_bus() else {
            return super::Standing::NoService;
        };
        match bus.call_method(
            Some(SERVER),
            PATH,
            Some(SERVER),
            "GetServerInformation",
            &(),
        ) {
            Ok(_) => super::Standing::On,
            Err(_) => super::Standing::NoService,
        }
    }

    /// The token a server id belongs to.
    fn token_of(id: u32) -> Option<String> {
        SERVED
            .lock()
            .unwrap()
            .iter()
            .find_map(|(token, served)| (*served == id).then(|| token.clone()))
    }

    /// Hear the server's presses and closes, once, on a thread of their own for the life of the app.
    fn listen(app: &AppHandle, bus: &Connection) {
        static LISTENING: OnceLock<()> = OnceLock::new();
        LISTENING.get_or_init(|| {
            let rule = zbus::MatchRule::builder()
                .msg_type(zbus::message::Type::Signal)
                .interface(SERVER)
                .and_then(|rule| rule.path(PATH))
                .map(|rule| rule.build());
            let messages = match rule.and_then(|rule| {
                zbus::blocking::MessageIterator::for_match_rule(rule, bus, Some(64))
            }) {
                Ok(messages) => messages,
                Err(error) => {
                    eprintln!("intentic: a press on a notification will not be heard: {error}");
                    return;
                }
            };
            let app = app.clone();
            let _ = std::thread::Builder::new()
                .name("intentic-notices".into())
                .spawn(move || {
                    for message in messages.flatten() {
                        heard(&app, &message);
                    }
                });
        });
    }

    fn heard(app: &AppHandle, message: &zbus::Message) {
        let header = message.header();
        match header.member().map(|member| member.as_str()) {
            Some("ActionInvoked") => {
                let Ok((id, action)) = message.body().deserialize::<(u32, String)>() else {
                    return;
                };
                if action != "default" {
                    return;
                }
                let Some(token) = token_of(id) else {
                    return;
                };
                SERVED.lock().unwrap().remove(&token);
                let app = app.clone();
                // Off this thread, where every other link of the app's is answered.
                tauri::async_runtime::spawn(async move { super::open(&app, &token) });
            }
            // Dismissed, expired or taken down: nothing can press it any more.
            Some("NotificationClosed") => {
                let Ok((id, _reason)) = message.body().deserialize::<(u32, u32)>() else {
                    return;
                };
                if let Some(token) = token_of(id) {
                    SERVED.lock().unwrap().remove(&token);
                    app.state::<Notices>().0.lock().unwrap().take_token(&token);
                }
            }
            _ => {}
        }
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
mod platform {
    use tauri::AppHandle;

    use super::Posted;
    use crate::setup_link::NoticeArgs;

    pub fn enter() {}
    pub fn standing(_app: &AppHandle) -> super::Standing {
        super::Standing::Unknown
    }
    pub fn show(_app: &AppHandle, _token: &str, _replaced: Option<&Posted>, _args: &NoticeArgs) {}
    pub fn withdraw(_app: &AppHandle, _posted: &Posted) {}
    pub fn clear(_app: &AppHandle, _all: &[Posted]) {}
}

/// The session bus, once per run: what the notification server and the docks are reached on. None on a desktop without
/// one, where nothing of this is drawn anyway.
#[cfg(target_os = "linux")]
pub(crate) fn session_bus() -> Option<&'static zbus::blocking::Connection> {
    static BUS: OnceLock<Option<zbus::blocking::Connection>> = OnceLock::new();
    BUS.get_or_init(|| {
        zbus::blocking::Connection::session()
            .map_err(|error| eprintln!("intentic: no session bus for notifications: {error}"))
            .ok()
    })
    .as_ref()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::setup_link::NoticeKind;

    fn posted(book: &mut Book, key: &str, token: &str) -> (Option<Posted>, Vec<Posted>) {
        book.post(
            key,
            token.to_string(),
            Some(format!("/?conversation={key}")),
        )
    }

    #[test]
    fn the_same_key_replaces_the_notification_before_it() {
        let mut book = Book::default();
        assert_eq!(posted(&mut book, "a", "t1"), (None, vec![]));
        let (replaced, pushed_out) = posted(&mut book, "a", "t2");
        assert_eq!(replaced.map(|it| it.token), Some("t1".to_string()));
        assert_eq!(pushed_out, vec![]);
        assert_eq!(book.posted.len(), 1);
        assert_eq!(book.take_token("t1"), None, "the replaced one is gone");
        assert_eq!(
            book.take_token("t2").and_then(|it| it.path),
            Some("/?conversation=a".to_string())
        );
    }

    #[test]
    fn the_oldest_goes_once_the_book_is_full() {
        let mut book = Book::default();
        for index in 0..KEPT {
            assert_eq!(
                posted(&mut book, &format!("k{index}"), &format!("t{index}")).1,
                vec![]
            );
        }
        let (_, pushed_out) = posted(&mut book, "one more", "t-new");
        assert_eq!(
            pushed_out
                .into_iter()
                .map(|it| it.token)
                .collect::<Vec<_>>(),
            vec!["t0".to_string()]
        );
        assert_eq!(book.posted.len(), KEPT);
    }

    #[test]
    fn a_press_or_a_withdrawal_takes_its_notification_out_and_a_clear_takes_them_all() {
        let mut book = Book::default();
        posted(&mut book, "a", "t1");
        posted(&mut book, "b", "t2");
        posted(&mut book, "c", "t3");
        assert_eq!(
            book.take_key("b").map(|it| it.token),
            Some("t2".to_string())
        );
        assert_eq!(book.take_key("b"), None);
        assert_eq!(
            book.take_token("t1").map(|it| it.key),
            Some("a".to_string())
        );
        assert_eq!(
            book.take_all()
                .into_iter()
                .map(|it| it.key)
                .collect::<Vec<_>>(),
            vec!["c".to_string()]
        );
        assert!(book.posted.is_empty());
    }

    #[test]
    fn a_token_is_one_an_open_link_carries() {
        let token = mint_token();
        assert_eq!(token.len(), 32);
        assert!(crate::setup_link::is_notice_token(&token));
        assert_ne!(token, mint_token());
    }

    fn notice(title: &str, body: Option<&str>, silent: bool) -> NoticeArgs {
        NoticeArgs {
            key: "k".into(),
            kind: NoticeKind::Asks,
            title: title.into(),
            body: body.map(str::to_string),
            path: None,
            silent,
        }
    }

    #[test]
    fn a_toast_carries_its_lines_and_its_way_back_escaped() {
        assert_eq!(
            toast_xml("abc", &notice("Fix <the> \"login\" & more", Some("Needs you · Permission"), false)),
            "<toast launch=\"intentic://notice?do=open&amp;token=abc\" activationType=\"protocol\"><visual>\
             <binding template=\"ToastGeneric\"><text>Fix &lt;the&gt; &quot;login&quot; &amp; more</text>\
             <text>Needs you · Permission</text></binding></visual></toast>"
        );
    }

    #[test]
    fn a_silent_toast_says_so_and_a_toast_without_a_body_has_one_line() {
        assert_eq!(
            toast_xml("abc", &notice("Done", None, true)),
            "<toast launch=\"intentic://notice?do=open&amp;token=abc\" activationType=\"protocol\"><visual>\
             <binding template=\"ToastGeneric\"><text>Done</text></binding></visual><audio silent=\"true\"/></toast>"
        );
    }

    #[test]
    fn the_page_hears_the_systems_word_as_a_plain_event() {
        assert_eq!(
            standing_script(Standing::OffForUser),
            "window.dispatchEvent(new CustomEvent('intentic-desktop-notices', { detail: { setting: \"off-user\" } }));"
        );
        let words: Vec<&str> = [
            Standing::On,
            Standing::OffForUser,
            Standing::OffForApp,
            Standing::OffByPolicy,
            Standing::NoService,
            Standing::Unknown,
        ]
        .into_iter()
        .map(Standing::word)
        .collect();
        assert_eq!(
            words,
            ["on", "off-user", "off-app", "off-policy", "none", "unknown"]
        );
    }

    #[test]
    fn escaping_leaves_everything_else_as_it_is() {
        assert_eq!(escape_xml("it's <b>&"), "it&apos;s &lt;b&gt;&amp;");
        assert_eq!(escape_xml("Zażółć · ✓"), "Zażółć · ✓");
    }
}
