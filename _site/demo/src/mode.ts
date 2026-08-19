import { AWAITING_AGENT_ID, FEATURED_AGENT_ID, REVIEW_AGENT_ID } from "./fixture/fleet";

/* HOW FULL THE RECORDING IS — the three states a visitor can put this workspace in, from the switcher at the
 * bottom of the screen (switcher.ts).
 *
 * The fixture was written to prove that every surface exists, so it opened on all of them at once: nine agents
 * across three lanes, a question, a land conflict, and fourteen extensions in the rail. That is a fair picture
 * of a busy afternoon and a terrible first frame — someone who pressed play on a marketing page has no way to
 * tell the product apart from the demonstration of it. So the fullness is now a control rather than a constant,
 * and the demo opens on the middle one.
 *
 * Two knobs decide almost all of it, because they are what the app builds itself out of: WHICH AGENTS the
 * daemon's roster carries, and WHICH EXTENSIONS the owner has left switched on (an extension that is off
 * contributes no rail tile, no view and no badge — the loader never activates it). A third, the teammate's
 * presence, is here because a second avatar is the one remaining piece of furniture nobody chose. A fourth,
 * the open chats, because the rail's Personas cut is built from the conversations this WINDOW holds rather
 * than from the personas the daemon serves — so an empty strip empties that surface too.
 *
 * Everything else the fixture serves stays put in every mode: the workspace and its diffs, the sessions
 * history, the pipelines' own record, the connected accounts. Those are read on the way in to a surface the
 * visitor asked for, not things the opening frame is made of.
 *
 * The mode is applied where it is SERVED rather than by rewriting the fixtures: daemon.ts filters the roster and
 * the presence frame, sandbox.ts decides each extension's switch. So the fixture stays one full cast and a mode
 * is a view onto it. */

export type DemoModeId = `minimal` | `default` | `full`;

export interface DemoMode {
    readonly id: DemoModeId;
    /** The switcher's button. */
    readonly label: string;
    /** The line beside it: what this state IS, in the product's own terms. */
    readonly note: string;
    /** The agents on the board, in the fleet's own order. `undefined` is the whole roster. */
    readonly agents?: readonly string[];
    /** The extensions left switched on. `undefined` is every one of them. */
    readonly extensions?: readonly string[];
    /** Whether a second member is in the workspace. */
    readonly teammate: boolean;
    /* Whether this window opens holding chats at all — the featured run plus one per persona
     * (fixture/openChats.ts). A fourth knob rather than a constant for the same reason as the three above:
     * the chat rail's Personas cut counts the conversations the WINDOW holds, so open tabs are what makes
     * that surface exist — and open tabs are exactly what the emptiest state is claiming there aren't. */
    readonly openChats: boolean;
}

/* One agent and nothing else — a sandbox on its first afternoon. The one kept is the featured turn, because a
 * board with a single card is only worth showing if opening that card streams a real conversation (turn.ts). */
const MINIMAL: DemoMode = {
    id: `minimal`,
    label: `Minimal`,
    note: `One agent, no extensions.`,
    agents: [FEATURED_AGENT_ID],
    extensions: [],
    teammate: false,
    openChats: false,
};

/* THE ONE THE PLAY BUTTON OPENS. Three agents, one per lane, chosen as the three moments the landing page
 * claims: a turn running with subagents under it, a question parked for a person, and a finished delta held for
 * a deliberate land. No conflict, no workflow fan-out, no overnight automation — each of those is a second
 * story told over the first.
 *
 * Three extensions, the three that are richest here and read as different KINDS of surface: stories walked in a
 * browser, a documented repository, and the CI the changes ran through. `viewers` joins them for a reason a
 * visitor never sees a tile for — it is what makes an image or a PDF in the file tree open as itself. */
const DEFAULT: DemoMode = {
    id: `default`,
    label: `Default`,
    note: `Three agents, three extensions.`,
    agents: [FEATURED_AGENT_ID, AWAITING_AGENT_ID, REVIEW_AGENT_ID],
    extensions: [`intentic.acceptance`, `intentic.documentation`, `intentic.pipelines`, `intentic.viewers`],
    teammate: true,
    openChats: true,
};

// Everything the fixture has, which is what this demo used to open on: every lane occupied and every extension
// in the rail. Kept as a mode rather than deleted — it is the honest picture of a team's Tuesday, and the one
// state that shows the whole product at once.
const FULL: DemoMode = {
    id: `full`,
    label: `Everything`,
    note: `The whole fleet, every extension.`,
    teammate: true,
    openChats: true,
};

export const DEMO_MODES: readonly DemoMode[] = [MINIMAL, DEFAULT, FULL];

// Per TAB, not per browser: a visitor who tried Everything last week should still meet the curated opening
// frame today, while a switch has to survive the reload it causes.
const STORAGE_KEY = `intentic.demo.mode`;

const resolve = (): DemoMode => {
    const url = new URL(window.location.href);
    const asked = url.searchParams.get(`mode`);
    if (asked !== null) {
        // Consumed rather than kept: a `mode` left in the address outranks the switcher, so the next press
        // would reload into the state the visitor just left.
        url.searchParams.delete(`mode`);
        window.history.replaceState(window.history.state, ``, url);
    }
    const mode = DEMO_MODES.find((candidate) => candidate.id === (asked ?? window.sessionStorage.getItem(STORAGE_KEY)));
    if (mode !== undefined) {
        window.sessionStorage.setItem(STORAGE_KEY, mode.id);
    }
    return mode ?? DEFAULT;
};

/** The state this page load is serving. Resolved once, before the app boots — every fixture reads it. */
export const demoMode = resolve();

/* Switching is a RELOAD, and deliberately so: the extension host activates the daemon's list once per app load
 * (useExtensionHost.ts), so which tiles the rail carries is decided on the way in. Rebroadcasting a roster
 * without it would change half the picture and leave the other half stale.
 *
 * It lands on the fleet board rather than on the current address, because the route the visitor is standing on
 * may belong to an extension the next mode switches off. */
export const setDemoMode = (id: DemoModeId): void => {
    window.sessionStorage.setItem(STORAGE_KEY, id);
    window.location.assign(`${import.meta.env.BASE_URL}agents`);
};
