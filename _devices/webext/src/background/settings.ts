// The person's own preferences for this extension, as opposed to anything a sandbox decides. Apart from store.ts so
// the popup can read the defaults without bundling zod, which its size budget (scripts/size-budget.mjs) has no room
// for.
export interface Settings {
    // Open the popup by itself when the agent asks for a site, or asks something in a window they cannot see, instead
    // of leaving only a badge.
    readonly openOnAsk: boolean;
    // Where the agent's pages open: a window of its own, behind theirs (agent-window.ts), or the tab in front of them,
    // as every version before 2026-10-28 did.
    readonly workIn: "own-window" | "front-tab";
}

export const DEFAULT_SETTINGS: Settings = { openOnAsk: true, workIn: "own-window" };
