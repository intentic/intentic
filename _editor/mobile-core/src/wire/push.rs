//! Notifications on a sandbox: the app registers its relay channel with each daemon (`POST /push/subscribe`), after
//! `platform::PUSH_REGISTER` granted it one. The daemon then posts to the relay, which wakes the app through FCM.

use super::endpoint::{Endpoint, query};
use super::platform::PushGrant;
use serde::{Deserialize, Serialize};

/// [`PushChannel`] in, `act::Accepted` out. Registering the same device again replaces its channel.
pub const SUBSCRIBE: Endpoint = Endpoint::post("/push/subscribe");
/// [`PushChannelId`] in, `act::Accepted` out.
pub const UNSUBSCRIBE: Endpoint = Endpoint::post("/push/unsubscribe");
/// Whether this device is registered, with [`config_query`]: [`PushConfig`].
pub const CONFIG: Endpoint = Endpoint::get("/push/config");
/// What a notification said, with [`notification_query`]: [`SentNotification`]. The relay carries only the tag; the
/// words come from here, over the person's own session, and only to someone the notification was sent to. One 404
/// for every miss: never sent to them, forgotten (a day, 200 tags, a restart), or a daemon older than the route.
pub const NOTIFICATION: Endpoint = Endpoint::get("/push/notification");

/// A device the daemon can notify (`PushChannelSchema`). Browsers subscribe with `webpush`, which the app never sends.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum PushChannel {
    /// A native app, notified through the platform's relay: the relay can read what passes through it.
    #[serde(rename_all = "camelCase")]
    Relay {
        /// Where the daemon posts a send.
        url: String,
        /// Identifies this registration everywhere else in the push routes.
        device_id: String,
        /// Proof that this sandbox may notify this device; the relay never learns which sandbox calls.
        secret: String,
    },
}

impl From<PushGrant> for PushChannel {
    fn from(grant: PushGrant) -> PushChannel {
        PushChannel::Relay {
            url: grant.url,
            device_id: grant.device_id,
            secret: grant.secret,
        }
    }
}

/// A native install's `device_id`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PushChannelId {
    pub id: String,
}

pub fn notification_query(tag: &str) -> String {
    query(&[("tag", Some(tag.to_owned()))])
}

/// A notification as the daemon wrote it (`PushSentNotificationSchema`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SentNotification {
    pub title: String,
    pub body: String,
    /// The in-app path it opens: `/?conversation=<id>`, `/workspace`, `/automations`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub tag: String,
    /// The agent is waiting on the person: keep it on screen.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub require_interaction: Option<bool>,
    /// The ask under this tag stopped waiting: replace it quietly.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub silent: Option<bool>,
    /// ISO instant.
    pub sent_at: String,
}

pub fn config_query(device_id: &str) -> String {
    query(&[("id", Some(device_id.to_owned()))])
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushConfig {
    /// The VAPID key a browser subscribes with; native apps ignore it.
    pub public_key: String,
    pub subscribed: bool,
}
