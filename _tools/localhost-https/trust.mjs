#!/usr/bin/env node
// Puts this machine's dev CA into every trust store that decides the browser's lock icon: OS store, Firefox's separate
// one, and the WSL boundary, each with its own quirks. Safe to re-run: clears its own earlier entry before adding the
// current root. Touches only the current user's stores; system-wide needs your own sudo.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CA_CRT, CA_NICKNAME } from "./paths.mjs";

const run = (command, ...args) => execFileSync(command, args, { stdio: [`ignore`, `pipe`, `pipe`] }).toString();

/** Run something whose failure is a normal outcome: a store that is absent, a tool that is not installed. */
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

// Windows, natively or via WSL: certutil -addstore -user Root writes the user root store Chrome/Edge read, no elevation
// needed. Detected by finding the binary, not /proc/version, which lies inside a WSL2 container.
const windowsCertutil = () => {
    if (process.platform === `win32`) {
        return `certutil`;
    }
    if (process.platform !== `linux`) {
        return undefined;
    }
    return [`certutil.exe`, `/mnt/c/Windows/System32/certutil.exe`].find((candidate) => attempt(candidate, `-store`, `-user`, `Root`));
};

// Translates the Linux path via wslpath -w for a Windows binary; that yields a \\wsl.localhost UNC path certutil
// doesn't always read, so the caller falls back to copying the file onto the Windows filesystem.
const windowsReadable = (scratch) => {
    if (process.platform === `win32`) {
        return CA_CRT;
    }
    const source = scratch === undefined ? CA_CRT : join(scratch, `localhost-com-ca.crt`);
    if (scratch !== undefined) {
        copyFileSync(CA_CRT, source);
    }
    return run(`wslpath`, `-w`, source).trim();
};

const addToWindowsStore = (certutil, scratch) => {
    // Drops our earlier root (matched by its stamped org) first, so a regenerated root replaces it, not doubles it.
    attempt(certutil, `-delstore`, `-user`, `Root`, CA_NICKNAME);
    return attempt(certutil, `-addstore`, `-user`, `Root`, windowsReadable(scratch));
};

const trustWindows = () => {
    const certutil = windowsCertutil();
    if (certutil === undefined) {
        return false;
    }

    // Windows blocks on a Security Warning dialog for a new root; said here first so the wait doesn't read as a hang,
    // especially from WSL where the dialog appears on the Windows desktop.
    console.log(`localhost-https: Windows will ask you to confirm the new root, answer Yes on the Security Warning dialog.`);
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
    skipped.push(`Windows (current user): certutil would not take the root`);
    return false;
};

// macOS: the login keychain, not System; -d marks it admin-trusted for this user without sudo (a one-time
// login-password prompt is the OS's authorization check).
const trustMacos = () => {
    const keychain = join(homedir(), `Library`, `Keychains`, `login.keychain-db`);
    if (attempt(`security`, `add-trusted-cert`, `-d`, `-r`, `trustRoot`, `-k`, keychain, CA_CRT)) {
        done.push(`macOS login keychain`);
    } else {
        skipped.push(`macOS login keychain: the password prompt was dismissed, or the keychain is locked`);
    }
};

// Linux: the system anchor dir needs root, so this prints the two lines to run instead of sudo-prompting inside pnpm
// install. Desktop browsers usually read Firefox/Chrome's own NSS store anyway (handled below).
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
        skipped.push(`Linux system store: no anchor directory found`);
        return;
    }
    const target = join(anchor.dir, `intentic-localhost-com-ca.crt`);
    if (existsSync(target)) {
        done.push(`Linux system store`);
        return;
    }
    skipped.push(`Linux system store: needs root:\n      sudo cp ${CA_CRT} ${target} && sudo ${anchor.refresh}`);
};

// Firefox keeps its own store (ignoring Linux's system one) per profile; a bonus on Windows/macOS, which read OS roots
// anyway. Uses NSS's certutil, distinct from the same-named Windows tool; runs only where they can't be confused.
const firefoxProfileRoots = () => {
    const home = homedir();
    if (process.platform === `darwin`) {
        return [join(home, `Library`, `Application Support`, `Firefox`, `Profiles`)];
    }
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
    if (profiles.length === 0) {
        return;
    }

    if (!found(`certutil`)) {
        skipped.push(`Firefox (${profiles.length} profile(s)), install NSS tools first (Arch: nss, Debian/Ubuntu: libnss3-tools)`);
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
    console.error(`localhost-https: no development CA yet at ${CA_CRT}, run \`pnpm install\` first.`);
    process.exit(1);
}

const reachedWindows = trustWindows();
if (process.platform === `darwin`) {
    trustMacos();
}
// Skipped when Windows already handles it (WSL): a Linux-store sudo hint would be noise no local browser reads.
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
    console.error(`localhost-https: nothing was trusted. The root is at ${CA_CRT}, add it by hand, as a certificate authority.`);
    process.exit(1);
}
// A browser already showing the warning keeps it all session even after the cert verifies; a restart clears it.
console.log(`Restart the browser: one already running remembers having been told to ignore the old warning.`);
