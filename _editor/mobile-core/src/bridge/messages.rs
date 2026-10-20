//! Every shape that crosses the bridge as JSON. typeshare reads this file to write the app's Kotlin (and Swift) types,
//! so a field is added here and nowhere else. Ids are 32-bit: typeshare refuses 64-bit integers, which JSON numbers
//! cannot carry exactly in every language it targets.

use serde::{Deserialize, Serialize};
use typeshare::typeshare;

/// What the core needs to start: where the platform and the web editor live.
#[typeshare]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    /// The platform API, `https://api.intentic.dev`.
    pub api_url: String,
    /// The web editor, `https://app.intentic.dev`: what the shared WebView loads.
    pub web_url: String,
    /// This app's WebAuthn origin, `android:apk-key-hash:<base64url(sha256(signing certificate))>`, which a daemon
    /// admits for the editor's passkeys once the editor's asset links list the certificate. Absent, passkeys are off.
    #[serde(default)]
    pub passkey_origin: Option<String>,
    /// 32 random bytes, base64, that seal the sessions the store keeps. The app keeps them wrapped by a key in the
    /// Android Keystore and unwraps them for each start, so the store on disk is useless without this device's
    /// Keystore.
    pub secret_key: String,
}

/// What the app asks the core to do. Each call is numbered; its answer comes back as [`Event::Reply`].
#[typeshare]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "content")]
pub enum Request {
    /// Answered with the same text: proves the round trip, and is what the bridge benchmark times.
    Ping {
        echo: String,
    },
    /// Mails a six-digit sign-in code to `email`.
    SendEmailCode {
        email: String,
    },
    SignInWithEmailCode {
        email: String,
        code: String,
    },
    /// A Google ID token from Credential Manager, minted for the web client id.
    #[serde(rename_all = "camelCase")]
    SignInWithGoogle {
        id_token: String,
    },
    /// Finishes a sign-in made in the browser: the handoff the `intentic://` link carried and the PKCE verifier the
    /// app kept when it opened the browser.
    RedeemHandoff {
        handoff: String,
        verifier: String,
    },
    SignOut,
    /// Reads the sandboxes again from the platform.
    RefreshSandboxes,
    /// Makes `sandbox` (the platform's id for it) the one the board shows, and connects to it.
    OpenSandbox {
        sandbox: String,
    },
    /// Shows `agent`'s conversation: its kept rows at once, then its newest page, then its live run as it streams.
    /// Rows are read with `Core.rowCount` and `Core.row` as [`Event::Rows`] says they changed.
    OpenConversation {
        agent: String,
    },
    /// Stops following `agent`'s conversation and lets its rows go.
    CloseConversation {
        agent: String,
    },
    /// Reads the page of rows above the first one shown.
    OlderRows {
        agent: String,
    },
    /// Sends a message: into `agent`'s conversation, or a new one when `agent` is absent (the answer names it). It
    /// shows in the conversation at once and is kept until the daemon takes it, so a send made offline goes out when
    /// the sandbox is back.
    Send {
        agent: Option<String>,
        text: String,
        /// Files already uploaded, as workspace paths.
        attachments: Vec<String>,
    },
    /// Says something into `agent`'s running turn between its tool calls; sent as a message when none runs.
    Steer {
        agent: String,
        text: String,
    },
    /// Stops `agent`'s running turn.
    Stop {
        agent: String,
    },
    /// Answers the card a turn is parked on.
    Answer {
        answer: CardAnswer,
    },
    /// This phone's FCM token, new or rotated: registered on the platform's relay and subscribed on each sandbox.
    RegisterPush {
        token: String,
    },
    /// What a notification said: `sandbox` and `tag` are what the relay's FCM message carried. Answered with
    /// [`Outcome::Notification`], whose words are absent when the daemon no longer has them.
    Notification {
        sandbox: String,
        tag: String,
    },
    /// What the shared WebView needs to be signed in as this app is: the platform's session cookie, and the open (or
    /// named) sandbox's daemon session for the page's `intenticEmbed.adoptSession`. Answered with
    /// [`Outcome::WebSession`]. These are credentials: the app hands them to its own WebView and nowhere else.
    WebSession {
        sandbox: Option<String>,
    },
    /// What Credential Manager needs to sign in to `sandbox` with a passkey, or to add one when `register`: answered
    /// with [`Outcome::PasskeyOptions`].
    PasskeyOptions {
        sandbox: String,
        register: bool,
    },
    /// Credential Manager's answer (`authenticationResponseJson`, or `registrationResponseJson` when `register`),
    /// which the daemon turns into a session; the link then connects.
    PasskeyResponse {
        sandbox: String,
        register: bool,
        json: String,
    },
    /// The app came into sight (`true`) or left it. Out of sight the core closes the sandbox's live stream, which
    /// would otherwise count the person present and hold back their notifications.
    Visible {
        visible: bool,
    },
    /// Debug builds and the bench only: holds `agent`'s conversation as the spike's fixture (`json`, the contents of
    /// `_editor/android-native/fixture/soft-deletes.json`) inflated to `rows` rows, with no sandbox. When `stream_ms`
    /// is above 0, the fixture's turn then streams in for that long, starting `stream_delay_ms` later, as live rows.
    #[serde(rename_all = "camelCase")]
    OpenFixture {
        agent: String,
        json: String,
        rows: u32,
        stream_ms: u32,
        stream_delay_ms: u32,
    },
}

/// An answer to a card, by the card's request id.
#[typeshare]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "content")]
pub enum CardAnswer {
    #[serde(rename_all = "camelCase")]
    Plan {
        request_id: String,
        approve: bool,
        feedback: Option<String>,
    },
    /// The chosen labels or the person's own words, by each question's text; `cancelled` waves it away.
    #[serde(rename_all = "camelCase")]
    Question {
        request_id: String,
        answers: std::collections::HashMap<String, Vec<String>>,
        cancelled: bool,
    },
    #[serde(rename_all = "camelCase")]
    Permission {
        request_id: String,
        decision: PermissionDecision,
    },
    /// A hand-over in the browser (`terminal` false) or the terminal, done or declined.
    #[serde(rename_all = "camelCase")]
    Help {
        request_id: String,
        terminal: bool,
        helped: bool,
    },
    #[serde(rename_all = "camelCase")]
    Offer {
        request_id: String,
        offer: OfferKind,
        accept: bool,
    },
    /// What a page sent back, as JSON text.
    #[serde(rename_all = "camelCase")]
    Page {
        request_id: String,
        value: Option<String>,
        cancelled: bool,
    },
}

/// What a card row offers to answer with, read by `Core.card(agent, index)` for a row of kind card: the text is in
/// `Core.row`, this is what its buttons need.
#[typeshare]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardRow {
    pub kind: CardRowKind,
    pub request_id: String,
    /// Still holding its turn open on a person; an answered card draws no buttons.
    pub pending: bool,
    /// A question card's questions.
    pub questions: Vec<CardQuestion>,
    /// What a permission's "always" allows, in the card's own words.
    pub always_label: Option<String>,
    /// A page-ask card's page, which the app opens at the web's `/agents/<id>/pages/<page_id>` to be answered there.
    pub page_id: Option<String>,
}

#[typeshare]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CardRowKind {
    Plan,
    Question,
    Permission,
    BrowserHelp,
    TerminalHelp,
    CapabilityOffer,
    PaymentOffer,
    CredentialOffer,
    PageAsk,
}

#[typeshare]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardQuestion {
    pub question: String,
    pub header: Option<String>,
    pub multi_select: bool,
    pub options: Vec<CardOption>,
}

#[typeshare]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CardOption {
    pub label: String,
    pub description: Option<String>,
}

#[typeshare]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PermissionDecision {
    /// This call.
    Once,
    /// What the card's always-label names, for the conversation.
    Always,
    /// This call and every later one an allow-once could settle.
    Everything,
    Deny,
}

#[typeshare]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum OfferKind {
    Capability,
    Payment,
    Credential,
}

/// What the core tells the app, on a core thread: the app moves it to the main thread itself. Each state event
/// carries the whole of its state, not a change to it, so the app never has to merge.
#[typeshare]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "content")]
pub enum Event {
    /// The answer to call `id`.
    Reply { id: i32, outcome: Outcome },
    /// Who is signed in: sent as the core starts, from what it kept, and on every change.
    Session { state: SessionState },
    /// The sandboxes this account can open, and which one is open.
    Sandboxes {
        sandboxes: Vec<SandboxRow>,
        open: Option<String>,
    },
    /// The open sandbox's agents, newest activity first. Sent from the store before the network answers.
    Board {
        sandbox: String,
        cards: Vec<BoardCard>,
    },
    /// How the connection to the open sandbox stands.
    Link { sandbox: String, state: LinkState },
    /// `agent`'s rows changed: there are `count` now, and `change` says which, in a list adapter's terms.
    Rows {
        agent: String,
        count: u32,
        change: RowChange,
        /// A run is streaming in.
        live: bool,
        /// Older rows can be read with [`Request::OlderRows`].
        more: bool,
    },
}

#[typeshare]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "content")]
pub enum RowChange {
    Reset,
    Inserted { at: u32, count: u32 },
    Changed { at: u32, count: u32 },
    Removed { at: u32, count: u32 },
}

/// How a call ended.
#[typeshare]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "content")]
pub enum Outcome {
    Done,
    /// The JSON for `GetPublicKeyCredentialOption`, or `CreatePublicKeyCredentialRequest` when it registers.
    PasskeyOptions {
        json: String,
    },
    /// For `CookieManager.setCookie(api_url, "<cookie>; Secure; HttpOnly; SameSite=Lax; Path=/")` and the page's
    /// `adoptSession(sandbox, daemon)`.
    #[serde(rename_all = "camelCase")]
    WebSession {
        api_url: String,
        /// `name=value`, as the platform set it.
        cookie: String,
        daemon: Option<WebDaemonSession>,
    },
    /// A notification's words, fetched from its sandbox over the person's own session. `title` absent: the daemon
    /// no longer has them (or never sent them to this person), and the app says something generic.
    #[serde(rename_all = "camelCase")]
    Notification {
        title: Option<String>,
        body: Option<String>,
        /// The in-app path it opens: `/?conversation=<id>`, `/workspace`, `/automations`.
        url: Option<String>,
        require_interaction: bool,
        silent: bool,
    },
    /// A message went out, or is kept to go out (`queued` false means the daemon took it).
    Sent {
        agent: String,
        queued: bool,
    },
    Pong {
        echo: String,
    },
    /// `code` is the server's own name for what went wrong when it gave one (Better Auth's `INVALID_OTP`,
    /// `OTP_EXPIRED`, `TOO_MANY_ATTEMPTS`; oRPC's `NOT_FOUND`, `FORBIDDEN`), for the app to say in its own words.
    Failed {
        message: String,
        code: Option<String>,
    },
}

/// A daemon session as the web client keeps one (`{token, expiresAt, email}`), for the sandbox it opens.
#[typeshare]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDaemonSession {
    pub sandbox: String,
    pub token: String,
    /// Epoch milliseconds.
    pub expires_at: f64,
    pub email: String,
}

#[typeshare]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "content")]
pub enum SessionState {
    SignedOut,
    SignedIn { email: String },
}

#[typeshare]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SandboxRow {
    /// The platform's id, what [`Request::OpenSandbox`] names.
    pub id: String,
    pub name: String,
    /// owner, admin, member or viewer: what the account may do there.
    pub role: String,
    /// A hosted sandbox that is asleep, which opening wakes.
    pub asleep: bool,
}

/// One agent on the board, as its card draws it.
#[typeshare]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardCard {
    pub id: String,
    /// Absent until a turn has named it.
    pub title: Option<String>,
    pub lane: BoardLane,
    /// The daemon's own status word (working, awaiting, idle, failed, ...).
    pub status: String,
    /// A turn is running and doing something.
    pub working: bool,
    /// It did something since it was last opened.
    pub unread: bool,
    pub model: Option<String>,
    /// What a running turn is on: the last tool and its target, or the checklist item.
    pub activity: Option<String>,
    /// The sentence the last turn failed on.
    pub failure: Option<String>,
    /// When it last did something, epoch milliseconds.
    pub updated_at: f64,
    /// The agent that started it, for a subagent: the board nests it there.
    pub parent: Option<String>,
    pub checklist_done: Option<u32>,
    pub checklist_total: Option<u32>,
}

/// The board's three lanes, as the web board draws them (`agent-lanes.ts`).
#[typeshare]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BoardLane {
    Attention,
    Active,
    Finished,
}

#[typeshare]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "content")]
pub enum LinkState {
    Connecting,
    Live,
    /// Lost; trying again in `retry_in_ms`.
    #[serde(rename_all = "camelCase")]
    Reconnecting {
        retry_in_ms: u32,
    },
    /// The sandbox would not open for this account: `reason` says why, in a sentence.
    Refused {
        reason: String,
    },
    /// The platform session ended: sign in again.
    SignInRequired,
    /// The sandbox asks for a passkey: `enrolled` says whether this person has one to sign in with, or must add one.
    /// The app asks for [`Request::PasskeyOptions`], runs Credential Manager, and answers with
    /// [`Request::PasskeyResponse`].
    PasskeyRequired {
        enrolled: bool,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_and_events_cross_as_tagged_json() {
        let request: Request =
            serde_json::from_str(r#"{"type":"Ping","content":{"echo":"hi"}}"#).unwrap();
        assert_eq!(request, Request::Ping { echo: "hi".into() });
        let event = Event::Reply {
            id: 7,
            outcome: Outcome::Pong { echo: "hi".into() },
        };
        assert_eq!(
            serde_json::to_string(&event).unwrap(),
            r#"{"type":"Reply","content":{"id":7,"outcome":{"type":"Pong","content":{"echo":"hi"}}}}"#
        );
    }
}
