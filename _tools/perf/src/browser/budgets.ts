import type { Budget } from "../baseline.js";
import { IDLE_MS, TICK_MS, TYPED } from "./scenarios.js";

const IDLE_TICKS = IDLE_MS / TICK_MS;

/**
 * What the browser counts may not exceed. Everything else they measure is a report against baselines/browser.json.
 * Each limit is a claim about how far one event's redraw reaches, set well above today's reading so it breaks when the
 * redraw starts reaching the page rather than when one more component joins it.
 */
export const BROWSER_BUDGETS: readonly Budget[] = [
    {
        name: "agents-idle: Vue renders per clock tick",
        // Recorded at 80 renders over 15 ticks (5.3 a tick) on a board that mounts about 300 components: the tick
        // redraws each running card's clock, its checks and the Main line summary. Eight leaves room for a card or two
        // more and fails when the tick starts reaching components that do not show the time.
        claim: "one tick of the shared clock (useNow) redraws only what shows the time, never the board around it",
        reads: ["agents-idle"],
        value: (measured) => measured["agents-idle"]!["vue.renders"]! / IDLE_TICKS,
        max: 8,
    },
    {
        name: "chat-typing: Vue renders per keystroke",
        // Recorded at 82 renders over 20 keystrokes (4.1 each): the chat pane once a key, and the rail's card and unsent
        // mark for the draft. Six leaves room for one more dependant and fails when the draft becomes a dependency of the
        // transcript's rows or of the rail as a whole.
        claim: "a keystroke in the composer redraws what shows the draft, not the transcript or the rail around it",
        reads: ["chat-typing"],
        value: (measured) => measured["chat-typing"]!["vue.renders"]! / TYPED.length,
        max: 6,
    },
];
