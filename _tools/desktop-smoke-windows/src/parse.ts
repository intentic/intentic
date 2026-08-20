/* What the machine says, turned into facts — every one of them a pure function beside the call that produced
 * it, for the reason `_sandbox/ic` states about its own decisions: this is the logic most likely to be wrong
 * and least likely to be noticed when it is, and it is the only part of a Windows tier that can be asserted
 * without a Windows machine.
 *
 * THE POWERSHELL JSON FOOTGUN, ONCE, HERE. `ConvertTo-Json` is not stable in its shape: a pipeline that yields
 * nothing produces the empty string, one object produces an OBJECT, and two produce an ARRAY. Reading it as
 * `T[]` therefore works on a developer machine with two matches and throws on the CI box with one — which is
 * a failure that reads as "the app is not installed" when the truth is "the app is installed exactly once".
 * `asList` is that asymmetry absorbed in one place, and it is why every probe here parses through it.
 */

// `posix`, not the platform's own: every path these build is a path INSIDE the Linux container, written by a
// tool whose own process is running on Windows. `dirname` off the default namespace would read a backslash as
// a separator on the machine this actually runs on.
import { posix } from "node:path";
import { shellQuote } from "@intentic/sandbox-run/quote";

/** `ConvertTo-Json` output, as the list it was always meant to be. */
export const asList = <T>(json: string): T[] => {
    const text = json.trim();
    if (text === ``) {
        return [];
    }
    const value: unknown = JSON.parse(text);
    if (Array.isArray(value)) {
        return value as T[];
    }
    return [value as T];
};

/** An optional setting as CI means it: an absent variable and GitHub's empty-string expansion are both absent. */
export const nonEmpty = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim();
    return trimmed === undefined || trimmed === `` ? undefined : trimmed;
};

/** True only when this conversation's restored transcript contains the expected assistant reply. */
export const assistantReplied = (json: string, expected: string): boolean => {
    try {
        const parsed: unknown = JSON.parse(json);
        if (typeof parsed !== `object` || parsed === null || !(`messages` in parsed) || !Array.isArray(parsed.messages)) {
            return false;
        }
        const reply = expected.trim().toLowerCase();
        return parsed.messages.some(
            (message) =>
                typeof message === `object` &&
                message !== null &&
                `role` in message &&
                message.role === `assistant` &&
                `text` in message &&
                typeof message.text === `string` &&
                message.text.trim().toLowerCase() === reply,
        );
    } catch {
        return false;
    }
};

/** One row of Windows' own list of installed programs. */
export interface UninstallEntry {
    readonly DisplayName?: string;
    readonly DisplayVersion?: string;
    readonly InstallLocation?: string;
    readonly UninstallString?: string;
}

export interface InstalledApp {
    readonly name: string;
    readonly version: string | undefined;
    readonly installLocation: string;
    readonly uninstallString: string;
}

/* The app as Windows lists it. Matched on DisplayName rather than on the registry key, because the key is the
 * bundler's business: Tauri has spelled it the product name and the bundle identifier in different versions,
 * and a tier pinned to either one reports "not installed" the day that changes — the single most misleading
 * thing this file could say, since it is also what a genuinely failed install looks like.
 *
 * An entry with no InstallLocation is dropped rather than defaulted: the whole point of reading this key is to
 * be told where the app went, and guessing %LOCALAPPDATA%\<name> would turn a bundler regression into a set of
 * downstream "file not found" failures that name the wrong cause.
 *
 * `installLocation` is UNQUOTED and `uninstallString` deliberately is not. Windows writes both with surrounding
 * quotes, and they are consumed differently: the location is handed to `readdir`, which reads a quote as an
 * ordinary path character and then resolves the whole thing relative to the working directory, while the
 * uninstall string is handed to a shell that needs the quotes to survive a space in the path. */
export const installedApp = (entries: readonly UninstallEntry[], displayName: string): InstalledApp | undefined => {
    const match = entries.find((entry) => entry.DisplayName === displayName && unquote(entry.InstallLocation ?? ``) !== ``);
    if (match === undefined) {
        return undefined;
    }
    return {
        name: displayName,
        version: match.DisplayVersion,
        installLocation: unquote(match.InstallLocation as string),
        uninstallString: match.UninstallString ?? ``,
    };
};

/** Strips one layer of surrounding double quotes, which is how Windows stores a path that may contain spaces. */
const unquote = (value: string): string => value.replace(/^"(.*)"$/s, `$1`);

/* `docker info --format {{.OSType}}` — the question `connect.ps1` and `ic` both skip.
 *
 * Both of them establish that a daemon ANSWERS and go straight on to pulling a Linux image. On Windows those
 * are different questions: Docker Desktop can be running perfectly in Windows-container mode, where `docker
 * info` is a clean exit 0 and the sandbox image then fails to pull with a manifest error that names no remedy.
 * That is not a hypothetical shape of bug — it is the default state of the Docker that ships preinstalled on
 * a Windows CI image, so any Windows runner reaches it before any user does. */
export const dockerOsType = (stdout: string): string | undefined => {
    const value = stdout.trim().toLowerCase();
    return value === `` ? undefined : value;
};

/** The container name every later flow addresses — recreate, cleanup and the launcher's docker reads all key off it. */
export const sandboxContainerName = (hostname: string): string => `intentic-sandbox-${sandboxSlug(hostname)}`;

/** The slug rule the app's launcher relies on: everything before the first dot. */
export const sandboxSlug = (hostname: string): string => hostname.split(`.`)[0] ?? hostname;

/* Whether a window title is the one being waited for. Substring, case-sensitive, on the distinctive half —
 * the same contract the Linux tier's `SETUP_TITLE="Setting up"` has, and for the same reason: these titles are
 * user-facing copy, and an assertion that pins the whole string turns a wording change into a red build. */
export const titled = (titles: readonly string[], fragment: string): boolean => titles.some((title) => title.includes(fragment));

/* The control-token store, as `auth/control-tokens.ts` persists it: sha256 of the raw token, never the token.
 *
 * Here rather than beside the tier that writes it, for the reason everything else in this file is here — it is
 * a decision (what shape the daemon reads) separated from the IO that acts on it (a `docker exec` writing a
 * file), and it is the only part of tier 3's credential seeding that can be asserted from a Linux machine.
 * The coupling to that file's schema is real and deliberate: the day it changes, this is what fails, and its
 * name says what it was trying to do. */
export const controlTokenStore = (digest: string): string =>
    JSON.stringify({
        tokens: [{ id: `windows-smoke`, label: `windows smoke`, scope: `drive`, hash: digest, createdAt: 0 }],
    });

/* The sh that puts that store on disk inside the container — here, and not spliced into the `docker exec`
 * beside it, for one reason: the directory it creates is DERIVED from the path it writes.
 *
 * The two used to be written down separately, and the day the daemon moved its identity files into
 * `.intentic/identity/` the `mkdir` kept naming the parent the store used to have. Every write after that
 * failed with "nonexistent directory", and the tier said only "could not seed a drive-scoped control token" —
 * a red Windows build whose message pointed at the credential rather than at the rename that broke it. A path
 * and the directory it needs cannot disagree when only one of them is written down.
 *
 * `<<'STORE'` is quoted, so the JSON reaches the file byte for byte with no expansion of anything inside it. */
export const controlTokenSeedScript = (storePath: string, store: string): string =>
    `mkdir -p ${shellQuote(posix.dirname(storePath))} && cat > ${shellQuote(storePath)} <<'STORE'\n${store}\nSTORE`;

/* The WebView2 runtime's version, from the Edge updater's client key.
 *
 * Worth a probe of its own rather than being left to surface as "the window never opened": Windows 11 carries
 * the runtime, Windows Server does not, and Tauri's installer is configured to fetch it at install time. So on
 * a Server-based runner this is the difference between a real product bug and a machine that was never able to
 * show a window — and those two must not produce the same log line. */
export const webView2Version = (entries: readonly { readonly pv?: string }[]): string | undefined => {
    const found = entries.find((entry) => (entry.pv ?? ``) !== ``);
    return found?.pv;
};
