import { AWAITING_AGENT_ID, FEATURED_AGENT_ID, LATENCY_AGENT_ID, RELEASE_NOTES_AGENT_ID, REVIEW_AGENT_ID } from "./fixture/fleet";

// Three levels of how full the recording is, picked by `?mode=` (no on-screen switcher; minimal is the default). Mainly two knobs, which agents the
// roster carries and which extensions are on, plus teammate presence and open chats. Applied where served (daemon.ts,
// sandbox.ts), not by rewriting the fixtures.

export type DemoModeId = `minimal` | `default` | `full` | `showcase` | `desk`;

export interface DemoMode {
    readonly id: DemoModeId;
    /** Switcher's button label. */
    readonly label: string;
    /** Line beside the label, in the product's own terms. */
    readonly note: string;
    /** Agents on the board, fleet order; `undefined` is the whole roster. */
    readonly agents?: readonly string[];
    /** Extensions left on; `undefined` means all of them. */
    readonly extensions?: readonly string[];
    /** Whether a second member is in the workspace. */
    readonly teammate: boolean;
    // Whether the window opens holding chats: the featured run plus one per persona.
    readonly openChats: boolean;
    /** Served quiet (see `demoQuiet` below) whatever the session asks. */
    readonly quiet?: true;
}

// One agent kept: the featured run, since its card is the one with a real conversation behind it.
const MINIMAL: DemoMode = {
    id: `minimal`,
    label: `Minimal`,
    note: `One agent, no extensions.`,
    agents: [FEATURED_AGENT_ID],
    extensions: [],
    teammate: false,
    openChats: false,
    quiet: true,
};

// Three agents matching the landing page's three claims; three extensions plus viewers for file previews.
const DEFAULT: DemoMode = {
    id: `default`,
    label: `Curated`,
    note: `Three agents, three extensions.`,
    agents: [FEATURED_AGENT_ID, AWAITING_AGENT_ID, REVIEW_AGENT_ID],
    extensions: [`intentic.acceptance`, `intentic.documentation`, `intentic.pipelines`, `intentic.viewers`],
    teammate: true,
    openChats: true,
    quiet: true,
};

// Every lane and extension, and the one mode served loud: every state a surface distinguishes, there to be explored.
const FULL: DemoMode = {
    id: `full`,
    label: `Everything`,
    note: `The whole fleet, every extension, every state.`,
    teammate: true,
    openChats: true,
};

// What the site's screenshots are taken of (_tools/e2e/shots/capture.mts), and served quiet: the curated three plus a
// second agent at work and a second finished one, so the board reads as an ordinary afternoon with a few things moving
// rather than as one specimen per lane. No extensions, so the rail is the core and nothing else.
const SHOWCASE: DemoMode = {
    id: `showcase`,
    label: `Showcase`,
    note: `A calm afternoon: what the site's screenshots show.`,
    agents: [FEATURED_AGENT_ID, AWAITING_AGENT_ID, LATENCY_AGENT_ID, REVIEW_AGENT_ID, RELEASE_NOTES_AGENT_ID],
    extensions: [],
    teammate: true,
    openChats: true,
    quiet: true,
};

// A different workspace rather than a fullness: documents instead of code, one assistant, the maker's own words. What
// intentic.dev/desk's screenshots are taken of, and where its "open the live workspace" link lands. The roster is its
// own (fixture/desk.ts), so `agents` is not a filter here; the two extensions are the maker's home and the viewers that
// draw a document.
const DESK: DemoMode = {
    id: `desk`,
    label: `Desk`,
    note: `Documents, not code: one assistant on your files.`,
    extensions: [`intentic.projects`, `intentic.viewers`],
    teammate: false,
    openChats: true,
    quiet: true,
};

export const DEMO_MODES: readonly DemoMode[] = [MINIMAL, DEFAULT, FULL, SHOWCASE, DESK];

// Session storage: per tab, surviving the reload a switch causes but not a new visit.
const STORAGE_KEY = `intentic.demo.mode`;

const resolve = (): DemoMode => {
    const url = new URL(window.location.href);
    const asked = url.searchParams.get(`mode`);
    if (asked !== null) {
        // Consumed from the URL so a stale `?mode=` can't outrank the switcher on the next reload.
        url.searchParams.delete(`mode`);
        window.history.replaceState(window.history.state, ``, url);
    }
    const mode = DEMO_MODES.find((candidate) => candidate.id === (asked ?? window.sessionStorage.getItem(STORAGE_KEY)));
    if (mode !== undefined) {
        window.sessionStorage.setItem(STORAGE_KEY, mode.id);
    }
    return mode ?? MINIMAL;
};

/** State this page load serves, resolved once before boot; every fixture reads it. */
export const demoMode = resolve();

// WHICH TIER IS READING, from `?as=`, sticky per tab like the mode above it. Not a fullness and not an audience: a
// grant, which changes what the shell draws at all. A desk is a different app — two rail seats, no hub, no files —
// and without this the recording could only ever be looked at as the owner, which is the one tier none of that
// narrowing applies to. `?as=owner` (or a fresh tab) is the way back.
const TIER_KEY = `intentic.demo.tier`;
const TIERS = [`owner`, `maintainer`, `collaborator`, `viewer`, `guest`] as const;
export type DemoTier = (typeof TIERS)[number];

const resolveTier = (): DemoTier => {
    const url = new URL(window.location.href);
    const asked = url.searchParams.get(`as`);
    if (asked !== null) {
        url.searchParams.delete(`as`);
        window.history.replaceState(window.history.state, ``, url);
    }
    const tier = TIERS.find((candidate) => candidate === (asked ?? window.sessionStorage.getItem(TIER_KEY)));
    if (tier !== undefined) {
        window.sessionStorage.setItem(TIER_KEY, tier);
    }
    return tier ?? `owner`;
};

/** The grant this page load is read with; the platform's sandbox row carries it, as a real one would. */
export const demoTier = resolveTier();

/** Whether this page load is the desk recording: the one switch every fixture seam reads. */
export const deskEdition = demoMode.id === `desk`;

// The look and the audience the desk recording is read in, the same three keys the desk PROFILE seeds (@intentic/constants
// profile.ts): light, unskinned, a maker. index.html's pre-paint script writes them for the first frame; this writes
// them on a switch, and takes them back on the way out so the code recording opens in the reader's own light again.
const DESK_LOOK: Record<string, string> = { "ui-color-scheme": `light`, "ui-skin": `none`, "ui-audience": `maker` };

const applyLook = (desk: boolean): void => {
    for (const [key, value] of Object.entries(DESK_LOOK)) {
        if (desk) {
            window.localStorage.setItem(key, value);
        } else {
            window.localStorage.removeItem(key);
        }
    }
};

// Which extensions start on, with one override the switcher never writes: the marketing shots harness pins it so a
// board screenshot can carry this mode's agents AND an empty rail. The two are one knob otherwise — every enabled
// extension adds an icon and a badge — and a shot of the fleet wants the roster without the chrome around it.
const EXTENSIONS_KEY = `intentic.demo.extensions`;

export const enabledExtensions = (): readonly string[] | undefined => {
    const pinned = window.sessionStorage.getItem(EXTENSIONS_KEY);
    if (pinned === null) {
        return demoMode.extensions;
    }
    try {
        const parsed: unknown = JSON.parse(pinned);
        return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === `string`) : demoMode.extensions;
    } catch {
        return demoMode.extensions;
    }
};

// QUIET: the same recording on an uneventful afternoon. The recording is built to show every state a surface
// distinguishes (a prompt cache about to cool, a key an agent is waiting for, a failing pipeline, a teammate's reaction, a
// plugin's warning), which is right for a visitor hunting edge cases and wrong for one meeting the product, and for a
// picture whose job is to show the workspace at rest. Quiet takes those out where they are served (daemon.ts,
// needs.ts, turn.ts) and leaves every agent, file and conversation where it was. Every mode but Everything is quiet;
// Everything is too when the session holds the key below, which only the screenshots harness writes. The key's value
// is a JSON list of the disturbances a shot still needs, since some pictures are OF one: the Environment shot is of
// the change an agent proposed.
const QUIET_KEY = `intentic.demo.quiet`;

/** A disturbance a quiet session can ask to keep. */
export type QuietKeep = `proposal`;

const resolveQuiet = (): { readonly on: boolean; readonly keeps: ReadonlySet<QuietKeep> } => {
    const asked = window.sessionStorage.getItem(QUIET_KEY);
    if (asked === null) {
        return { on: demoMode.quiet === true, keeps: new Set() };
    }
    try {
        const parsed: unknown = JSON.parse(asked);
        return { on: true, keeps: new Set(Array.isArray(parsed) ? parsed.filter((keep): keep is QuietKeep => keep === `proposal`) : []) };
    } catch {
        return { on: true, keeps: new Set() };
    }
};

const quiet = resolveQuiet();

/** Whether this page load is served quiet, and so without the disturbance named unless the session kept it. */
export const demoQuiet = (keeping?: QuietKeep): boolean => quiet.on && (keeping === undefined || !quiet.keeps.has(keeping));

// Switching reloads: extensions activate once per app load, so a live rebroadcast would go half-stale. Lands on the
// fleet board, since the current route might belong to an extension about to switch off.
export const setDemoMode = (id: DemoModeId): void => {
    window.sessionStorage.setItem(STORAGE_KEY, id);
    if ((id === `desk`) !== deskEdition) {
        applyLook(id === `desk`);
    }
    window.location.assign(`${import.meta.env.BASE_URL}agents`);
};
