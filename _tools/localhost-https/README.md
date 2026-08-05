# @intentic-app/localhost-https

A local certificate authority and a certificate for it, so development runs over real HTTPS.

## Responsibilities

- Provide the CA and leaf certificate the local API and web app serve with.

## Key files

- [localhost-com-ca.crt](localhost-com-ca.crt) — the development CA to trust.
- [localhost.crt](localhost.crt) — the certificate the local servers present.
- [package.json](package.json) — how the files are resolved by the packages that use them.

## How it fits

Development-only. Several browser behaviours the app depends on — secure cookies, partitioned storage, some
clipboard and media APIs — differ between `http://localhost` and real HTTPS, so developing over plain HTTP means
finding those differences in production instead.

## Conventions & gotchas

- **These keys are public and committed on purpose.** They are a development CA for `localhost` and nothing else;
  treating them as a secret would imply they protect something, and they do not.
