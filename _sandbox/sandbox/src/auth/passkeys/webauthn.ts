// The relying-party half of WebAuthn lives in @intentic/base/webauthn (2026-10-27), shared with the machine agent, which
// verifies the owner's passkey over an egress change with the same bytes. The daemon's callers keep this path.
export { ACCEPTED_ALGORITHMS, base64url, verifyAuthentication, verifyRegistration } from "@intentic/base/webauthn";
