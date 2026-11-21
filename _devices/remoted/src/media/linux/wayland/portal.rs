//! The desktop portal (xdg-desktop-portal) on the person's session bus, through zbus: a RemoteDesktop session with a
//! screen cast in it (ScreenCast + RemoteDesktop), or a screen cast alone where the portal has no RemoteDesktop
//! (wlroots), which leaves every viewer watching. The person at the computer is asked once; `persist_mode` 2 makes the
//! portal hand back a restore token, kept per user, so later sessions open without asking until they revoke it.
//!
//! Every portal call answers with a Request object whose `Response` signal carries the result; the signal is
//! subscribed to before the call (its path is known in advance from the handle token), so a fast answer is not missed.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use futures_util::StreamExt as _;
use zbus::zvariant::{ObjectPath, OwnedFd, OwnedObjectPath, OwnedValue, Value};

const DEST: &str = "org.freedesktop.portal.Desktop";
const PATH: &str = "/org/freedesktop/portal/desktop";
const REMOTE: &str = "org.freedesktop.portal.RemoteDesktop";
const CAST: &str = "org.freedesktop.portal.ScreenCast";

/// ScreenCast source types and cursor modes, RemoteDesktop device types (the portal's spec).
const SOURCE_MONITOR: u32 = 1;
const CURSOR_EMBEDDED: u32 = 2;
const CURSOR_METADATA: u32 = 4;
const DEVICE_KEYBOARD: u32 = 1;
const DEVICE_POINTER: u32 = 2;
/// Persist until the person revokes it.
const PERSIST_UNTIL_REVOKED: u32 = 2;

/// The portal's answer to a request: 0 granted, 1 the person said no, 2 anything else.
const RESPONSE_CANCELLED: u32 = 1;

/// Why a portal session did not start.
#[derive(Debug, Clone)]
pub enum Refusal {
    /// The person at the computer said no (or closed the dialog).
    Refused,
    /// The portal is missing or failed.
    Failed(String),
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Refusal::Refused => {
                f.write_str("the person at this computer did not allow sharing its screen")
            }
            Refusal::Failed(why) => f.write_str(why),
        }
    }
}

impl From<zbus::Error> for Refusal {
    fn from(e: zbus::Error) -> Self {
        Refusal::Failed(format!("the desktop portal: {e}"))
    }
}

/// One screen-cast stream the portal started.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StreamInfo {
    /// The PipeWire node to connect to.
    pub node: u32,
    /// Where it is in the compositor's logical space, and its logical size: what pointer motion is given in.
    pub position: (i32, i32),
    pub size: (i32, i32),
}

/// A started portal session.
pub struct Session {
    pub conn: zbus::Connection,
    pub handle: OwnedObjectPath,
    pub streams: Vec<StreamInfo>,
    /// Whether input goes through it (a RemoteDesktop session with a keyboard and a pointer).
    pub input: bool,
    /// Whether the cursor comes as metadata (else it is drawn into the picture).
    pub cursor_metadata: bool,
}

impl Session {
    /// A PipeWire remote for this session's streams.
    pub async fn pipewire(&self) -> Result<std::os::fd::OwnedFd, Refusal> {
        let options: HashMap<&str, Value> = HashMap::new();
        let reply = self
            .conn
            .call_method(
                Some(DEST),
                PATH,
                Some(CAST),
                "OpenPipeWireRemote",
                &(&self.handle, options),
            )
            .await?;
        let fd: OwnedFd = reply.body().deserialize()?;
        Ok(fd.into())
    }

    /// Ends the session: the portal stops the cast and the compositor its "sharing" indicator.
    pub async fn close(&self) {
        let _ = self
            .conn
            .call_method(
                Some(DEST),
                &self.handle,
                Some("org.freedesktop.portal.Session"),
                "Close",
                &(),
            )
            .await;
    }

    /// Sends a RemoteDesktop notification without waiting for its reply: input goes out in order on the one
    /// connection, and nothing waits on the portal between two events.
    pub async fn notify<B>(&self, method: &'static str, body: &B)
    where
        B: serde::Serialize + zbus::zvariant::DynamicType,
    {
        let msg = zbus::message::Message::method_call(PATH, method)
            .and_then(|b| b.destination(DEST))
            .and_then(|b| b.interface(REMOTE))
            .and_then(|b| b.with_flags(zbus::message::Flags::NoReplyExpected))
            .and_then(|b| b.build(body));
        match msg {
            Ok(msg) => {
                if let Err(e) = self.conn.send(&msg).await {
                    log::debug!("portal: {method}: {e}");
                }
            }
            Err(e) => log::debug!("portal: {method}: {e}"),
        }
    }

    /// Resolves when the portal or the compositor closes the session (the person stopped sharing).
    pub async fn closed(&self) {
        let rule = zbus::MatchRule::builder()
            .msg_type(zbus::message::Type::Signal)
            .interface("org.freedesktop.portal.Session")
            .and_then(|r| r.member("Closed"))
            .and_then(|r| r.path(self.handle.as_ref()))
            .map(|r| r.build());
        let Ok(rule) = rule else { return };
        if let Ok(mut stream) = zbus::MessageStream::for_match_rule(rule, &self.conn, Some(4)).await
        {
            let _ = stream.next().await;
        }
    }
}

/// Where the session bus is: the session's own address, else systemd's per-user socket.
pub fn bus_address(found: Option<&str>, runtime_dir: Option<&str>, uid: u32) -> String {
    if let Some(a) = found.filter(|a| !a.is_empty()) {
        return a.to_owned();
    }
    let dir = runtime_dir
        .map(str::to_owned)
        .unwrap_or_else(|| format!("/run/user/{uid}"));
    format!("unix:path={dir}/bus")
}

/// The restore token, kept per user (in the home of whoever runs remoted, the session's own user).
fn token_file() -> Option<PathBuf> {
    let state = std::env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/state")))
        .or_else(|| {
            super::super::session::home_of(unsafe { libc::geteuid() })
                .map(|h| h.join(".local/state"))
        })?;
    Some(state.join("intentic-remoted").join("portal-restore-token"))
}

fn read_token() -> Option<String> {
    let text = std::fs::read_to_string(token_file()?).ok()?;
    let token = text.trim();
    (!token.is_empty()).then(|| token.to_owned())
}

fn write_token(token: &str) {
    use std::io::Write as _;
    use std::os::unix::fs::OpenOptionsExt as _;
    let Some(path) = token_file() else { return };
    if let Some(dir) = path.parent() {
        use std::os::unix::fs::{DirBuilderExt as _, PermissionsExt as _};
        let _ = std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir);
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }
    let tmp = path.with_extension("tmp");
    let written = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&tmp)
        .and_then(|mut f| f.write_all(token.as_bytes()))
        .and_then(|()| std::fs::rename(&tmp, &path));
    if let Err(e) = written {
        log::warn!(
            "portal: the restore token could not be kept in {}: {e}",
            path.display()
        );
    }
}

/// Forgets the restore token (the portal refused it, or the person revoked it).
pub fn forget_token() {
    if let Some(path) = token_file() {
        let _ = std::fs::remove_file(path);
    }
}

/// Whether a restore token is kept: a session started now should open without asking the person.
pub fn has_token() -> bool {
    read_token().is_some()
}

static TOKENS: AtomicU32 = AtomicU32::new(0);

fn token(prefix: &str) -> String {
    format!(
        "intentic_{prefix}_{}_{}",
        std::process::id(),
        TOKENS.fetch_add(1, Ordering::Relaxed)
    )
}

/// Calls a portal method that answers through a Request (its options carrying `handle` as `handle_token`), and
/// waits for the Response, as long as the person takes to answer a dialog.
async fn request<B>(
    conn: &zbus::Connection,
    interface: &str,
    method: &str,
    handle: &str,
    body: &B,
) -> Result<HashMap<String, OwnedValue>, Refusal>
where
    B: serde::Serialize + zbus::zvariant::DynamicType,
{
    let sender = conn
        .unique_name()
        .ok_or_else(|| Refusal::Failed("the session bus gave no name".into()))?
        .trim_start_matches(':')
        .replace('.', "_");
    let path = format!("/org/freedesktop/portal/desktop/request/{sender}/{handle}");
    let rule = zbus::MatchRule::builder()
        .msg_type(zbus::message::Type::Signal)
        .interface("org.freedesktop.portal.Request")?
        .member("Response")?
        .path(path.as_str())?
        .build();
    let mut responses = zbus::MessageStream::for_match_rule(rule, conn, Some(4)).await?;
    let reply = conn
        .call_method(Some(DEST), PATH, Some(interface), method, body)
        .await?;
    let _: OwnedObjectPath = reply.body().deserialize()?;
    let Some(Ok(response)) = responses.next().await else {
        return Err(Refusal::Failed(format!(
            "the desktop portal never answered {method}"
        )));
    };
    let (code, results): (u32, HashMap<String, OwnedValue>) = response.body().deserialize()?;
    match code {
        0 => Ok(results),
        RESPONSE_CANCELLED => Err(Refusal::Refused),
        other => Err(Refusal::Failed(format!(
            "the desktop portal ended {method} ({other})"
        ))),
    }
}

async fn property(conn: &zbus::Connection, interface: &str, name: &str) -> Option<u32> {
    let reply = conn
        .call_method(
            Some(DEST),
            PATH,
            Some("org.freedesktop.DBus.Properties"),
            "Get",
            &(interface, name),
        )
        .await
        .ok()?;
    let v: OwnedValue = reply.body().deserialize().ok()?;
    u32::try_from(v).ok()
}

/// Starts a session on the bus at `address`: asks the portal (and, without a restore token that still holds, the
/// person) for a monitor, and for the keyboard and pointer where it has RemoteDesktop.
pub async fn start(address: &str) -> Result<Session, Refusal> {
    let conn = zbus::connection::Builder::address(address)?
        .build()
        .await
        .map_err(|e| Refusal::Failed(format!("cannot reach the session bus at {address}: {e}")))?;
    // A host program has no app id the portal can keep its permission under; where the portal can register one, do.
    let _ = conn
        .call_method(
            Some(DEST),
            PATH,
            Some("org.freedesktop.host.portal.Registry"),
            "Register",
            &("dev.intentic.Remoted", HashMap::<&str, Value>::new()),
        )
        .await;
    let cast_version = property(&conn, CAST, "version").await.ok_or_else(|| {
        Refusal::Failed("the desktop portal has no ScreenCast here (xdg-desktop-portal and its backend for this desktop are needed)".into())
    })?;
    let remote_version = property(&conn, REMOTE, "version").await;
    let cursor_modes = property(&conn, CAST, "AvailableCursorModes")
        .await
        .unwrap_or(0);
    let cursor_mode = if cursor_modes & CURSOR_METADATA != 0 {
        CURSOR_METADATA
    } else {
        CURSOR_EMBEDDED
    };
    let restore = read_token();
    // RemoteDesktop persists its sessions from version 2; a screen cast alone from ScreenCast's version 4.
    let remote = remote_version.is_some();
    let persist = if remote {
        remote_version.is_some_and(|v| v >= 2)
    } else {
        cast_version >= 4
    };
    let create_interface = if remote { REMOTE } else { CAST };
    let h = token("req");
    let session_token = token("session");
    let mut o: HashMap<&str, Value> = HashMap::new();
    o.insert("handle_token", h.as_str().into());
    o.insert("session_handle_token", session_token.as_str().into());
    let created = request(&conn, create_interface, "CreateSession", &h, &(o,)).await?;
    let handle: OwnedObjectPath = created
        .get("session_handle")
        .and_then(|v| {
            String::try_from(v.try_clone().ok()?)
                .ok()
                .and_then(|s| OwnedObjectPath::try_from(s).ok())
                .or_else(|| OwnedObjectPath::try_from(v.try_clone().ok()?).ok())
        })
        .ok_or_else(|| Refusal::Failed("the desktop portal made no session".into()))?;
    let session_path = ObjectPath::try_from(handle.as_str()).expect("a path");
    let persisting = |o: &mut HashMap<&str, Value<'_>>| {
        if persist {
            o.insert("persist_mode", PERSIST_UNTIL_REVOKED.into());
            if let Some(t) = &restore {
                o.insert("restore_token", Value::from(t.clone()));
            }
        }
    };
    if remote {
        let h = token("req");
        let mut o: HashMap<&str, Value> = HashMap::new();
        o.insert("handle_token", h.as_str().into());
        o.insert("types", (DEVICE_KEYBOARD | DEVICE_POINTER).into());
        persisting(&mut o);
        request(&conn, REMOTE, "SelectDevices", &h, &(&session_path, o)).await?;
    }
    let h = token("req");
    let mut o: HashMap<&str, Value> = HashMap::new();
    o.insert("handle_token", h.as_str().into());
    o.insert("types", SOURCE_MONITOR.into());
    o.insert("multiple", false.into());
    o.insert("cursor_mode", cursor_mode.into());
    if !remote {
        persisting(&mut o);
    }
    request(&conn, CAST, "SelectSources", &h, &(&session_path, o)).await?;
    let h = token("req");
    let mut o: HashMap<&str, Value> = HashMap::new();
    o.insert("handle_token", h.as_str().into());
    let started = request(
        &conn,
        create_interface,
        "Start",
        &h,
        &(&session_path, "", o),
    )
    .await;
    let started = match started {
        Ok(s) => s,
        Err(e) => {
            // A token the portal no longer takes would ask every time; the next try asks once and keeps the new one.
            if restore.is_some() && matches!(e, Refusal::Refused) {
                forget_token();
            }
            return Err(e);
        }
    };
    if let Some(t) = started
        .get("restore_token")
        .and_then(|v| String::try_from(v.try_clone().ok()?).ok())
    {
        write_token(&t);
    }
    let devices = started
        .get("devices")
        .and_then(|v| u32::try_from(v).ok())
        .unwrap_or(0);
    let streams = started
        .get("streams")
        .and_then(parse_streams)
        .unwrap_or_default();
    if streams.is_empty() {
        return Err(Refusal::Failed(
            "the desktop portal started no screen cast".into(),
        ));
    }
    Ok(Session {
        conn,
        handle,
        streams,
        input: remote && devices & (DEVICE_KEYBOARD | DEVICE_POINTER) != 0,
        cursor_metadata: cursor_mode == CURSOR_METADATA,
    })
}

/// `streams`: `a(ua{sv})`, each a PipeWire node and its `position` and `size`.
fn parse_streams(v: &OwnedValue) -> Option<Vec<StreamInfo>> {
    let list: Vec<(u32, HashMap<String, OwnedValue>)> = v.try_clone().ok()?.try_into().ok()?;
    Some(
        list.into_iter()
            .map(|(node, props)| {
                let pair = |k: &str| {
                    props
                        .get(k)
                        .and_then(|v| <(i32, i32)>::try_from(v.try_clone().ok()?).ok())
                };
                StreamInfo {
                    node,
                    position: pair("position").unwrap_or((0, 0)),
                    size: pair("size").unwrap_or((0, 0)),
                }
            })
            .collect(),
    )
}

/// How long `start` is given before an open says the person is being asked (a restore token answers well within it).
pub const QUICK_ANSWER: Duration = Duration::from_secs(4);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bus_is_the_sessions_own_else_systemds() {
        assert_eq!(
            bus_address(Some("unix:path=/x/bus"), None, 1000),
            "unix:path=/x/bus"
        );
        assert_eq!(
            bus_address(None, Some("/run/user/7"), 7),
            "unix:path=/run/user/7/bus"
        );
        assert_eq!(
            bus_address(Some(""), None, 1000),
            "unix:path=/run/user/1000/bus"
        );
    }

    #[test]
    fn streams_read_their_node_position_and_size() {
        let mut props: HashMap<String, OwnedValue> = HashMap::new();
        props.insert(
            "position".into(),
            OwnedValue::try_from(Value::from((10i32, 20i32))).unwrap(),
        );
        props.insert(
            "size".into(),
            OwnedValue::try_from(Value::from((1920i32, 1080i32))).unwrap(),
        );
        let list = vec![(42u32, props)];
        let v = OwnedValue::try_from(Value::from(list)).unwrap();
        assert_eq!(
            parse_streams(&v),
            Some(vec![StreamInfo {
                node: 42,
                position: (10, 20),
                size: (1920, 1080)
            }])
        );
    }
}
