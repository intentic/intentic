---
name: npm
description: Publish and manage packages on the npm registry (npmjs.com) — publish, dist-tags, deprecate, owners, download stats, private installs. Use when the user asks to publish, release or manage an npm package, or to inspect the registry.
---

# npm (connected)

The npm CLI is already authenticated for `registry.npmjs.org` (the token also sits in `$NPM_TOKEN` for curl).

- Who am I: `npm whoami`
- Inspect: `npm view <PKG>` · versions: `npm view <PKG> versions` · tags: `npm view <PKG> dist-tags`
- Publish (from the package dir): `npm publish` — a scoped package's first publish needs `--access public`
- Dist-tags: `npm dist-tag add <PKG>@<VERSION> <TAG>` / `npm dist-tag ls <PKG>`
- Deprecate: `npm deprecate <PKG>@"<RANGE>" "<MESSAGE>"`
- Owners / access: `npm owner ls <PKG>` · `npm access list packages`
- Downloads (no auth): `curl -s https://api.npmjs.org/downloads/point/last-week/<PKG> | jq`

## 2FA / one-time codes

When a write is refused with an OTP/one-time-password error, mint a code and retry in one step:
`npm publish --otp "$(otp ${id})"`. Codes die within seconds — mint at the moment of use, never ahead, and
never ask the user for a code before trying `otp ${id}`.

If `otp ${id}` says no TOTP secret is stored: the account is on WebAuthn. When the npmjs.com browser is
connected (its skill exists beside this one), take the web path — navigate to the `https://www.npmjs.com/auth/...`
URL the CLI prints (or the publish's approval link) in that browser; its passkey answers the 2FA step by
itself. Only with neither the TOTP secret nor that browser connected do you stop and ask the user.

## Failure modes worth naming

- A 401/403 from a token that worked before is almost always an EXPIRED token (npm caps write tokens at 90
  days): tell the user to paste a fresh one under Sandbox ▸ Secrets rather than retrying.
- A Bypass-2FA token may STAGE a publish for the owner to approve on npmjs.com instead of completing it —
  approve it in the connected npmjs.com browser, or report the staged state if that browser isn't connected.
