// Facts parsed from what the machine says, each a pure function so it can be tested without a Windows machine.
// `ConvertTo-Json` returns nothing/an object/an array for 0/1/N results; `asList` absorbs that asymmetry once, for
// every probe here.

import type { SessionState, WindowInfo } from "@intentic/desktop-automation";
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

// Matched on DisplayName, not the registry key, since the bundler has spelled that differently across versions.
// installLocation is unquoted (for readdir); uninstallString stays quoted for the shell that needs it.
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

// What's keeping this runner alive, not just whether it has a desktop: a hand-started console passes every assertion
// here but dies at the next reboot or sign-out. Reported, not failed, since that's about the next run.
export interface RunnerTask {
    /** As Windows reports it: `Running` when this task started the listener, `Ready` when it did not. */
    readonly State?: string;
    /** How often the watchdog re-runs the task, as an ISO 8601 duration, or absent without one. */
    readonly Repetition?: string;
}

export type RunnerSupervision =
    /** Logon task started this listener and re-checks it: a reboot, crash or sign-out all heal. */
    | { readonly kind: `supervised`; readonly repetition: string }
    /** Task started it, but nothing re-checks it; a crash needs a sign-out and back in. */
    | { readonly kind: `no-watchdog` }
    /** A console somebody opened; runs this job fine, gone at the next reboot. */
    | { readonly kind: `hand-started` };

// `Running` is exact, not a heuristic: the doctor runs inside the listener, so the hosting task can't be anything but
// Running. A missing task and one sitting at Ready are the same answer: something else started this.
export const runnerSupervision = (tasks: readonly RunnerTask[]): RunnerSupervision => {
    const running = tasks.find((task) => (task.State ?? ``).toLowerCase() === `running`);
    if (running === undefined) {
        return { kind: `hand-started` };
    }
    const repetition = (running.Repetition ?? ``).trim();
    return repetition === `` ? { kind: `no-watchdog` } : { kind: `supervised`, repetition };
};

// Only the H/M/S shapes Task Scheduler actually produces are parsed; anything else passes through verbatim rather than
// risk a wrong, confidently-stated duration.
export const humanDuration = (iso: string): string => {
    const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso.trim());
    if (match === null) {
        return iso.trim();
    }
    const parts = [
        [match[1], `hour`],
        [match[2], `minute`],
        [match[3], `second`],
    ]
        .filter(([value]) => value !== undefined)
        .map(([value, unit]) => `${value as string} ${unit as string}${value === `1` ? `` : `s`}`);
    return parts.length === 0 ? iso.trim() : parts.join(` `);
};

// Docker answering isn't enough: Windows-container mode exits 0 too, then fails the sandbox's Linux image pull with an
// unrelated error. It's Windows CI's default Docker mode, so every runner hits it before any user does.
export const dockerOsType = (stdout: string): string | undefined => {
    const value = stdout.trim().toLowerCase();
    return value === `` ? undefined : value;
};

/** Prefix every sandbox container name carries, whatever hostname produced its slug. */
export const SANDBOX_CONTAINER_PREFIX = `intentic-sandbox-`;

/** Container name every later flow (recreate, cleanup, the launcher's docker calls) keys off. */
export const sandboxContainerName = (hostname: string): string => `${SANDBOX_CONTAINER_PREFIX}${sandboxSlug(hostname)}`;

/** `docker ps --format {{.Names}}` (or any one-name-per-line docker output), as the list it prints. */
export const containerNames = (stdout: string): string[] =>
    stdout
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line !== ``);

// Names from `docker inspect`'s printed env with no value, or none at all: an empty value counts as missing, matching
// how every consumer here reads it (an empty grant means dial no tunnel).
export const missingEnvNames = (stdout: string, keys: readonly string[]): string[] => {
    const carried = new Set(
        containerNames(stdout)
            .map((line) => line.split(`=`))
            .filter((parts) => parts.length > 1 && parts.slice(1).join(`=`).trim() !== ``)
            .map((parts) => parts[0]),
    );
    return keys.filter((key) => !carried.has(key));
};

// Docker answers an address for a published port and nothing for one that isn't, exit 0 either way. A missing port here
// means the sandbox is healthy through its tunnel but absent from the address a local browser would derive.
export const publishedPort = (stdout: string): number | undefined => {
    const first = containerNames(stdout)[0];
    if (first === undefined) {
        return undefined;
    }
    const port = Number.parseInt(first.slice(first.lastIndexOf(`:`) + 1), 10);
    return Number.isNaN(port) ? undefined : port;
};

// Compares parsed JSON, not bytes: what matters is the daemon can find the hash inside, not that CRLF or formatting
// survived. Unparseable on either side is never a match.
export const sameStore = (written: string, readBack: string): boolean => {
    try {
        return JSON.stringify(JSON.parse(written)) === JSON.stringify(JSON.parse(readBack));
    } catch {
        return false;
    }
};

/** Launcher's own slug rule: everything before the first dot. */
export const sandboxSlug = (hostname: string): string => hostname.split(`.`)[0] ?? hostname;

// Whether a window title is the one being waited for: substring match on the distinctive half, so a wording change
// doesn't turn into a red build.
export const titled = (titles: readonly string[], fragment: string): boolean => titles.some((title) => title.includes(fragment));

// The two programs that draw the lock screen: LockApp the picture and clock, LogonUI the credential prompt.
// Neither has a window `windows()` returns, and either one holding the foreground means no window on this
// desktop can be given the keyboard — `focusWindow` loses to them by design, however many times it asks.
const LOCK_SCREEN_APPS = [`LockApp`, `LogonUI`];

/** Whether the keyboard is held by the lock screen, the one holder a tier cannot take it from. */
export const lockScreenHolds = (session: SessionState): boolean => {
    const holder = session.foreground?.app.toLowerCase();
    return holder !== undefined && LOCK_SCREEN_APPS.some((app) => app.toLowerCase() === holder);
};

export interface DesktopReadiness {
    /** Whether a tier can expect to take the keyboard; false is a machine to refuse, not a product to blame. */
    readonly drivable: boolean;
    /** The one line the transcript carries, whichever way it goes. */
    readonly summary: string;
    /** What to do about it, for a person reading a red run at a machine they are not sitting at. */
    readonly remedy: string | undefined;
}

const LOCKED_REMEDY =
    `A locked desktop cannot be driven and cannot be unlocked from inside a job: focus is refused, keystrokes go to a\n` +
    `desktop this process cannot reach, and every window assertion after it fails as though the app were broken.\n` +
    `Sign in on that machine (or let the auto-logon do it), then re-run this job. To stop it happening again:\n` +
    `  _tools/scripts/ci/setup-windows-runner.ps1 -Repair -KeepAwake\n` +
    `which also turns off the display timeout, the screen saver and require-sign-in-on-wake — a blanked display\n` +
    `locking the session is how this machine got here.`;

const STUCK_REMEDY =
    `The session is signed in, so this is a lock screen left holding the foreground rather than a locked machine.\n` +
    `teardown tries to dismiss it before this check runs; it did not go. Sign in on that machine and back out, or\n` +
    `end LockApp there:\n` +
    `  Stop-Process -Name LockApp -Force`;

const heldBy = (foreground: NonNullable<SessionState["foreground"]>): string =>
    foreground.title === `` ? `an untitled window [${foreground.app}]` : `"${foreground.title}" [${foreground.app}]`;

/*
 * WHETHER THIS DESKTOP CAN BE DRIVEN, which the window list alone cannot say and used to be asked of it.
 *
 * The line this replaces searched `windows()` for the focused row and reported "none holding the foreground"
 * when it found none — a sentence that is true of an idle desktop and of a machine whose keyboard is held by
 * the lock screen, because the lock screen has no row to find. A release ran on the second kind: the doctor
 * declared the machine ready, then six assertions failed in a row, all of them worded as though the product
 * had stopped answering a deep link.
 *
 * So the holder is read from the OS, and a holder the window list does not show is SAID to be one, rather than
 * silently becoming nobody.
 */
export const desktopReadiness = (open: readonly WindowInfo[], session: SessionState): DesktopReadiness => {
    const count = `${open.length} window(s) currently open`;
    if (session.locked) {
        return { drivable: false, summary: `${count}, and Windows is drawing its sign-in screen over this session`, remedy: LOCKED_REMEDY };
    }
    if (lockScreenHolds(session)) {
        const holder = session.foreground === undefined ? `the lock screen` : heldBy(session.foreground);
        return { drivable: false, summary: `${count}, and the lock screen still holds the foreground: ${holder}`, remedy: STUCK_REMEDY };
    }
    const holding = session.foreground;
    if (holding === undefined) {
        return { drivable: true, summary: `${count}, none holding the foreground`, remedy: undefined };
    }
    // A holder that enumerates is ordinary — the tiers take the foreground off one every run. One that does not
    // is worth naming as such: it is the shape the lock screen came in, and the next unreadable holder should
    // arrive already described rather than as a count that looked fine.
    const listed = open.some((window) => window.id === holding.id);
    return {
        drivable: true,
        summary: `${count}, ${heldBy(holding)} holding the foreground${listed ? `` : `, a window no enumeration of this desktop returns`}`,
        remedy: undefined,
    };
};

// Control-token store shape as auth/control-tokens.ts persists it: sha256 of the raw token, never the token. Kept as a
// pure decision, separate from the docker exec that writes it.
export const controlTokenStore = (digest: string): string =>
    JSON.stringify({
        tokens: [{ id: `windows-smoke`, label: `windows smoke`, scope: `drive`, hash: digest, createdAt: 0 }],
    });

// mkdir's directory is derived from the same path being written, so the two cannot drift apart. `<<'STORE'` is quoted
// so the JSON reaches the file byte for byte, with no expansion.
export const controlTokenSeedScript = (storePath: string, store: string): string =>
    `mkdir -p ${shellQuote(posix.dirname(storePath))} && cat > ${shellQuote(storePath)} <<'STORE'\n${store}\nSTORE`;

// Probed separately from a window failing to open: Windows 11 ships the runtime, Server doesn't (the installer fetches
// it), and those are different failures to report.
export const webView2Version = (entries: readonly { readonly pv?: string }[]): string | undefined => {
    const found = entries.find((entry) => (entry.pv ?? ``) !== ``);
    return found?.pv;
};
