import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { isInside } from "@intentic/base/contained";
import { agentHome, homeDir } from "@intentic/local-agent";
import type { DeviceScopes } from "@intentic/sandbox-contract/schemas/capabilities";
import { type ProtectedPlace, protectedAt, protectedPlaces, protectedWithin } from "./protected-places.js";

// The enforcement point: every switch is checked here, on the machine, against the grant this agent holds. The owner
// sets the switches through the sandbox, which pushes the grant on every connect (`setScopes`, router.ts), so a sandbox
// that is compromised can push a wider one: what this file guarantees is that every call is held to the grant as it
// stands, not that the grant is what the owner meant. A refusal names which switch is off so the agent can tell the user.

export class ScopeError extends Error {}

// The directories reads and writes are confined to. Empty config means the user's home; a line that is not a full
// path confines to nothing, so a config whose every line is unusable allows no folder rather than the whole home.
export const rootsOf = (scopes: DeviceScopes): string[] => {
    const lines = (scopes.roots ?? "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== "");
    if (lines.length === 0) {
        return [resolve(homeDir())];
    }
    return (
        lines
            // A leading ~ is what a user types; nothing expands it for us here (it arrives as data from a form).
            .map((line) => (line.startsWith("~") ? join(homeDir(), line.slice(1)) : line))
            .filter((line) => isAbsolute(line))
            .map((line) => resolve(line))
    );
};

// The roots as a refusal or a description names them, never an empty list a reader cannot act on.
export const rootsText = (roots: readonly string[]): string =>
    roots.length === 0 ? `none, since no line of "Folders it may touch" is a full path` : roots.join(", ");

// Lexical, on normalized paths, so `/home/me/../etc/passwd` normalizes first and `/home/meeting` isn't treated as
// inside `/home/me`. Links are assertPath's to resolve, before this is asked.
export const withinRoots = (path: string, roots: readonly string[]): boolean => roots.some((root) => isInside(root, path));

// Where `path` really is, every symlink and junction on the way resolved. A path that does not exist yet is its
// nearest existing ancestor, resolved, with the rest appended: a new file is judged by the folder it lands in.
export const realPathOf = async (path: string): Promise<string> => {
    const absolute = resolve(path);
    try {
        return await realpath(absolute);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const parent = dirname(absolute);
        if ((code !== "ENOENT" && code !== "ENOTDIR") || parent === absolute) {
            throw error;
        }
        return join(await realPathOf(parent), basename(absolute));
    }
};

// Each protected place where it is named and where it really is: a ~/.ssh that is a link to another disk protects the
// folder it leads to as well (protected-places.ts).
const resolvePlaces = async (home: string): Promise<ProtectedPlace[]> => {
    const named = protectedPlaces(home);
    // allow(silent-catch): a place that cannot be resolved (unreadable) is still protected where it is named
    const real = await Promise.all(named.map(async (place) => ({ ...place, path: await realPathOf(place.path).catch(() => place.path) })));
    return [...named, ...real.filter((place, index) => place.path !== named[index]?.path)];
};

// Resolved again at most once a second: a copy asks for every 2 MiB piece, and each answer is some sixty lookups.
const PLACES_FRESH_MS = 1_000;
let places: { readonly home: string; readonly at: number; readonly resolved: Promise<ProtectedPlace[]> } | undefined;

const placesNow = async (): Promise<ProtectedPlace[]> => {
    const home = homeDir();
    const now = Date.now();
    if (places === undefined || places.home !== home || now - places.at > PLACES_FRESH_MS) {
        places = { home, at: now, resolved: resolvePlaces(home) };
    }
    return await places.resolved;
};

// The roots as written and as resolved: a protected place is opened by naming it, whichever of the two its line names.
const rootForms = async (roots: readonly string[]): Promise<string[]> => [...roots, ...(await Promise.all(roots.map(realPathOf)))];

// Builds a sandbox pushed here are filed inside ~/.intentic (tools/programs/artifacts.ts `runsRoot`, not imported: it
// imports this file). Starting one in its own folder, reading its log and copying it off are what pushing it is for, so
// that folder is opened as if the owner had named it; the rest of ~/.intentic stays shut.
const openedByThisAgent = (): string[] => [join(agentHome("machine").dir, "runs")];

// How the owner opens one: naming it as an allowed folder of its own. An empty list is the home folder, which a line
// replaces, hence the second half.
const optIn = (place: string, inside: boolean): string =>
    `To allow it, the owner adds ${place}${inside ? " (or a folder inside it)" : ""} as a line of "Folders it may touch" on this device's capability card, with ~ beside it if the rest of the home folder should stay allowed.`;

// Throws unless `path`, links resolved, is inside the roots and outside every protected place none of them opens, and
// answers with that real path: the one to operate on. `link: "itself"` judges a link where it sits rather than where
// it leads, for a move, which acts on the link.
export const assertPath = async (
    path: string,
    scopes: DeviceScopes,
    intent: string,
    { link = "follow" }: { readonly link?: "follow" | "itself" } = {},
): Promise<string> => {
    const roots = rootsOf(scopes);
    const absolute = resolve(path);
    // A link swapped in after this check takes a command to make, and a command already reaches past the roots.
    const real = link === "follow" ? await realPathOf(absolute) : join(await realPathOf(dirname(absolute)), basename(absolute));
    const leads = real === absolute ? "" : ` (it leads to ${real})`;
    // The roots resolved too, or one that is itself a link (macOS's /tmp) would refuse everything under it.
    if (!withinRoots(real, await Promise.all(roots.map(realPathOf)))) {
        throw new ScopeError(
            `Refused to ${intent} "${path}"${leads}: it is outside the folders this device allows (${rootsText(roots)}). ` +
                `Widen "Folders it may touch" on this device's capability card to change that.`,
        );
    }
    const place = protectedAt(real, await placesNow(), await rootForms([...roots, ...openedByThisAgent()]));
    if (place !== undefined) {
        throw new ScopeError(
            `Refused to ${intent} "${path}"${leads}: it is in ${place.path}, which holds ${place.holds}, and this device keeps its agents out of such places even inside the folders it allows. ${optIn(place.path, true)}`,
        );
    }
    return real;
};

// Throws when a folder about to be taken whole (packed for a copy, moved to the trash) holds a protected place that no
// root opens all of: a tar of the home folder would otherwise carry ~/.ssh out with it. `real` is assertPath's answer.
export const assertHoldsNoProtected = async (real: string, path: string, scopes: DeviceScopes, intent: string): Promise<void> => {
    const listed = protectedWithin(real, await placesNow(), await rootForms(rootsOf(scopes)));
    // Only what is there: every platform's names are listed, and ~/Library/Keychains on Linux protects nothing.
    // allow(silent-catch): a place that cannot be looked at is taken to be there
    const there = await Promise.all(listed.map(async (place) => await lstat(place.path).then(() => true, (error: NodeJS.ErrnoException) => error.code !== "ENOENT" && error.code !== "ENOTDIR")));
    const held = listed.filter((_place, index) => there[index] === true);
    const [first] = held;
    if (first === undefined) {
        return;
    }
    const more = held.length === 1 ? "" : ` and ${held.length - 1} more such place${held.length === 2 ? "" : "s"}`;
    throw new ScopeError(
        `Refused to ${intent} "${path}": that folder holds ${first.path} (${first.holds})${more}, and this device keeps its agents out of such places, so it is not taken whole. ` +
            `Work on the folders inside it one at a time instead. ${optIn(first.path, false)}`,
    );
};

// Every switch by the label its capability card shows, which is how a refusal names it.
export type SwitchName = Exclude<keyof DeviceScopes, "roots">;
export const SWITCH_LABELS = {
    shell: "Run commands",
    write: "Create and change files",
    screen: "See the screen",
    control: "Use the mouse and keyboard",
    sandboxes: "Manage sandboxes on this device",
    destructive: "Run destructive commands",
    programs: "Run programs this sandbox sends",
    admin: "Run commands as administrator",
    // People's, never an agent's (remote/remote.ts): no tool asks for these, and remoteStart reads all three at once.
    remoteView: "Let people see the screen",
    remoteControl: "Let people use the mouse and keyboard",
    remoteTerminal: "Let people open terminals",
} as const satisfies Record<SwitchName, string>;

// Throws unless the named switch is on. One message shape for all of them, naming the card's own label.
export const assertScope = (scopes: DeviceScopes, scope: SwitchName): void => {
    if (scopes[scope] === "on") {
        return;
    }
    throw new ScopeError(`Refused: "${SWITCH_LABELS[scope]}" is switched off for this device. Turn it on in its capability card to allow this.`);
};
