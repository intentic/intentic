# Windows code signing

Why new users are told our installer might be dangerous, and what makes it stop.

## What the warning is

A user who downloads `Intentic-<version>-x64-setup.exe` and runs it meets a blue box:

> **Windows protected your PC**
> Microsoft Defender SmartScreen prevented an unrecognised app from starting.
> *More info* → *Run anyway*

That is **SmartScreen**, and it is not a malware verdict. It says Windows cannot attribute this program to
anybody. Two things clear it, in this order:

1. **An Authenticode signature** from a certificate issued to a verified legal entity. Without one there is no
   publisher to show and no reputation to accumulate: every build is a stranger, forever.
2. **Reputation** on top of that signature. SmartScreen tracks how much a given publisher's software has been
   downloaded and run without incident. A signature starts that clock; downloads advance it.

Nothing else moves the needle. Not testing, not a virus scan, not hosting the file somewhere reputable, and
not the signature we already have: `TAURI_SIGNING_PRIVATE_KEY` is a **minisign** key that proves an update
came from us *to the app's own updater*. Windows neither reads it nor cares.

## What is already wired up

Everything except the certificate.

| Piece | Where |
| --- | --- |
| The signer | `_tools/scripts/sign-windows.sh`: one binary in, signed in place |
| The app exe, installer and uninstaller | `bundle.windows.signCommand` in `src-tauri/tauri.conf.json` calls it per binary |
| `ic.exe` | `_tools/scripts/build-ic.sh` calls it after each Windows target |
| `intentic-machine.exe` | `_tools/scripts/build-agent-binaries.sh`, same |
| The guard | `verify-desktop-bundle.sh` fails the release if signing was configured and an artifact came out unsigned |
| The secrets | `WINDOWS_SIGN_*` in `.github/workflows/release.yml`, on all three desktop jobs |

Unset, every one of those is a no-op that says so in the build log. Set, they sign. Turning it on is adding
repository secrets: no code change.

**The helper binaries matter as much as the installer.** `ic.exe` and the agents are downloaded from a GitHub
release and executed on the user's PC, so they carry the mark-of-the-web and face the same publisher question
- and `ic.exe` runs at the most fragile moment there is, before anything else has worked.

## Signing happens on Linux

The Windows installer is cross-built by `cargo-xwin` on the Linux release runner (`build-desktop.sh`), so
`signtool.exe` is not available and never will be. Both supported signers run on Linux and both produce
ordinary Authenticode signatures:

- **`jsign`**, for a key that lives in a *service*: Azure Trusted Signing, Azure Key Vault, AWS or Google
  KMS, DigiCert ONE, SSL.com eSigner, any PKCS#11 token. This is the shape of every certificate sold since
  June 2023, because CA/Browser Forum rules now require the private key to stay on certified hardware. Needs a
  JRE, which is not in the CI image yet: see the comment in `_tools/ci-desktop/Dockerfile`.
- **`osslsigncode`**: for a certificate you hold as a `.pfx` file. Already in the CI image. In practice this
  means a legacy certificate or a self-made test one.

## Which certificate to buy

Rough costs, and they move; check before committing.

| Option | Cost | Warning goes away | Catch |
| --- | --- | --- | --- |
| **Microsoft Trusted Signing** | ~$10/month | Fast | Identity check. Organisations need ~3 years of verifiable legal existence; there is an individual tier with its own wait. Azure account required. |
| **EV / top-tier certificate** | ~$400–600/year | Fastest: historically immediate | Yearly, and the key ships on a hardware token or a cloud HSM you rent. |
| **Standard (OV) certificate** | ~$150–250/year | Slowly, or never | The signature is real, but reputation still has to accumulate from downloads. For a small audience that can take weeks and may not arrive. |

**The honest summary:** the cheap certificate buys a signature, not the absence of the warning. If the point
is that a first-time user does not see the blue box, that is Trusted Signing or an EV certificate.

Two things help whichever route is taken:

- **Sign every release from the same certificate.** Reputation attaches to the publisher identity; rotating
  certificates restarts it.
- **Submit the installer to Microsoft** at <https://www.microsoft.com/en-us/wdsi/filesubmission> as a
  false-positive/software-developer submission. It is free and can shorten the reputation wait.

## Turning it on

Set these as repository secrets. Nothing else changes.

**With `jsign`** (a key in a service):

```
WINDOWS_SIGN_TOOL=jsign
WINDOWS_SIGN_STORETYPE=AZURETRUSTEDSIGNING     # or AZUREKEYVAULT, DIGICERTONE, PKCS11, …
WINDOWS_SIGN_STORE=https://weu.codesigning.azure.net/
WINDOWS_SIGN_ALIAS=<account>/<certificate-profile>
WINDOWS_SIGN_STOREPASS=<the service credential>
```

…and add the JRE and jsign to `_tools/ci-desktop/Dockerfile`.

**With `osslsigncode`** (a `.pfx` on disk):

```
WINDOWS_SIGN_TOOL=osslsigncode
WINDOWS_SIGN_PFX=/path/to/cert.pfx
WINDOWS_SIGN_PFX_PASSWORD=<password>
```

Optional everywhere: `WINDOWS_SIGN_TIMESTAMP_URL` (defaults to DigiCert's), `WINDOWS_SIGN_DIGEST`
(`SHA-256`), `WINDOWS_SIGN_NAME`, `WINDOWS_SIGN_URL`.

## Checking it worked

```bash
bash _tools/scripts/sign-windows.sh --check path/to/file.exe   # exit 0 = carries a signature
```

It reads the PE's Certificate Table directly, so it needs no Windows tooling. It answers "is there a
signature", not "does it chain to a trusted root": enough to catch the failure a release can actually have,
which is an artifact that never went through the signer. Full validation is `signtool verify /pa` on a
Windows machine, which is where `@intentic/desktop-smoke-windows` runs.

## What signing does not fix

- **Docker Desktop's own installer** is Docker Inc.'s and already signed by them; we only download and run it.
- **The elevation prompt.** Turning on WSL2 and installing Docker Desktop legitimately need administrator, and
  Windows asks for that regardless of who signed what. The setup screen warns before the click.
- **Antivirus false positives.** A signature helps, but a heuristic engine can still object. The submission
  link above is the route for that too.
