import { type Listener, LOOPBACK_LISTENER } from "./proofs/listener.js";

// The daemon's one browser-origin allowlist: what CORS reflects and what a passkey may be bound to (auth/passkeys.ts).
// A native app's passkey origin is not a browser's and is admitted apart from it (passkeys/app-origins.ts).
// An entry may name a family: `https://*.example.net` admits any single label in the wildcard position, for an editor
// webview's per-session origin. Still an allowlist, not a wildcard: the scheme and suffix are pinned, one label floats.

// The comma-separated `webOrigin` setting as a list; blanks dropped.
export const allowedOriginsOf = (webOrigin: string): readonly string[] =>
    webOrigin
        .split(",")
        .map((origin) => origin.trim())
        .filter((origin) => origin !== "");

export const originAllowedBy =
    (allowed: readonly string[]) =>
    (origin: string): boolean =>
        allowed.some((entry) => {
            const star = entry.indexOf("*");
            if (star === -1) {
                return entry === origin;
            }
            const prefix = entry.slice(0, star);
            const suffix = entry.slice(star + 1);
            const label = origin.slice(prefix.length, origin.length - suffix.length);
            return origin.startsWith(prefix) && origin.endsWith(suffix) && label.length > 0 && !label.includes(".") && !label.includes("/");
        });

// The WebAuthn relying-party id an origin implies: its host, so a passkey answers only from the editor it was made on.
export const rpIdOf = (origin: string): string => new URL(origin).hostname;

/* THE DESKTOP APP'S OWN PAGES, ON THE LOOPBACK PORT ONLY (2026-10-16).

With no network the desktop app (and Intentic OS, which runs it as its screen) opens this machine's sandboxes from a page
in its own bundle: `tauri://localhost` on Linux and macOS, `http://tauri.localhost` on Windows. That origin is not in
`webOrigin` (the editor's), and adding it there would mean recreating every sandbox, so it is admitted here instead, and
only on a request netd says arrived on the machine-published loopback port (its `x-intentic-listener` header, which it
strips from anything arriving from outside). Every Tauri app on every machine shares these origins, so they are never
admitted on the tunnel.

CORS is not the boundary here, and was not before: it only decides which pages may READ an answer. Every route still
takes a bearer (a session the machine minted for the owner: auth/host/host-session.ts), and a page that holds none gets
nothing either way. */

const DESKTOP_BUNDLE_ORIGINS: ReadonlySet<string> = new Set(["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"]);

export const desktopBundleOnLoopback = (origin: string, listener: Listener): boolean =>
    listener === LOOPBACK_LISTENER && DESKTOP_BUNDLE_ORIGINS.has(origin);
