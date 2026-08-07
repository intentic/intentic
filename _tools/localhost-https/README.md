# @intentic-app/localhost-https

A local certificate authority and a certificate for it, so development runs over real HTTPS. Both are minted
on your machine when you install, and neither is in this repository.

## Responsibilities

- Mint, on install, the CA and leaf certificate the local API and web app serve with.
- Renew the leaf before it expires, so a stale certificate never surfaces as a browser error.

## Key files

- [generate.mjs](generate.mjs) — mints the pair into this directory, idempotently. Runs from `prepare`.
- [package.json](package.json) — the `prepare` hook, and how the files are resolved by the packages that use them.

The four files it produces (`localhost-com-ca.crt`/`.key`, `localhost.crt`/`.key`) sit beside it, git-ignored.

## How it fits

Development-only. Several browser behaviours the app depends on — secure cookies, partitioned storage, some
clipboard and media APIs — differ between `http://localhost` and real HTTPS, so developing over plain HTTP means
finding those differences in production instead.

The API reads its pair through `API_HTTPS_KEY`/`API_HTTPS_CERT`, Vite reads the same one directly, and both
resolve it through `node_modules/@intentic-app/localhost-https/`, which links here.

## Conventions & gotchas

- **The CA private key is generated per machine and never committed.** It used to be committed, on the argument
  that a localhost CA protects nothing. That argument was wrong in one specific way: a CA is only useful once
  it is in a trust store, and this one is meant to go into yours. Anybody holding its private key can mint a
  certificate for *any* hostname, and every machine trusting that root accepts it. The published root was
  `CA:TRUE`, carried no name constraints, and was valid until 2035 — so it vouched for the whole DNS namespace
  on behalf of everyone who followed the old instructions. If you trusted it, remove it from your trust store.
- **The generated root is name-constrained** to `localhost`, `localhost.com` and the loopback addresses, so it
  cannot vouch for anything else even on the machine that holds its key.
- **Trust the CA, not the leaf.** Add `localhost-com-ca.crt` to your OS or browser trust store once; the leaf
  rotates under it without needing to be trusted again.
- **`pnpm install` is the whole setup.** The generator is idempotent and only does work when a file is missing
  or the leaf is inside its last 30 days.
- **It needs `openssl` on PATH** — every dev image here has it, and so does macOS.
