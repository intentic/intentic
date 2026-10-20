//! Signing in to one sandbox: `POST /system/session` trades a proof for the daemon's own session, and a live session
//! for a fresh one. The proof rides the `Authorization: Bearer` header, not the body (there is none): a Google ID token,
//! the platform's identity assertion (`platform::IDENTITY_ASSERTION`), a hosted owner ticket, or the session itself.
//! The daemon tells them apart by their shape. Schemas: `DaemonSessionSchema`, `PasskeyRequiredSchema`.

use super::endpoint::Endpoint;
use super::lenient::{Millis, open_enum};
use serde::{Deserialize, Serialize};

pub const SESSION: Endpoint = Endpoint::post("/system/session");

/// The header a sandbox's connect token travels in. Only the owner's first sign-in on a sandbox that has never bound
/// one needs it (`SandboxSummary::token`); the daemon ignores it afterwards.
pub const CONNECT_TOKEN_HEADER: &str = "x-intentic-connect";

/// A minted session. `token` is every later call's bearer; renew ahead of `expires_at` (30 days out, the web renews
/// inside the last 7) by calling [`SESSION`] again with the token itself.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonSession {
    pub token: String,
    pub expires_at: Millis,
    /// Who the sandbox verified the caller as.
    pub email: String,
}

open_enum! {
    /// What a 428 asks for. Only passkeys exist today.
    pub enum StepUpProof {
        Passkey = "passkey",
    }
}

/// The 428 body: the person is welcome, but this sandbox requires a passkey and the proof had none. `enrolled` says
/// whether they hold one to answer with, or must add their first.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PasskeyRequired {
    pub error: String,
    pub requires: StepUpProof,
    pub enrolled: bool,
}

open_enum! {
    /// The machine-readable half of a 401 or 403, for the refusals a client acts on (sandbox-contract's
    /// `EMAIL_SIGN_IN_OFF`, `PLATFORM_KEY_UNKNOWN`, and the daemon's own `OWNER_UNREADABLE`).
    pub enum RefusalReason {
        /// 403: this person signs in here with Google or a passkey, not the platform's word for their address. The
        /// owner turns email sign-in on for them.
        EmailSignInOff = "email-sign-in-off",
        /// 401: the daemon has not learned the platform's identity key yet. Worth a retry, not a new sign-in.
        PlatformKeyUnknown = "platform-key-unknown",
        /// 401: the daemon cannot read who owns it; nobody can sign in until the host fixes it.
        OwnerUnreadable = "owner-unreadable",
    }
}

/// A 401 or 403 body. A member below a route's tier gets a 403 naming the tier it needs in `floor` instead of a reason.
/// No schema holds this one: the daemon writes it by hand in its auth middleware (`_sandbox/sandbox/src/app.ts`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Refusal {
    pub error: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<RefusalReason>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub floor: Option<MemberRole>,
}

open_enum! {
    /// A person's tier on a sandbox, lowest first (`MemberRoleSchema`).
    pub enum MemberRole {
        Guest = "guest",
        Viewer = "viewer",
        Collaborator = "collaborator",
        Writer = "writer",
        Maintainer = "maintainer",
        Owner = "owner",
    }
}

/// What a refused exchange means for the person, read the way the web reads it (`sandboxSession.ts` `exchange`).
#[derive(Debug, Clone, PartialEq)]
pub enum SessionRefusal {
    /// Ask for a passkey (or walk through adding a first one when `enrolled` is false).
    StepUp(PasskeyRequired),
    /// Try the same proof again shortly.
    PlatformKeyUnknown,
    /// The person must ask the owner to allow email sign-in for them.
    EmailSignInOff,
    /// The proof is dead (expired, revoked, not for this sandbox), or the person is not a member: sign in afresh.
    Unauthorized(Option<Refusal>),
    /// A verified person this sandbox will not open for.
    Forbidden(Option<Refusal>),
    /// Any other failure, which says nothing about the proof.
    Failed { status: u16 },
}

impl SessionRefusal {
    /// Reads a non-2xx answer to [`SESSION`]. A 428 whose body is not the contract's still means a step-up, with
    /// `enrolled` false: the daemon refusing a second passkey is what tells the truth then.
    pub fn of(status: u16, body: &str) -> SessionRefusal {
        let refusal = serde_json::from_str::<Refusal>(body).ok();
        let reason = refusal.as_ref().and_then(|refusal| refusal.reason.clone());
        match status {
            428 => SessionRefusal::StepUp(serde_json::from_str(body).unwrap_or(PasskeyRequired {
                error: "this sandbox requires a passkey".into(),
                requires: StepUpProof::Passkey,
                enrolled: false,
            })),
            401 if reason == Some(RefusalReason::PlatformKeyUnknown) => {
                SessionRefusal::PlatformKeyUnknown
            }
            401 => SessionRefusal::Unauthorized(refusal),
            403 if reason == Some(RefusalReason::EmailSignInOff) => SessionRefusal::EmailSignInOff,
            403 => SessionRefusal::Forbidden(refusal),
            status => SessionRefusal::Failed { status },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_each_refusal_the_way_the_web_does() {
        let step_up =
            SessionRefusal::of(428, r#"{"error":"x","requires":"passkey","enrolled":true}"#);
        assert!(matches!(
            step_up,
            SessionRefusal::StepUp(PasskeyRequired { enrolled: true, .. })
        ));
        assert!(matches!(
            SessionRefusal::of(428, "<html>"),
            SessionRefusal::StepUp(PasskeyRequired {
                enrolled: false,
                ..
            })
        ));
        let key = SessionRefusal::of(
            401,
            r#"{"error":"unauthorized","reason":"platform-key-unknown"}"#,
        );
        assert_eq!(key, SessionRefusal::PlatformKeyUnknown);
        let off = SessionRefusal::of(403, r#"{"error":"no","reason":"email-sign-in-off"}"#);
        assert_eq!(off, SessionRefusal::EmailSignInOff);
        assert!(matches!(
            SessionRefusal::of(401, r#"{"error":"unauthorized"}"#),
            SessionRefusal::Unauthorized(Some(_))
        ));
        assert_eq!(
            SessionRefusal::of(502, ""),
            SessionRefusal::Failed { status: 502 }
        );
    }
}
