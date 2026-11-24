import { posix, win32 } from "node:path";
import { isInside } from "@intentic/base/contained";
import { STATE_DIR } from "@intentic/constants";

/* PLACES THE FILE TOOLS KEEP OUT OF, EVEN INSIDE THE ALLOWED FOLDERS (2026-11-24). Reads need no switch, and the allowed
   folders are the whole home folder unless the owner narrowed them, so read_file reached SSH keys, cloud credentials,
   browser profiles and this agent's own link tokens with nothing on the card saying so. These places are refused to
   read, list, write, copy and trash alike (policy.ts `assertPath`), after links are resolved, and on Windows and macOS
   without regard to case. An owner who wants one reached names it, or a folder inside it, as a line of "Folders it may
   touch": a home folder that holds it does not count, since that is what an unnarrowed card already reads as.
   The provider-key import (the daemon's migrations/provider-keys.ts) reads `.hermes`, `.openclaw`, `.codex/auth.json`,
   `.gemini/.env` and `.local/share/opencode/auth.json` with read_file, so none of those is listed here. */

export interface ProtectedPlace {
    readonly path: string;
    // What it holds, as a refusal names it.
    readonly holds: string;
}

const rulesOf = (platform: NodeJS.Platform): typeof posix => (platform === "win32" ? win32 : posix);

// Every platform's places at once, under this home: a name that does not exist here protects nothing and costs a lookup.
// Windows' own folders come from its environment where it says them, as an installer that moved them would.
export const protectedPlaces = (home: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): ProtectedPlace[] => {
    const { join } = rulesOf(platform);
    const at = (holds: string, ...paths: string[]): ProtectedPlace[] => paths.map((path) => ({ path, holds }));
    const roaming = env["APPDATA"] || join(home, "AppData", "Roaming");
    const local = env["LOCALAPPDATA"] || join(home, "AppData", "Local");
    const support = join(home, "Library", "Application Support");
    const configs = [...new Set([join(home, ".config"), ...(env["XDG_CONFIG_HOME"] ? [env["XDG_CONFIG_HOME"]] : [])])];
    const inConfig = (...names: string[]): string[] => configs.flatMap((config) => names.map((name) => join(config, name)));
    return [
        ...at("SSH keys", join(home, ".ssh")),
        ...at("GnuPG keys", join(home, ".gnupg")),
        ...at("AWS credentials", join(home, ".aws")),
        ...at("Azure credentials", join(home, ".azure")),
        ...at("Google Cloud credentials", ...inConfig("gcloud"), join(roaming, "gcloud")),
        ...at("Kubernetes credentials", join(home, ".kube")),
        ...at("Docker registry credentials", join(home, ".docker", "config.json")),
        ...at("saved logins", join(home, ".netrc"), join(home, "_netrc")),
        ...at("Git credentials", join(home, ".git-credentials"), ...inConfig(join("git", "credentials"))),
        ...at("database passwords", join(home, ".pgpass"), join(roaming, "postgresql", "pgpass.conf")),
        ...at("Claude Code's sign-in", join(home, ".claude", ".credentials.json")),
        // The link tokens (machine/device.json), the sync SSH key, the keyring's vault and its own browsers' profiles.
        ...at("intentic's own credentials", join(home, STATE_DIR)),
        ...at("the system keychain", join(home, "Library", "Keychains"), join(home, ".local", "share", "keyrings"), join(home, ".local", "share", "kwalletd")),
        ...at(
            "a browser profile",
            ...inConfig("google-chrome", "google-chrome-beta", "google-chrome-unstable", "chromium", "microsoft-edge", "microsoft-edge-beta", "microsoft-edge-dev", "BraveSoftware"),
            join(home, ".mozilla", "firefox"),
            join(home, "snap", "firefox", "common", ".mozilla", "firefox"),
            join(home, "snap", "chromium", "common", "chromium"),
            ...["org.mozilla.firefox", "com.google.Chrome", "org.chromium.Chromium", "com.microsoft.Edge", "com.brave.Browser"].map((app) => join(home, ".var", "app", app)),
            ...["Google/Chrome", "Google/Chrome Beta", "Google/Chrome Canary", "Chromium", "Microsoft Edge", "BraveSoftware", "Firefox"].map((name) => join(support, ...name.split("/"))),
            ...["Google/Chrome", "Google/Chrome Beta", "Google/Chrome SxS", "Chromium", "Microsoft/Edge", "Microsoft/Edge Beta", "Microsoft/Edge Dev", "BraveSoftware"].map((name) =>
                join(local, ...name.split("/")),
            ),
            join(roaming, "Mozilla", "Firefox"),
        ),
        ...at("Windows' saved credentials", ...[roaming, local].flatMap((dir) => [join(dir, "Microsoft", "Credentials"), join(dir, "Microsoft", "Vault")]), join(roaming, "Microsoft", "Protect")),
    ];
};

// Windows opens `.ssh.`, `.ssh ` and `.ssh::$DATA` as `.ssh`, so each name is compared as Windows would open it: no
// stream suffix, no trailing dots or spaces. A realpath settles this for a name that exists; this is for one that
// does not yet (a write that would create `~/.ssh./authorized_keys`).
const asWindowsOpens = (path: string): string =>
    path
        .split(/[\\/]/)
        .map((name, index) => (index === 0 ? name : name.replace(/:.*$/, "").replace(/[. ]+$/, "")))
        .join("\\");

// Paths compared as this platform's disks name them: without case on NTFS and on APFS as macOS formats it.
const comparer = (platform: NodeJS.Platform) => {
    const options = { platform, foldCase: platform === "win32" || platform === "darwin" };
    const form = (path: string): string => (platform === "win32" ? asWindowsOpens(path) : path);
    return (outer: string, inner: string): boolean => isInside(form(outer), form(inner), options);
};

// The place `real` is inside that no root opens, or undefined. A root opens a place when it is that place or a folder
// inside it, and then only for what is inside that root. `roots` are the allowed folders as resolved, links followed.
export const protectedAt = (
    real: string,
    places: readonly ProtectedPlace[],
    roots: readonly string[],
    platform: NodeJS.Platform = process.platform,
): ProtectedPlace | undefined => {
    const inside = comparer(platform);
    return places.find((place) => inside(place.path, real) && !roots.some((root) => inside(place.path, root) && inside(root, real)));
};

// The places inside a folder about to be taken whole (packed for a copy, moved to the trash) that no root opens all of:
// opening part of one does not open the rest of it to a tar of its parent.
export const protectedWithin = (
    folder: string,
    places: readonly ProtectedPlace[],
    roots: readonly string[],
    platform: NodeJS.Platform = process.platform,
): ProtectedPlace[] => {
    const inside = comparer(platform);
    return places.filter((place) => inside(folder, place.path) && !roots.some((root) => inside(root, place.path) && inside(place.path, root)));
};
