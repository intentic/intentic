//! How the person's remoted reaches the helper: the pipe of its own session, the secret the service wrote for this
//! user, and a check that the pipe's server runs from the service's own binary (which only an administrator can
//! write). Asked when a screen opens and every few seconds while a screen cannot see its desktop; connecting is tried at
//! most every 2 s, so a computer without the service pays one failed pipe lookup per screen open.

use super::{binary, home, pipe_name};
use cast_win::helper::client::Link;
use cast_win::helper::pipe::{self, Pipe};
use parking_lot::Mutex;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Who may own the helper's pipe: what SYSTEM's objects are owned by (its token's default owner is the Administrators
/// group), or SYSTEM itself. A process of the user cannot make an object either owns: its token's Administrators is
/// deny-only until elevated, and an elevated process is an administrator already.
const SERVICE_OWNERS: &[&str] = &["S-1-5-32-544", "S-1-5-18"];

pub struct ServiceFinder {
    name: String,
    link: Mutex<Option<Arc<Link>>>,
    last_try: Mutex<Option<Instant>>,
    said: Mutex<Option<String>>,
}

/// The finder for this process's session; None with `INTENTIC_REMOTED_NO_HELPER` set (the screen is this process's
/// own duplication whatever is installed).
pub fn finder() -> Option<Arc<dyn cast_win::helper::Finder>> {
    if std::env::var_os("INTENTIC_REMOTED_NO_HELPER").is_some() {
        return None;
    }
    let session = pipe::process_session(std::process::id()).unwrap_or(0);
    Some(Arc::new(ServiceFinder {
        name: pipe_name(session),
        link: Mutex::new(None),
        last_try: Mutex::new(None),
        said: Mutex::new(None),
    }))
}

/// Whether two paths are the same file (the running binary being the installed one).
pub fn same_file(a: &std::path::Path, b: &std::path::Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => pipe::same_path(&a, &b),
        _ => false,
    }
}

impl ServiceFinder {
    fn connect(&self) -> Result<Arc<Link>, String> {
        let secret = std::fs::read_to_string(home().join("secret")).map_err(|e| format!("the service's secret: {e}"))?;
        // The service's helper runs as SYSTEM; one run by hand for a test (another home) is the user's own.
        let owner = std::env::var_os("INTENTIC_REMOTED_SERVICE_HOME").is_none().then_some(SERVICE_OWNERS);
        Link::connect(&self.name, secret.trim(), Some(&binary()), owner)
    }

    /// Logs a failure once until it changes.
    fn say(&self, why: &str) {
        let mut said = self.said.lock();
        if said.as_deref() != Some(why) {
            log::warn!("the lock screen and admin prompts helper: {why}");
            *said = Some(why.to_owned());
        }
    }
}

impl cast_win::helper::Finder for ServiceFinder {
    fn link(&self) -> Option<Arc<Link>> {
        if let Some(link) = self.current() {
            return Some(link);
        }
        {
            let mut last = self.last_try.lock();
            if last.is_some_and(|t| t.elapsed() < Duration::from_secs(2)) {
                return None;
            }
            *last = Some(Instant::now());
        }
        if !Pipe::exists(&self.name) {
            return None;
        }
        match self.connect() {
            Ok(link) => {
                *self.said.lock() = None;
                *self.link.lock() = Some(link.clone());
                Some(link)
            }
            Err(why) => {
                self.say(&why);
                None
            }
        }
    }

    fn present(&self) -> bool {
        Pipe::exists(&self.name)
    }

    fn current(&self) -> Option<Arc<Link>> {
        self.link.lock().as_ref().filter(|l| l.alive()).cloned()
    }
}
