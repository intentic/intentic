# @intentic-app/localhost-https

A certificate authority for this machine and a localhost certificate under it, so development runs over real
HTTPS with the browser's lock rather than its warning.

## Responsibilities

- Mint, on install, the root this machine develops under and the leaf certificate the API and Vite serve with.
- Install that root into the trust stores that decide whether the browser shows a lock — on request, in one
  command, on Windows (including from WSL), macOS, Linux and Firefox.
- Renew the leaf before it expires, under the same root, so neither a stale certificate nor a re-approval ever
  surfaces as a browser error.

## Key files

- [generate.mjs](generate.mjs) — mints the root and the leaf, idempotently. Runs from `prepare`.
- [trust.mjs](trust.mjs) — puts the root into the OS and Firefox trust stores. Runs from `pnpm cert:trust`.
- [paths.mjs](paths.mjs) — where each half lives, and why the root is not one of them.
- [package.json](package.json) — the `prepare` hook, and how the files are resolved by the packages that use them.

## How it fits

Development-only. Several browser behaviours the app depends on — secure cookies, partitioned storage, some
clipboard and media APIs — differ between `http://localhost` and real HTTPS, so developing over plain HTTP means
finding those differences in production instead. Google's FedCM One Tap simply refuses `http://localhost`.

The API reads its pair through `API_HTTPS_KEY`/`API_HTTPS_CERT`, Vite reads the same one directly, and both
resolve it through `node_modules/@intentic-app/localhost-https/`, which links here.

Setup is two commands, and the second is once per machine, not once per clone:

```sh
pnpm install        # mints the root (first time) and this checkout's leaf
pnpm cert:trust     # approves the root — answer Yes to the OS prompt
```

## Conventions & gotchas

- **The root is per machine and lives outside the repository** — in the OS's own per-user data directory, not
  beside this file. A trust store is a property of a machine, so a root that lived per checkout would mean
  re-approving a browser warning for every clone, worktree and sandbox workspace on the same laptop. Only the
  leaf is here, and it is git-ignored.
- **The root and the leaf renew separately.** The root is good for ten years; the leaf lives 825 days under it
  and is re-signed in place. Throwing the root away with the leaf would silently revoke the approval you gave
  it, so nothing does that unless the root itself is missing or expiring — and then it says so.
- **The CA private key is never committed.** It used to be, on the argument that a localhost CA protects
  nothing. That argument was wrong in one specific way: a CA is only useful once it is in a trust store, and
  this one is meant to go into yours. Anybody holding its private key can mint a certificate for *any* hostname,
  and every machine trusting that root accepts it. The published root was `CA:TRUE`, carried no name
  constraints, and was valid until 2035 — so it vouched for the whole DNS namespace on behalf of everyone who
  followed the old instructions. If you trusted it, remove it from your trust store.
- **The generated root is name-constrained** to `localhost`, `localhost.com` and the loopback addresses, so it
  cannot vouch for anything else even on the machine that holds its key.
- **A browser already running keeps its warning.** One that has been clicked through to "proceed anyway" for
  localhost remembers that for the rest of its run and still says *Not secure* after the certificate verifies.
  Restarting it is what clears that, not re-running anything here.
- **`cert:trust` waits on a dialog on Windows.** Installing a root is exactly what an OS should not allow
  silently, so Windows asks; from WSL the prompt appears on the Windows desktop while the terminal sits quiet.
- **It needs `openssl` on PATH** — every dev image here has it, and so does macOS. Firefox additionally needs
  NSS's tools (`nss` on Arch, `libnss3-tools` on Debian and Ubuntu) and is skipped, with a note, without them.
