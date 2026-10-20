//! The platform API's oRPC procedures the app calls (`_shared/api-contract`), served under `/rpc` on the API origin and
//! authenticated by the Better Auth session cookie (`auth.rs`). Their JSON Schema is `api.schema.json`, written by
//! `scripts/api-schemas.mjs` since the api-contract keeps no lock of its own.
//!
//! Every `sandbox_id` sent here is the platform's row id, [`SandboxSummary::id`], not the 12-hex id a daemon's
//! `/health` reports and its session tokens are bound to: the platform maps one to the other.

use super::endpoint::Endpoint;
use super::session::MemberRole;
use serde::{Deserialize, Serialize};

/// The signed-in account, or JSON `null` without a session: the cheap way to ask whether the cookie still holds.
pub const ME: Endpoint = Endpoint::get("/rpc/me");
/// Which ways in this platform offers, asked before anyone has signed in: [`SignInOptions`].
pub const SIGN_IN_OPTIONS: Endpoint = Endpoint::get("/rpc/me/sign-in-options");
/// The account's own sandboxes and the ones shared with it: [`SandboxList`].
pub const SANDBOX_LIST: Endpoint = Endpoint::get("/rpc/sandbox/list");
/// The platform's signed word that the account controls its address, for one sandbox: [`SandboxId`] in,
/// [`MintedProof`] out. Spent at once as `/system/session`'s bearer; dead within minutes.
pub const IDENTITY_ASSERTION: Endpoint = Endpoint::post("/rpc/sandbox/identity-assertion");
/// A hosted sandbox's owner's way in without Google: [`SandboxId`] in, [`MintedOwnerTicket`] out, spent the same way.
pub const OWNER_TICKET: Endpoint = Endpoint::post("/rpc/sandbox/owner-ticket");
/// Wakes an asleep hosted machine: [`SandboxId`] in, [`Done`] out.
pub const WAKE: Endpoint = Endpoint::post("/rpc/sandbox/wake");
/// The desktop sign-in's first half, from a browser that is signed in: [`HandoffStart`] in, [`Handoff`] out.
pub const DESKTOP_HANDOFF: Endpoint = Endpoint::post("/rpc/desktop/handoff");
/// Its second half, sessionless, from the app the browser handed back to: [`HandoffRedeem`] in, [`Redeemed`] out.
pub const DESKTOP_REDEEM: Endpoint = Endpoint::post("/rpc/desktop/redeem");
/// Registers this install with the push relay: [`PushDevice`] in, [`PushGrant`] out.
pub const PUSH_REGISTER: Endpoint = Endpoint::post("/rpc/push/register");
pub const PUSH_UNREGISTER: Endpoint = Endpoint::post("/rpc/push/unregister");

/// An account (`UserSchema`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: String,
    pub email: String,
    pub name: String,
    pub image: Option<String>,
    /// `google`, `email`, or both; absent from a platform older than email sign-in, where every account is Google's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sign_in_methods: Option<Vec<String>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignInOptions {
    pub google: bool,
    pub email: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SandboxList {
    pub sandboxes: Vec<SandboxSummary>,
}

/// One sandbox as the platform knows it (`SandboxSummarySchema`). The fields the setup wizard and the hub read (the
/// setup and boot reports, a refused check-in, a removal) are kept whole: they are required, possibly null, so they
/// are written back as they came.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxSummary {
    /// The platform's row id: what every platform call names a sandbox by.
    pub id: String,
    pub name: String,
    /// The owner's logo, a data URL.
    pub image: Option<String>,
    /// The daemon's public base, `https://sandbox-<id>.sbx.intentic.dev`; null until it has announced one.
    pub daemon_url: Option<String>,
    /// ISO instant of its last check-in.
    pub last_seen_at: Option<String>,
    /// The connect token, on the owner's row only: the `x-intentic-connect` header of the owner's first sign-in.
    pub token: Option<String>,
    /// The account's tier here; the daemon enforces the same tier on its own, so this only shapes what is offered.
    pub role: MemberRole,
    /// The owner asserted the address (`sandbox.attach`) rather than the daemon announcing it.
    pub provided_address: bool,
    /// The loopback listener's certified name, for reaching a sandbox on this same machine.
    pub local_hostname: Option<String>,
    /// The hosted lane's machine, null off-platform. An asleep one wakes on [`WAKE`].
    pub hosted: Option<SandboxHosted>,
    /// The version its daemon named in its last check-in, known even while it is down.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub daemon_version: Option<String>,
    /// What the edge in front of `daemon_url` serves beyond HTTPS over TCP (`quic`, `h3`, `webtransport`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edge_transports: Option<Vec<String>>,
    #[serde(default)]
    pub setup_code_claimed_at: serde_json::Value,
    #[serde(default)]
    pub setup_report: serde_json::Value,
    #[serde(default)]
    pub boot_report: serde_json::Value,
    #[serde(default)]
    pub announce_refusal: serde_json::Value,
    #[serde(default)]
    pub removed_at: serde_json::Value,
    #[serde(default)]
    pub removed_by: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxHosted {
    /// awake, asleep, starting, down, unknown.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    pub region: String,
    pub warm: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub can_roll_back: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxId {
    pub sandbox_id: String,
}

/// An identity assertion: a bearer `/system/session` takes once.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MintedProof {
    pub assertion: String,
    /// ISO instant it stops verifying.
    pub expires_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MintedOwnerTicket {
    pub ticket: String,
    pub expires_at: String,
}

/// The platform's plain acknowledgement (`{ ok: boolean }`, unlike the daemon's `{ ok: true }`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Done {
    pub ok: bool,
}

/// The browser's half: a PKCE `challenge` (43 to 64 characters) and, for a Google account, the ID token the app will
/// spend on daemons.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffStart {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id_token: Option<String>,
    pub challenge: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Handoff {
    pub handoff: String,
}

/// The app's half: the handoff the `intentic://` link carried, and the PKCE verifier (43 to 128 characters).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HandoffRedeem {
    pub handoff: String,
    pub verifier: String,
}

/// `ott` is a Better Auth one-time token, spent at `auth::VERIFY_ONE_TIME_TOKEN` for the session cookie. `id_token` is
/// absent for an account that signs in by email, which then asks for identity assertions instead.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Redeemed {
    pub ott: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id_token: Option<String>,
}

/// A device to relay a sandbox's notifications to. On `android` the row names its app: the Intentic Device app is
/// woken (`{kind: "wake"}`), the editor app told what to fetch (`{kind: "notify", tag, url, sandbox, ...}`), and the
/// words never leave the platform for either. One row per sandbox, so re-registering one rotates only its secret.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PushDevice {
    pub platform: PushPlatform,
    /// The FCM registration token (or APNs device token), 1 to 400 characters.
    pub token: String,
    /// Which Android app the token belongs to; absent means the Device app, as every row before the editor app.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app: Option<PushApp>,
    /// The platform id of the sandbox this row relays for, handed back in each notify.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PushApp {
    Device,
    Editor,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PushPlatform {
    Ios,
    Android,
}

/// The relay channel to store on each daemon (`push::RelayChannel`). `secret` is shown once.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushGrant {
    pub device_id: String,
    pub secret: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushDeviceId {
    pub device_id: String,
}

/// How an oRPC procedure refuses, on the platform and the daemon alike: `code` is the oRPC name (`NOT_FOUND`,
/// `FORBIDDEN`, `CONFLICT`, `PRECONDITION_FAILED`, `UNAUTHORIZED`), `message` the server's sentence for a person.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RpcError {
    #[serde(default)]
    pub defined: bool,
    pub code: String,
    pub status: u16,
    #[serde(default)]
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}
