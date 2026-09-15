// The daemon's one browser-origin allowlist: what CORS reflects and what a passkey may be bound to (auth/passkeys.ts).
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
