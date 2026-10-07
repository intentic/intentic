# explorer-menu

"Open with Intentic" in Windows 11's own context menu, on folders, the empty space inside one, and the document types the app opens. It is one DLL, `intentic_explorer_menu.dll`, installed beside the app.

## Why a DLL and a package

Windows 11's new context menu does not show classic registry verbs (`HKCU\Software\Classes\Directory\shell\…`). Those appear only under "Show more options". The new menu lists `IExplorerCommand` handlers declared by an app **package**, which is how VS Code and Zed get there. An unpackaged app like this one gets a package identity through a sparse package (an "identity package" with an external location): a signed MSIX holding only a manifest, registered with the app's install folder as its external location.

This crate is both halves:

- `src/com.rs` is the menu entry: an `IExplorerCommand` that Explorer's COM surrogate (dllhost.exe) loads. It gives the title and the app's icon, and on a click starts `intentic-desktop.exe` with every picked path.
- `src/register.rs` registers and removes the package. The installer calls it through `regsvr32 /n /i:<mode>` (`DllInstall`).
- `AppxManifest.xml` is the package's manifest. `build.rs` fills in its publisher and version and fails the build when its file types drift from `tauri.conf.json`'s `fileAssociations`.

## Signing, and the one UAC prompt

Windows registers a package only when its signer chains to a root the PC trusts. Measured on Windows 11 25H2 as a standard user (2026-10-07):

| Package | Result |
| --- | --- |
| unsigned (`-AllowUnsigned`) | refused, 0x80073D2B: an unsigned package cannot include executable activations |
| self-signed, certificate in the user's Trusted People | refused, 0x800B0109 (Microsoft's identity-package page says this works; it does not) |
| self-signed, certificate in the user's Root store | possible only through Windows' "Security Warning" dialog |
| self-signed, certificate in the PC's Trusted People | registers; adding it needs an administrator |
| signed with a CA-issued code-signing certificate | registers, no prompt |

So there are two routes, tried in this order:

1. **Signed by the release.** When the release build signs Windows binaries and knows its certificate's subject (`WINDOWS_SIGN_TOOL` and `WINDOWS_SIGN_PUBLISHER`), `_tools/scripts/desktop/explorer-menu-msix.mjs` packs the package on Linux, `sign-windows.sh` signs it, and it ships as `intentic-explorer-menu.msix`. The installer registers it with no prompt, on every install and update.
2. **Signed on the PC.** Otherwise, the first interactive install makes a fresh key and a self-signed certificate for `CN=Intentic Explorer Menu`, writes and signs the package with Windows' own packaging and signing APIs, and adds the certificate's public half to the PC's Trusted People store through one UAC prompt (`rundll32 intentic_explorer_menu.dll,TrustSigner`). It then registers the package and deletes the private key. Nothing can be signed with that certificate again, so trusting it admits this one package and nothing else. The package's version is the manifest's fingerprint, so an update that did not change the manifest finds it in place and asks nothing.

Updates the app runs in the background, and passive or silent installs, never prompt (`/i:quiet`). They keep whatever registration is there. When there is none (Windows 10, a declined prompt, any failure) the installer writes the classic registry verb instead, so the entry is always in one menu or the other and never in both. Each outcome is a line in `~/.intentic/logs/explorer-menu.log`.

An uninstall removes the package. The certificate stays in Trusted People, where without its key it can vouch for nothing new, because taking it out would cost another UAC prompt.

## The package file a release ships

`explorer-menu-msix.mjs` writes the ZIP the way makeappx does: every part deflated in 64 KiB blocks, data descriptors, ZIP64 end records. This is not taste: osslsigncode turns a ZIP32 package into one Windows cannot open (0x80073CF0), and its output over a makeappx-shaped one opens. That was checked against VS Code's and Zed's packages on Windows 11.

## Building

```sh
cargo xwin build --release --target x86_64-pc-windows-msvc   # from this folder, on Linux
```

`_tools/scripts/desktop/stage-local-files.sh x86_64-pc-windows-msvc` builds it into `src-tauri/binaries/explorer-menu/` (with the signed package when the release can sign one), and `src-tauri/tauri.windows.conf.json` puts that folder's files beside the app. The code is all `#[cfg(windows)]`: on Linux the crate is empty, and CI runs clippy against the Windows target.

By hand on a Windows PC, from the install folder:

```powershell
regsvr32 /n /i:interactive intentic_explorer_menu.dll   # register (may show the UAC prompt)
regsvr32 /n /i:quiet intentic_explorer_menu.dll         # register only if no prompt is needed
regsvr32 /u /n /i:quiet intentic_explorer_menu.dll      # remove the package
Get-Content ~\.intentic\logs\explorer-menu.log -Tail 5
```
