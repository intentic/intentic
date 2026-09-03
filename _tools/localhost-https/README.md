# @intentic-app/localhost-https

A certificate authority for this machine and a localhost certificate under it, so development runs over real
HTTPS with the browser's lock rather than its warning.

## Responsibilities

- Mint, on install, the root this machine develops under and the leaf certificate the API and Vite serve with.
- Install that root into the trust stores that decide whether the browser shows a lock: on request, in one
  command, on Windows (including from WSL), macOS, Linux and Firefox.
- Renew the leaf before it expires, under the same root, so neither a stale certificate nor a re-approval ever
  surfaces as a browser error.

## Key files

- [generate.mjs](generate.mjs): mints the root and the leaf, idempotently. Runs from `prepare`.
- [trust.mjs](trust.mjs): puts the root into the OS and Firefox trust stores. Runs from `pnpm cert:trust`.
- [paths.mjs](paths.mjs): where the pair lives, and the two bugs that put it there. Read this one first.
- [package.json](package.json): the `prepare` hook, and the `./paths` export consumers resolve the pair through.

## How it fits

Development-only. Several browser behaviours the app depends on: secure cookies, partitioned storage, some
clipboard and media APIs: differ between `http://localhost` and real HTTPS, so developing over plain HTTP means
finding those differences in production instead. Google's FedCM One Tap simply refuses `http://localhost`.

Nothing hardcodes where the pair is, because it is in your own data directory and that differs per person and
per OS. Vite, the API and the port probe's test all import the locations from `@intentic-app/localhost-https/paths`
instead. `API_HTTPS_KEY`/`API_HTTPS_CERT` still win when set, for serving some other certificate.

Setup is two commands, and the second is once per machine, not once per clone:

```sh
pnpm install        # mints the pair for this machine, first time only
pnpm cert:trust     # approves the root — answer Yes to the OS prompt
```

## Conventions & gotchas

- **Both halves live outside the repository, together**: in the OS's own per-user data directory, never beside
  this file. Outside, because a trust store belongs to a machine, so a root that lived per checkout would mean
  re-approving a browser warning for every clone, worktree and sandbox workspace on the same laptop. Together,
  because a workspace folder is shared with every container mounted on it while each container has its own home
  directory: keeping the certificate in the repository let an agent running the installer inside a sandbox
  re-sign it with a root that died with the container, leaving the host serving a chain nothing could validate.
- **"Per machine" is really per home directory, so mind where you run the installer.** Running it inside a
  container gives that container its own pair, which is correct and harmless: but it is not the pair the
  browser on your desktop sees, and `cert:trust` there approves a root no browser will ever consult.
- **The root and the leaf renew separately.** The root is good for ten years; the leaf lives 825 days under it
  and is re-signed in place. Throwing the root away with the leaf would silently revoke the approval you gave
  it, so nothing does that unless the root itself is missing or expiring: and then it says so.
- **The CA private key is never committed.** It used to be, on the argument that a localhost CA protects
  nothing. That argument was wrong in one specific way: a CA is only useful once it is in a trust store, and
  this one is meant to go into yours. Anybody holding its private key can mint a certificate for *any* hostname,
  and every machine trusting that root accepts it. The published root was `CA:TRUE`, carried no name
  constraints, and was valid until 2035: so it vouched for the whole DNS namespace on behalf of everyone who
  followed the old instructions. If you trusted it, remove it from your trust store.
- **The `.gitignore` here still lists names nothing writes any more, deliberately.** They were dropped once, on
  the reasoning that the files had moved: and a checkout that had run the older generator still had the pair
  sitting here, no longer ignored, so the next commit that staged everything pushed a private key. Leave them.
- **The generated root is name-constrained** to `localhost`, `localhost.com` and the loopback addresses, so it
  cannot vouch for anything else even on the machine that holds its key.
- **A browser already running keeps its warning.** One that has been clicked through to "proceed anyway" for
  localhost remembers that for the rest of its run and still says *Not secure* after the certificate verifies.
  Restarting it is what clears that, not re-running anything here.
- **`cert:trust` waits on a dialog on Windows.** Installing a root is exactly what an OS should not allow
  silently, so Windows asks; from WSL the prompt appears on the Windows desktop while the terminal sits quiet.
- **It needs `openssl` on PATH**: every dev image here has it, and so does macOS. **Windows does not**, which
  makes this the one prerequisite a first `pnpm install` there fails on: `generate.mjs` runs from `prepare`, so
  a missing binary takes the whole install down with it. Git for Windows already ships the binary — add
  `C:\Program Files\Git\usr\bin` to PATH, or run the install from Git Bash. Firefox additionally needs NSS's
  tools (`nss` on Arch, `libnss3-tools` on Debian and Ubuntu) and is skipped, with a note, without them.
