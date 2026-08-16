# The second Google sign-in: why it exists, and every way out

**Question.** A new user signs in with Google to reach the platform, then is asked for Google *again* before
their sandbox will talk to them. People read the second ask as a bug, and some leave at it. What are all the
ways to never ask twice?

**Short answer.** The second ask is not required by the trust model. It is a consequence of *how* the first
sign-in is performed — a server-side redirect — which produces a credential the browser never sees. One
browser-side sign-in can satisfy both sides at once, with no change to what anything trusts. That is
option 1 below, and it is the recommendation. The rest of the space is documented because each option
survives a different set of constraints, and because two of the "obvious" ones quietly move a security
boundary that a comment in the code claims is fixed.

---

## 1. What is actually happening today

Two credentials exist, for two different verifiers.

| | Platform session | Sandbox session |
|---|---|---|
| Who verifies | the platform (Better Auth) | the daemon, in the user's own sandbox |
| Obtained by | Google OAuth **redirect** (server-side code exchange) | Google **ID token**, minted in the browser by Google Identity Services |
| Proves | this browser is signed in to intentic | this caller is the sandbox's owner or a granted member |
| Lifetime | cookie, long | daemon-minted session, weeks, renews itself without Google |

The daemon's reasoning is in `_sandbox/sandbox/src/auth/auth.ts`:

> The sandbox authenticates the END USER directly against Google — the platform never holds or signs this
> credential, so a platform compromise can't command the sandbox.

The browser side (`_editor/web/src/composables/sandbox/sandboxSession.ts`) already demotes Google to a
sign-in *moment*: the first verified ID token is exchanged for a daemon-signed session that lasts weeks and
renews itself with no Google involvement. **So Google is needed exactly once per browser, per sandbox** — plus
once more after roughly a month idle. The frequency is already solved. The problem is purely that the *first*
one lands on a user who believes they just signed in.

### Why it is not already silent

`useGoogleIdentity.ts` asks Google for a silent credential first (`auto_select: true`, FedCM One Tap) and only
raises a button when that produces nothing. For a user who has just completed the platform's redirect
sign-in, that silent path should in principle succeed — and it usually does not.

The expected cause: FedCM's automatic re-authentication requires a record of a *previous FedCM sign-in on this
origin*. Consent granted through a server-side OAuth redirect does not create one. So the first browser-side
mint on a given origin always needs a user gesture, no matter how freshly the user signed in. **Worth
confirming empirically before building on it** — it is inferred from the flow and from how FedCM behaves, not
measured here.

### The claim the code makes about the platform is already softer than it reads

Before weighing options that "weaken" the boundary, the boundary should be described accurately.

1. **Both sign-ins use the same Google OAuth client.** `_tools/selfhost/platform/.env.example` instructs the
   operator to configure one client with the SPA as a JavaScript origin and the API as the redirect URI. So
   the audience the daemon insists on is the audience the *platform's own* OAuth flow receives.
2. **The platform stores the user's Google tokens.** `account.accessToken`, `account.refreshToken`,
   `account.idToken` (`_platform/prisma/schema.prisma`), encrypted at rest with a key the platform also holds
   (`_platform/api/src/auth.ts`). A refresh token plus the client secret mints a fresh ID token with the right
   audience whenever the platform likes.
3. **The desktop flow already parks a raw Google ID token on the platform** for one pickup — the
   `DesktopHandoff` row.
4. **The platform already seeds the daemon's expected owner** (`OWNER_EMAIL` in the setup payload) and holds
   the sandbox's connect token.

The property the comment describes — platform compromise cannot command the sandbox — is therefore maintained
by *policy* ("there is no decrypt path"), not by cryptography. That does not make the policy worthless; it
means an option should be judged on whether it makes the platform a *routine* issuer of daemon credentials,
not on whether it is the first to make it a possible one.

---

## 2. Options

Ordered by how little they disturb.

### Option 1 — Do the platform sign-in in the browser, and keep the credential ⭐ **shipped**

> Implemented. `oneTap()` on the platform's Better Auth instance, `signInWithGoogleCredential` in
> `useAuth.ts`, and `Login.vue` rebuilt around Google's own button. Scope note: the invite-accept page was
> deliberately left on the redirect — see §2.1.1.

Replace the redirect with Google Identity Services on the login page. The browser mints one Google ID token
and uses it twice:

- POST it to Better Auth's one-tap endpoint to establish the platform session.
- Keep it in the existing cache, where the daemon exchange already looks for it.

**One Google interaction. Two credentials. Nothing's trust changes.** The daemon still verifies Google
directly, against the same audience, with the platform holding nothing new.

- Better Auth 1.6.25 already ships the `one-tap` plugin, whose `/one-tap/callback` takes `{ idToken }` and
  signs the user in or up. No new endpoint to design.
- The rendered Google button produces the same credential as One Tap, so this is not a bet on FedCM: a
  browser that suppresses One Tap still shows a button, and one click does both jobs.
- The user-creation hook that stamps the terms version still fires, so consent capture is unaffected.
- Google-side note: the ID-token path yields no access or refresh token. The platform stores those today but
  states it never uses them, so nothing should miss them. **Verify before shipping** — if anything does, this
  option needs a companion.

Applies to all three entry points: the login page, the invite-accept page, and the desktop flow (whose browser
page would then get its credential from the same act that signs the user in).

**Keep the redirect as a fallback** for browsers where GIS cannot run at all. Those users see today's
behaviour; nobody is made worse off.

Cost: moderate, concentrated in the login page and the auth composable. Risk: low. Reversible.

#### 2.1.1 What was built, and how it fails

The credential the sandbox receives is **unchanged** — a Google-signed ID token, verified against Google's
JWKS, with the same audience as before. Nothing platform-signed goes anywhere near a daemon. So a sandbox
running an older build, a fork, or one modified specifically to distrust the platform is unaffected by any of
this. The platform became a second *consumer* of that credential; it did not become an issuer, and the
direction is one-way by construction (`useAuth.signInWithGoogleCredential` sends a token, and there is no code
path that receives one).

Four failure modes, each landing on the old redirect rather than on a dead page:

| What breaks | How it is noticed | What the user gets |
|---|---|---|
| Google's script never arrives | `renderButton` reports it rendered nothing | the redirect button |
| The platform refuses the token — a build without the endpoint, or a client-id mismatch between this app and that platform | the call throws | the redirect button, plus a line saying so |
| The user dismisses whatever Google shows | the mint resolves empty | nothing said; the button is still there |
| The button renders but cannot work — a blocked frame, a popup policy — which is invisible from the page | *not detectable* | a permanent "Trouble signing in? Use Google's own page." link under it |

The last row is the reason that link is unconditional. Every other failure can be observed and answered; that
one cannot, and without an always-present escape it reads as a sign-in page that simply does nothing.

A platform that refuses the token does **not** invalidate the cached Google credential. The two verifiers are
independent, so a platform rejection says nothing about whether the sandbox will accept it — and clearing it
would turn one refusal into a third Google prompt.

**Consent capture** is unaffected, and worth stating because it looked at risk. Google's automatic
re-authentication can only fire for someone who has already signed in this way on this origin, so a
first-ever account always passes a visible Google surface with the terms line beneath it.

**The invite-accept page was deliberately not converted.** It exists to sign someone in *as a specific
invited address*, and the silent path picks whichever Google account the browser prefers — which would land
the invitee on "wrong account" more often than it saved them a click. Right account beats one fewer click.
Invitees therefore still meet the second prompt; that is the minority path and the correct trade.

### Option 2 — Silent OIDC re-authentication as the fallback

Where GIS produces nothing, ask Google's authorization endpoint directly with `prompt=none`. A user with a
live Google session and prior consent gets an ID token back with no interaction; anyone else gets a
predictable error, which is the signal to show the button.

This is a strictly better fallback than a five-second timer, and it does not depend on FedCM at all. As a
top-level redirect it works everywhere and reads as a flash; in a hidden frame it is invisible but dies with
third-party cookies.

Best used *with* option 1, not instead of it.

### Option 3 — Hand over the ID token the platform already received

The Better Auth callback receives an ID token with exactly the audience the daemon wants. Deliver it to the
browser once, immediately after sign-in — the same move the desktop handoff already makes.

Removes the second ask with no new Google UI anywhere and no dependency on GIS. But it turns "the platform
happens to hold this" into "the platform routinely issues this", and with the stored refresh token it can keep
issuing them indefinitely. That is the boundary actually moving, even if it moves from a place that was never
as solid as advertised.

Reasonable as a *desktop-only* stopgap. Weak as the general answer, because option 1 achieves the same result
without it.

### Option 4 — Let the daemon trust the platform directly

Publish a signing key at the platform; have the daemon verify short-lived, sandbox-scoped assertions signed by
it instead of Google ID tokens. The daemon already receives the platform's word on who the owner is, so the
plumbing exists.

Pin the key at first bind (trust on first use, as ownership already is) so a later platform takeover cannot
re-point an existing sandbox. Keep the connect-token requirement.

This deletes Google from the sandbox boundary entirely and makes the whole question disappear — including for
future non-Google sign-in methods, which today would each need their own answer. It also states plainly that
platform compromise means sandbox compromise. Self-hosters running their own platform are unaffected by that;
users of the hosted one are not.

Only worth doing if the trust position is being revisited deliberately. Do not slide into it.

### Option 5 — Bind the browser to the sandbox with its own key

At setup the browser generates a non-extractable key pair (or a passkey) and the daemon binds it during
first-bind, which already requires the connect token. Afterwards the browser signs a challenge; no Google, no
platform, on the steady path.

Strictly *stronger* than today — neither Google nor the platform is in the loop — and it removes the second
ask on the first machine completely. The cost lands entirely on enrolling a second browser or device, which
can ride the existing setup code or an approval prompt inside an already-enrolled session.

The most durable answer, and the largest. Sensible as a direction, not as this month's fix.

### Option 6 — Proxy the daemon through the platform

Terminate browser auth at the platform and forward to the sandbox. One session, one sign-in, trivially.

It also ends the direct-to-sandbox architecture and the privacy story that rests on it — the platform would
see every keystroke and every file. Named here only so it is visibly rejected.

### Option 7 — Leave it in place and stop it reading as a second sign-in

Palliatives, if none of the above ship soon:

- Fold the sandbox sign-in into the setup wizard's existing connect step, so it is one flow with one heading
  rather than a sign-in that appears to repeat.
- Defer it until the user first does something that needs the sandbox, so the cost lands after the value
  rather than before it.
- Say what it is for on the gate itself, in the user's terms: this proves you to *your own machine*, and the
  platform is deliberately not in the middle.

These reduce the felt cost. They do not remove the step, and should not be mistaken for having done so.

---

## 3. Recommendation

1. **Option 1** as the fix — **done**. One browser-side Google sign-in serving both sides. It removes the
   second ask for nearly everyone, changes no trust boundary, and is reversible.
2. **Option 2** as its fallback, replacing the current "wait, then show a button" behaviour. **Not done** —
   the redirect fallback covers the same ground with no new Google surface to maintain, so this is only worth
   revisiting if measurement shows people stalling on the button.
3. **Option 7's** framing work regardless — the remaining cases (a new browser, a month away) still meet a
   Google gate, and it should read as what it is.
4. **Option 5** as the direction if this is ever revisited properly; **option 4** only alongside a deliberate
   decision about what the platform is trusted for; **option 3** only as a desktop stopgap; **option 6** not
   at all.

## 4. Still to verify, against a running platform

None of these are blocking — each has a fallback that already works — but none has been observed end to end
here, because the sandbox this was built in has no platform or Google client to sign in against.

- **The whole flow, once, in a browser.** Sign in on the login page and confirm the sandbox never asks again.
- **Access and refresh tokens.** The ID-token path supplies neither. The platform stores both today and
  states it never uses them (`_platform/api/src/auth.ts`), so nothing should miss them — worth confirming
  against a real account before this is the only door most people use.
- **Terms acceptance.** The user-creation hook that stamps the clickwrap version should fire identically on
  this path; it runs off the same internal adapter, but it has not been watched doing so.
- **Safari and Firefox with third-party cookies blocked** — the rendered button is what the whole design
  leans on when One Tap is suppressed, so its behaviour there is the load-bearing unknown.
- **Whether the silent path fails for the reason given in §1.** No longer urgent: after this change the
  browser DOES have a prior sign-in of its own on this origin, which is the record automatic
  re-authentication needs. If the reasoning is right, returning users should now be signed in with no click
  at all.
