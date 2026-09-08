import { AWAITING_AGENT_ID, FEATURED_AGENT_ID, REVIEW_AGENT_ID } from "./fixture/fleet";

// Three levels of how full the recording is, picked from the switcher (switcher.ts). Mainly two knobs, which agents the
// roster carries and which extensions are on, plus teammate presence and open chats. Applied where served (daemon.ts,
// sandbox.ts), not by rewriting the fixtures.

export type DemoModeId = `minimal` | `default` | `full`;

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
};

// Three agents matching the landing page's three claims; three extensions plus viewers for file previews.
const DEFAULT: DemoMode = {
    id: `default`,
    label: `Default`,
    note: `Three agents, three extensions.`,
    agents: [FEATURED_AGENT_ID, AWAITING_AGENT_ID, REVIEW_AGENT_ID],
    extensions: [`intentic.acceptance`, `intentic.documentation`, `intentic.pipelines`, `intentic.viewers`],
    teammate: true,
    openChats: true,
};

// Every lane and extension: kept as the one mode that shows the whole product at once.
const FULL: DemoMode = {
    id: `full`,
    label: `Everything`,
    note: `The whole fleet, every extension.`,
    teammate: true,
    openChats: true,
};

export const DEMO_MODES: readonly DemoMode[] = [MINIMAL, DEFAULT, FULL];

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
    return mode ?? DEFAULT;
};

/** State this page load serves, resolved once before boot; every fixture reads it. */
export const demoMode = resolve();

// Switching reloads: extensions activate once per app load, so a live rebroadcast would go half-stale. Lands on the
// fleet board, since the current route might belong to an extension about to switch off.
export const setDemoMode = (id: DemoModeId): void => {
    window.sessionStorage.setItem(STORAGE_KEY, id);
    window.location.assign(`${import.meta.env.BASE_URL}agents`);
};
