---
name: npmjs
description: Act on npmjs.com as the logged-in user through a real browser — approve staged publishes, answer WebAuthn/2FA prompts, manage access tokens and package settings. Use when npm asks for a web approval, a publish needs 2FA the CLI cannot answer, or the user asks to do something on npmjs.com.
---

# npmjs.com (connected browser)

Home: https://www.npmjs.com · a package: https://www.npmjs.com/package/<NAME> · account menu (tokens, 2FA,
packages) is under the avatar, top right.

${accounts}

This browser holds the account's passkey (the sandbox's own software security key), so WebAuthn/2FA prompts
complete by themselves — if a 2FA dialog appears, wait a beat and snapshot again before assuming it is stuck.

- Approve a staged or pending publish: open the approval link npm printed (or the package's page → pending
  publishes), click Approve — the 2FA step self-answers.
- CLI web-auth handoff: when `npm login` or `npm publish` prints an `https://www.npmjs.com/auth/...` URL,
  navigate to it here; the WebAuthn step completes and the CLI proceeds on its own.
- Tokens: avatar → `Access Tokens` to create or revoke granular tokens. Confirm with the user before revoking
  anything.
- Package settings: invite maintainers, change access, or deprecate from the package's Settings/Admin tab.
${tools}
