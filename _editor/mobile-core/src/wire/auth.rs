//! Signing in to the platform: Better Auth's routes under `/api/auth` on the API origin (`_platform/api/src/auth.ts`).
//! Their request bodies are in `api.schema.json` beside the oRPC procedures'; their answers are Better Auth's own and
//! have no schema to check against.
//!
//! Two surprises. The platform runs no bearer plugin, so the `token` a sign-in answers with opens nothing by itself:
//! the session is the `Set-Cookie` that comes with it ([`SESSION_COOKIE`]; its value is that token plus a signature),
//! and every later platform call carries that cookie. And a POST carrying the cookie must also carry an `Origin` the
//! platform trusts, its web origin (`https://app.intentic.dev`), or Better Auth refuses it as a forgery: sign-out is the
//! one such call here. Sign-ins carry no cookie and are not checked.

use super::endpoint::Endpoint;
use super::platform::User;
use serde::{Deserialize, Serialize};

/// Mails a six-digit code: [`EmailCodeRequest`] in, [`Success`] out. Answers alike whether or not an account holds the
/// address; the first sign-in creates one, so the terms are shown before this is sent.
pub const SEND_EMAIL_CODE: Endpoint = Endpoint::post("/api/auth/email-otp/send-verification-otp");
/// Spends the code: [`EmailCodeSignIn`] in, [`SignedIn`] out, with the session cookie.
pub const SIGN_IN_EMAIL_CODE: Endpoint = Endpoint::post("/api/auth/sign-in/email-otp");
/// Spends a Google ID token from Credential Manager (its audience the web client id): [`GoogleSignIn`] in,
/// [`SignedIn`] out, with the session cookie. Every daemon accepts the same token at `/system/session`.
pub const GOOGLE_SIGN_IN: Endpoint = Endpoint::post("/api/auth/one-tap/callback");
/// Spends the desktop handoff's one-time token (`platform::Redeemed::ott`): [`OneTimeToken`] in, [`Verified`] out,
/// with the session cookie.
pub const VERIFY_ONE_TIME_TOKEN: Endpoint = Endpoint::post("/api/auth/one-time-token/verify");
/// Ends the platform session: no body, [`Success`] out. Needs the cookie and a trusted `Origin` (see above).
pub const SIGN_OUT: Endpoint = Endpoint::post("/api/auth/sign-out");

/// The session cookie's name over https, where Better Auth adds the `__Secure-` prefix.
pub const SESSION_COOKIE: &str = "__Secure-better-auth.session_token";

/// Only sign-in codes are mailed here: the platform has no passwords to reset.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EmailCodeRequest {
    pub email: String,
    #[serde(rename = "type")]
    pub kind: EmailCodeKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EmailCodeKind {
    SignIn,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EmailCodeSignIn {
    pub email: String,
    pub otp: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleSignIn {
    pub id_token: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OneTimeToken {
    pub token: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Success {
    pub success: bool,
}

/// A sign-in's answer. `token` is the raw session token, useless without its cookie's signature (see above).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SignedIn {
    pub token: String,
    pub user: AuthUser,
}

/// The one-time token's answer: the session it opened, and whose.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Verified {
    pub session: AuthSession,
    pub user: AuthUser,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthSession {
    pub token: String,
    /// ISO instant.
    pub expires_at: String,
}

/// Better Auth's own account record, which is not the api-contract's [`User`] (no sign-in methods, a verified flag).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthUser {
    pub id: String,
    pub email: String,
    #[serde(default)]
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    #[serde(default)]
    pub email_verified: bool,
}

impl From<AuthUser> for User {
    fn from(user: AuthUser) -> User {
        User {
            id: user.id,
            email: user.email,
            name: user.name,
            image: user.image,
            sign_in_methods: None,
        }
    }
}

/// How Better Auth refuses: `code` names the case (`INVALID_OTP`, `OTP_EXPIRED`, `TOO_MANY_ATTEMPTS`,
/// `INVALID_ORIGIN`), `message` says it in English.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AuthError {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(default)]
    pub message: String,
}
