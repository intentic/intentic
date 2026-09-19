# Passkeys for the sandbox, and the owner's rule that one is required

Written 2026-09-14 from the source as it stands. The question asked: let people who sign into a sandbox raise
their own security with passkeys, and decide whether a sandbox may require a second factor. The answer, stated
once here and argued below: **the sandbox daemon is the passkey's relying party; a passkey alone opens a
sandbox; the owner may make it the only thing that does; recovery codes keep that switch from locking the owner
out.** Companion to the trust-root paragraph in [topology.md](../architecture/topology.md) (what a sandbox
session is) and [second-sign-in-analysis.md](../audits/second-sign-in-analysis.md) (why Google is asked once).

## 1. Where a passkey has to live

A sandbox has two credentials with two verifiers. The **platform** session is Better Auth's, established by
Google, and buys the editor at `app.intentic.dev`. The **sandbox** session is the daemon's own: a Google ID
token verified against Google's keys in the box, then a 30-day HMAC session the daemon signs with a secret that
never leaves it (`_sandbox/sandbox/src/auth/`). The line between them is the product's central promise: the
platform never holds or forges a credential that drives a sandbox, so a platform breach reads a URL and
commands nothing.

A passkey at the platform (Better Auth ships a plugin) would sign someone into `app.intentic.dev` and open no
sandbox: the daemon would still want its Google token. Making the daemon *accept* a platform-signed proof of a
platform passkey would move the boundary the promise stands on. So the passkey is registered **with the
sandbox**: the daemon issues the WebAuthn challenge, the daemon verifies the response, the daemon stores the
public key, in `.intentic/identity/passkeys.json` beside `members.json` in the same trust class (`identity`
portability, locked from the file API). An assertion mints a daemon session with no Google in the loop. The
platform learns nothing new. The relying-party id is the editor origin's host, taken from the request's
`Origin` header, which must already pass the daemon's CORS allowlist ([auth/browser-origins.ts](../../_sandbox/sandbox/src/auth/browser-origins.ts)
is now the one place that list is read); `localhost` serves the local profile. Two sandboxes reached from one
editor origin therefore share an rpId, so the user handle is `sha256(sandboxId:email)`: without that, an
authenticator would overwrite one sandbox's passkey with the other's.

Verification is written in the daemon rather than taken from a library
([auth/passkeys/webauthn.ts](../../_sandbox/sandbox/src/auth/passkeys/webauthn.ts)). The libraries' bulk is attestation-format
verification (packed, TPM, Android, Apple), which is a policy about *which authenticator* made a key; this
sandbox has no such policy and asks for `attestation: "none"`. What remains is the byte layout around a
signature: CBOR, authenticator data, a COSE key to JWK, `node:crypto` for ES256, RS256 and EdDSA, user
verification required, the counter rule. It is tested against a software authenticator that produces the
real bytes ([harness/passkey-authenticator.testing.ts](../../_sandbox/sandbox/src/harness/passkey-authenticator.testing.ts)),
so every refusal in the verifier is exercised by a response that is wrong in exactly that way.

## 2. What "require a passkey" means

A passkey with user verification is possession plus a biometric or PIN: two factors, and phishing-resistant,
which a Google ID token minted in a browser is not. So the rule is not "Google, then a passkey"; it is **a
passkey is the only proof that opens the sandbox.** Under it:

- Every session carries how it was proven (`amr`: `google`, `ticket`, `passkey`, `recovery`), and the
  authorizer reads it on every request like it reads the roster
  ([auth/auth.ts](../../_sandbox/sandbox/src/auth/auth.ts)). A session minted before the switch stops working on
  its next call; a session without the claim at all is refused, since the policy could not read it.
- A Google proof, or the hosted lane's platform-signed owner ticket, answers **428** with whether the caller
  holds a passkey. The hosted exception to the trust boundary closes with it: the platform's ticket alone no
  longer drives a hosted sandbox whose owner turned the rule on.
- Someone with **no** passkey yet may spend a Google proof on one thing: registering their first, on the two
  registration routes and nowhere else. Someone who **holds** one gets no such allowance: only that passkey
  opens the door, registration included. That is the clause that stops a stolen Google account from enrolling
  its own key.
- The rule covers owner and members alike (the GitHub-organisation model). A member without a passkey meets
  the enrolment on their next sign-in; there is no per-member exemption to forget.
- Removing a passkey ends every session it opened: the session names its credential, and a named credential
  that no longer exists is a refusal. Live streams of that person are closed at the same moment, so a lost
  device is out now, not at its next request.

Programs are not people and are not covered: a control token is minted by a person, scoped at mint, and
cannot reach the trust surface anyway; door, CI and sync tokens likewise. Retiring access (account deletion)
takes the owner's Google proof with the rule on, because it only removes access.

## 3. Lockout, and what is done about it

The one failure that matters is an owner with the rule on and no passkey left. Three guards:

1. The switch refuses to go on until the owner holds a passkey (409), and the owner cannot remove their last
   one while it is on (409): the rule always has something to open the door with.
2. Turning it on hands the owner **eight one-time recovery codes**, 20 characters from an alphabet without
   `i l o 0 1`, shown once; the daemon keeps sha256 hashes. A code plus the owner's Google proof mints a
   session (`amr: google, recovery`) with which a new passkey can be registered. Ten wrong codes close the
   door for fifteen minutes; the codes' entropy is what makes the hashes safe at rest, the limiter is what
   stops a script hammering the route.
3. A member who loses every passkey is reset by the owner removing theirs on the Access tab; they re-enrol
   with Google. Members have no codes because the owner is above them.

## 4. What the browser does

The editor's session module gained a third answer to the exchange ([sandboxSession.ts](../../_editor/web/src/features/sandbox/session/sandboxSession.ts)):
a 428 raises the **step-up** on the sign-in gate ([SigninGate.vue](../../_editor/web/src/features/sandbox/gates/SigninGate.vue)),
which asks for the passkey held, or walks through adding the first under the Google proof that was just
taken, or (owner only) takes a recovery code. With nothing in hand at all, the gate shows Google's button and,
once the daemon says a passkey is registered for this origin, a passkey beside it; the two race, and the road
not taken is closed. Every daemon call treats 428 like 401: drop the bearer, re-establish once, retry. The
Access tab lists each person's passkeys (the owner sees everyone's, to reset a member), adds one, and holds the
switch with its codes ([PasskeysSection.vue](../../_editor/web/src/features/sandbox/access/PasskeysSection.vue)).
Registering a passkey upgrades the session that asked, so switching the rule on right after does not ask for
it again.

## 5. Known limits

- A webview without WebAuthn (the Linux desktop shell, the iOS shell) cannot run the ceremony. Google keeps
  working there, and under the rule the recovery code is the owner's way in from such a window; a member must
  open the sandbox in a browser.
- A passkey is bound to the editor host it was registered on. A self-hosted platform on another origin, or a
  move of the app's host, means registering again; the row on the Access tab names the host.
- Platform sign-in stays Google-only. If passkeys are wanted at `app.intentic.dev` too, Better Auth's passkey
  plugin is the path; it changes nothing here.
