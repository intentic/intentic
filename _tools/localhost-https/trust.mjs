#!/usr/bin/env node
/* Put this machine's development CA into the trust stores that decide whether the browser shows a lock.
 *
 * WHY THIS EXISTS AS A COMMAND. Minting a root and printing "now go trust it" is where the old setup stopped,
 * and the gap between those two sentences is a browser warning on every `pnpm dev` — the instructions differ
 * per OS, Firefox keeps a store of its own that no OS instruction touches, and on WSL the file is on one side
 * of the machine while the browser that has to believe it is on the other. All of that is mechanical, so it is
 * done here instead of in a README nobody finishes.
 *
 * IT IS SAFE TO RUN AGAIN. Every store is cleared of our own previous entry before the current root goes in,
 * so re-running after the root is regenerated replaces it rather than stacking a second one — and a stale root
 * left behind in a store is exactly the confusion this is meant to end.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It never installs anything but the root this checkout would serve under,
 * and it touches only the current user's stores unless the OS has no such thing. The system-wide store needs
 * elevation; if you want the root there too, that is your call to make and your sudo to type.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CA_CRT, CA_NICKNAME } from "./paths.mjs";

const run = (command, ...args) => execFileSync(command, args, { stdio: [`ignore`, `pipe`, `pipe`] }).toString();

/** Run something whose failure is a normal outcome — a store that is absent, a tool that is not installed. */
const attempt = (command, ...args) => {
    try {
        run(command, ...args);
        return true;
    } catch {
        return false;
    }
};

const found = (command) => attempt(process.platform === `win32` ? `where` : `which`, command);

const done = [];
const skipped = [];

/* ── Windows, natively or from WSL ─────────────────────────────────────────────────────────────────────────
 * `certutil -addstore -user Root` writes the current user's root store — the one Chrome and Edge read, and
 * Firefox too via enterprise roots — and unlike the machine-wide store it needs no elevation.
 *
 * WHETHER WINDOWS IS REACHABLE IS A QUESTION ABOUT INTEROP, NOT ABOUT THE KERNEL. The obvious test — does
 * `/proc/version` mention Microsoft — is also true inside any container running on a WSL2 kernel, where there
 * is no Windows to hand a certificate to and the answer is confidently wrong. Finding the binary and getting a
 * store listing out of it asks the same question in a way that cannot lie. */
const windowsCertutil = () => {
    if (process.platform === `win32`) return `certutil`;
    if (process.platform !== `linux`) return undefined;
    return [`certutil.exe`, `/mnt/c/Windows/System32/certutil.exe`].find((candidate) => attempt(candidate, `-store`, `-user`, `Root`));
};

/* The root, at a path the Windows side can open. Its own filesystem needs no help; from WSL the Linux path is
 * meaningless to a Windows binary, so `wslpath -w` translates it — and because that yields a `\\wsl.localhost`
 * UNC path, which certutil reads only when the WSL file server is willing, the caller falls back to putting a
 * copy on the Windows filesystem where no share is involved. */
const windowsReadable = (scratch) => {
    if (process.platform === `win32`) return CA_CRT;
    const source = scratch === undefined ? CA_CRT : join(scratch, `localhost-com-ca.crt`);
    if (scratch !== undefined) copyFileSync(CA_CRT, source);
    return run(`wslpath`, `-w`, source).trim();
};

const addToWindowsStore = (certutil, scratch) => {
    // Drop our own earlier root first, matched on the organisation the generator stamps on it, so that
    // re-running after a regenerated root replaces it instead of leaving two that both look valid.
    attempt(certutil, `-delstore`, `-user`, `Root`, CA_NICKNAME);
    return attempt(certutil, `-addstore`, `-user`, `Root`, windowsReadable(scratch));
};

const trustWindows = () => {
    const certutil = windowsCertutil();
    if (certutil === undefined) return false;

    /* Windows puts up a Security Warning dialog for a new root and blocks until it is answered — correctly,
     * since a root is exactly the thing nothing should be able to install behind your back. Say so first: an
     * unannounced wait on a dialog that may be behind other windows reads as a hang, and from WSL the dialog
     * appears on the Windows desktop with nothing in the terminal to explain it. */
    console.log(`localhost-https: Windows will ask you to confirm the new root — answer Yes on the Security Warning dialog.`);
    if (addToWindowsStore(certutil, undefined)) {
        done.push(`Windows (current user)`);
        return true;
    }
    const temp = existsSync(`/mnt/c/Windows/Temp`) ? `/mnt/c/Windows/Temp` : undefined;
    if (temp !== undefined) {
        const scratch = mkdtempSync(join(temp, `intentic-ca-`));
        try {
            if (addToWindowsStore(certutil, scratch)) {
                done.push(`Windows (current user)`);
                return true;
            }
        } finally {
            rmSync(scratch, { recursive: true, force: true });
        }
    }
    skipped.push(`Windows (current user) — certutil would not take the root`);
    return false;
};

/* ── macOS ─────────────────────────────────────────────────────────────────────────────────────────────────
 * The login keychain, not the System one: `-d` marks it as an admin-trusted root for this user without asking
 * for sudo. It does prompt for the login password once, which is the OS insisting a human authorised it. */
const trustMacos = () => {
    const keychain = join(homedir(), `Library`, `Keychains`, `login.keychain-db`);
    if (attempt(`security`, `add-trusted-cert`, `-d`, `-r`, `trustRoot`, `-k`, keychain, CA_CRT)) {
        done.push(`macOS login keychain`);
    } else {
        skipped.push(`macOS login keychain — the password prompt was dismissed, or the keychain is locked`);
    }
};

/* ── Linux ─────────────────────────────────────────────────────────────────────────────────────────────────
 * The system anchor directory is the only store there is, and writing it needs root. Rather than surprising
 * anyone with a sudo prompt inside `pnpm install`, this prints the two lines to run and moves on — the browser
 * on a desktop Linux machine reads Firefox's or Chrome's own NSS store anyway, which is handled below. */
const linuxAnchor = () => {
    if (existsSync(`/etc/ca-certificates/trust-source/anchors`)) {
        return { dir: `/etc/ca-certificates/trust-source/anchors`, refresh: `update-ca-trust` };
    }
    if (existsSync(`/usr/local/share/ca-certificates`)) {
        return { dir: `/usr/local/share/ca-certificates`, refresh: `update-ca-certificates` };
    }
    return undefined;
};

const trustLinux = () => {
    const anchor = linuxAnchor();
    if (anchor === undefined) {
        skipped.push(`Linux system store — no anchor directory found`);
        return;
    }
    const target = join(anchor.dir, `intentic-localhost-com-ca.crt`);
    if (existsSync(target)) {
        done.push(`Linux system store`);
        return;
    }
    skipped.push(`Linux system store — needs root:\n      sudo cp ${CA_CRT} ${target} && sudo ${anchor.refresh}`);
};

/* ── Firefox ───────────────────────────────────────────────────────────────────────────────────────────────
 * Firefox ships its own trust store and, on Linux, ignores the system one entirely — so a root that every
 * other browser accepts still produces a warning there. Each profile is a separate database. On Windows and
 * macOS it reads OS roots by default, so this is a bonus rather than the thing that matters.
 *
 * The tool is NSS's `certutil`, which shares a name with the unrelated Windows one; on Windows we would be
 * calling the wrong binary, so this only runs where they cannot be confused. */
const firefoxProfileRoots = () => {
    const home = homedir();
    if (process.platform === `darwin`) return [join(home, `Library`, `Application Support`, `Firefox`, `Profiles`)];
    return [
        join(home, `.mozilla`, `firefox`),
        join(home, `snap`, `firefox`, `common`, `.mozilla`, `firefox`),
        join(home, `.var`, `app`, `org.mozilla.firefox`, `.mozilla`, `firefox`),
    ];
};

const trustFirefox = () => {
    const profiles = firefoxProfileRoots()
        .filter(existsSync)
        .flatMap((root) =>
            readdirSync(root, { withFileTypes: true })
                .filter((entry) => entry.isDirectory())
                .map((entry) => join(root, entry.name)),
        )
        .filter((profile) => existsSync(join(profile, `cert9.db`)));
    if (profiles.length === 0) return;

    if (!found(`certutil`)) {
        skipped.push(`Firefox (${profiles.length} profile(s)) — install NSS tools first (Arch: nss, Debian/Ubuntu: libnss3-tools)`);
        return;
    }
    for (const profile of profiles) {
        // Delete before add: NSS happily holds two roots under one nickname, and the stale one still validates.
        attempt(`certutil`, `-D`, `-n`, CA_NICKNAME, `-d`, `sql:${profile}`);
        attempt(`certutil`, `-A`, `-n`, CA_NICKNAME, `-t`, `C,,`, `-i`, CA_CRT, `-d`, `sql:${profile}`);
    }
    done.push(`Firefox (${profiles.length} profile(s))`);
};

if (!existsSync(CA_CRT)) {
    console.error(`localhost-https: no development CA yet at ${CA_CRT} — run \`pnpm install\` first.`);
    process.exit(1);
}

const reachedWindows = trustWindows();
if (process.platform === `darwin`) {
    trustMacos();
}
// Only where Windows is not the thing looking at the certificate. On WSL the browser is on the other side of
// the boundary and already handled, so a sudo hint for the Linux store here would be noise about a store no
// browser on this machine reads.
if (process.platform === `linux` && !reachedWindows) {
    trustLinux();
}
if (process.platform !== `win32`) {
    trustFirefox();
}

for (const store of done) {
    console.log(`localhost-https: trusted in ${store}.`);
}
for (const store of skipped) {
    console.log(`localhost-https: not trusted in ${store}`);
}
if (done.length === 0) {
    console.error(`localhost-https: nothing was trusted. The root is at ${CA_CRT} — add it by hand, as a certificate authority.`);
    process.exit(1);
}
/* A browser that has already been clicked through to a warning for localhost keeps showing "Not secure" for
 * the rest of its run even once the certificate verifies — the exception is remembered per session, and it
 * outlives the reason for it. Restarting is what clears it, and without saying so the command looks like it
 * did nothing. */
console.log(`Restart the browser: one already running remembers having been told to ignore the old warning.`);
