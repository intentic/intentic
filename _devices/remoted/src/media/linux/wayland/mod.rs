//! A Wayland session's screen (GNOME, KDE, and wlroots desktops for watching): the desktop portal's screen cast
//! ([`portal`]), its frames over PipeWire ([`pipewire`], opened at run time), and input through the portal's
//! RemoteDesktop ([`input`]).
//!
//! The person at the computer is asked once, by the portal's own dialog on their screen; the restore token the portal
//! hands back is kept per user, so later sessions open without asking. While the dialog waits, a viewer's open answers
//! at once that the person is being asked (and `/info` says `consent: "pending"`); a viewer opening again after they
//! answered gets the screen. A refusal is not asked again for a minute. The portal session ends with the screen (its
//! last viewer gone a while), which takes the compositor's "sharing" indicator off their screen.

pub mod input;
pub mod keycodes;
pub mod pipewire;
pub mod pod;
pub mod portal;

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use cast_core::capture::{Capture, ScreenSource};
use cast_core::geometry::Rect;
use cast_core::hub::Hub;

/// The one screen a Wayland session shares (the monitor the person picks in the portal's dialog).
pub const SCREEN_ID: &str = "wayland";

/// How long a refusal stands before a viewer's open asks the person again.
const ASK_AGAIN_AFTER: Duration = Duration::from_secs(60);

/// Where the portal session stands.
#[derive(Clone)]
enum Consent {
    /// No session, and none asked for.
    None,
    /// The portal is asking (or restoring); since when.
    Asking(Instant),
    Granted(Arc<portal::Session>),
    Refused(Instant, String),
    /// The portal is missing or failed: the next open tries again.
    Failed(String),
}

pub struct Wayland {
    consent: Arc<Mutex<Consent>>,
    /// The picture's size, last seen: what `/info` lists before a session exists.
    size: Arc<Mutex<Option<(u32, u32)>>>,
}

impl Default for Wayland {
    fn default() -> Self {
        Wayland {
            consent: Arc::new(Mutex::new(Consent::None)),
            size: Arc::new(Mutex::new(None)),
        }
    }
}

/// What a viewer's open waits for, then says.
const ASKING: &str = "the person at this computer is being asked to allow sharing its screen (the desktop portal's \
                      dialog on its screen); open it again once they have answered";

impl Wayland {
    /// The screen's size for `/info`: the stream's last, else a guess the media hello corrects.
    pub fn size(&self) -> (u32, u32) {
        self.size
            .lock()
            .expect("wayland poisoned")
            .unwrap_or((1920, 1080))
    }

    /// `/info`'s `consent` and the words that go with it.
    pub fn consent(&self) -> (&'static str, Option<String>) {
        match &*self.consent.lock().expect("wayland poisoned") {
            Consent::None if portal::has_token() => ("remembered", None),
            Consent::None => (
                "none",
                Some("the person at this computer will be asked to allow sharing its screen when a viewer opens it".into()),
            ),
            Consent::Asking(since) => (
                "pending",
                Some(format!("{ASKING} (asked {} s ago)", since.elapsed().as_secs())),
            ),
            Consent::Granted(_) => ("granted", None),
            Consent::Refused(_, why) => ("refused", Some(why.clone())),
            Consent::Failed(why) => ("failed", Some(why.clone())),
        }
    }

    /// The session, started (or restored) when there is none: waits a few seconds for a restore token to answer, else
    /// says the person is being asked and lets the dialog run on.
    fn session(
        &self,
        address: &str,
        runtime: &tokio::runtime::Handle,
    ) -> Result<Arc<portal::Session>, String> {
        {
            let consent = self.consent.lock().expect("wayland poisoned");
            match &*consent {
                Consent::Granted(s) => return Ok(s.clone()),
                Consent::Asking(_) => return Err(ASKING.into()),
                Consent::Refused(at, why) if at.elapsed() < ASK_AGAIN_AFTER => {
                    return Err(format!(
                        "{why}; they will be asked again in {} s",
                        (ASK_AGAIN_AFTER - at.elapsed()).as_secs().max(1)
                    ));
                }
                _ => {}
            }
        }
        *self.consent.lock().expect("wayland poisoned") = Consent::Asking(Instant::now());
        let consent = self.consent.clone();
        let address = address.to_owned();
        runtime.spawn(async move {
            let outcome = portal::start(&address).await;
            let mut c = consent.lock().expect("wayland poisoned");
            *c = match outcome {
                Ok(session) => {
                    log::info!(
                        "portal: screen cast granted ({} stream(s), input {}, cursor {})",
                        session.streams.len(),
                        if session.input { "on" } else { "off" },
                        if session.cursor_metadata {
                            "as metadata"
                        } else {
                            "in the picture"
                        },
                    );
                    let session = Arc::new(session);
                    let watched = session.clone();
                    let consent = consent.clone();
                    tokio::spawn(async move {
                        watched.closed().await;
                        let mut c = consent.lock().expect("wayland poisoned");
                        if matches!(&*c, Consent::Granted(s) if Arc::ptr_eq(s, &watched)) {
                            log::info!(
                                "portal: the session was closed (sharing stopped at the computer)"
                            );
                            *c = Consent::None;
                        }
                    });
                    Consent::Granted(session)
                }
                Err(portal::Refusal::Refused) => {
                    log::info!("portal: the person at the computer did not allow sharing");
                    Consent::Refused(Instant::now(), portal::Refusal::Refused.to_string())
                }
                Err(e) => {
                    log::warn!("portal: {e}");
                    Consent::Failed(e.to_string())
                }
            };
        });
        let started = Instant::now();
        while started.elapsed() < portal::QUICK_ANSWER {
            match &*self.consent.lock().expect("wayland poisoned") {
                Consent::Granted(s) => return Ok(s.clone()),
                Consent::Refused(_, why) | Consent::Failed(why) => return Err(why.clone()),
                _ => {}
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        Err(ASKING.into())
    }

    /// Opens the shared screen: the session, a PipeWire stream of its first monitor, and its input.
    pub fn open(&self, address: &str, hub: &Arc<Hub>) -> Result<Opened, String> {
        let runtime = tokio::runtime::Handle::try_current()
            .map_err(|_| "no async runtime to reach the desktop portal from".to_string())?;
        pipewire::available()?;
        let session = self.session(address, &runtime)?;
        let stream = *session
            .streams
            .first()
            .ok_or("the desktop portal started no screen cast")?;
        let fd = runtime
            .block_on(session.pipewire())
            .map_err(|e| e.to_string())?;
        let pw = pipewire::Stream::connect(fd, stream.node, hub.clone())?;
        let picture = Arc::new(Mutex::new((0u32, 0u32)));
        let input = session.input.then(|| {
            input::WaylandInput::new(session.clone(), runtime.clone(), stream, picture.clone())
        });
        let consent = self.consent.clone();
        let closing = session.clone();
        let stop: super::super::Stop = Box::new(move || {
            // The portal session ends with the screen, its indicator with it; a restore token reopens it unasked.
            let mut c = consent.lock().expect("wayland poisoned");
            if matches!(&*c, Consent::Granted(s) if Arc::ptr_eq(s, &closing)) {
                *c = Consent::None;
            }
            drop(c);
            runtime.spawn(async move { closing.close().await });
        });
        Ok(Opened {
            source: Box::new(Screen {
                stream: pw,
                picture,
                size: self.size.clone(),
            }),
            input,
            stop,
        })
    }
}

/// What `open` makes, for the platform to start.
pub struct Opened {
    pub source: Box<dyn ScreenSource>,
    pub input: Option<input::WaylandInput>,
    pub stop: super::super::Stop,
}

/// The stream as cast-core's screen source: a capture of its current picture, opened again when its size changes.
struct Screen {
    stream: pipewire::Stream,
    picture: Arc<Mutex<(u32, u32)>>,
    size: Arc<Mutex<Option<(u32, u32)>>>,
}

impl ScreenSource for Screen {
    fn open(&mut self, _crop: Option<Rect>) -> Result<Box<dyn Capture>, String> {
        let capture = self.stream.capture(Duration::from_secs(10))?;
        let a = capture.area();
        *self.picture.lock().expect("picture poisoned") = (a.w, a.h);
        *self.size.lock().expect("size poisoned") = Some((a.w, a.h));
        Ok(capture)
    }
}
