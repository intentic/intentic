import type { Budget } from "../baseline.js";
import { DRAG_MOVES, IDLE_MS, TICK_MS, TYPED } from "./scenarios.js";

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

/**
 * Budgets on scenarios the record workflow (perf-record.yml) has not recorded yet. Judged on every run like the rest,
 * so a regression fails CI from the day the scenario lands; moved into BROWSER_BUDGETS by the change that commits the
 * scenario's first recording, which budgets.test.ts holds them to from then on, headroom and all.
 */
export const UNRECORDED_BROWSER_BUDGETS: readonly Budget[] = [
    {
        name: "chat-edge-drag: elements restyled per frame of the drag",
        // Measured at 1,092 over 24 frames (45 each; Chromium 156, 2026-11-19), most of it the release, where the board
        // folds at its breakpoint and its cards redraw. Before `--side-width` was registered non-inherited it was 16,869
        // (703 a frame): the custom property changed on the shell's root restyled the whole app every frame. 150 fails
        // long before that.
        claim: "a frame of a drag of the chat's edge restyles the shell's grid, not the page under it",
        reads: ["chat-edge-drag"],
        value: (measured) => measured["chat-edge-drag"]!["blink.styledElements"]! / DRAG_MOVES,
        max: 150,
    },
    {
        name: "chat-edge-drag: Vue renders per frame of the drag",
        // Measured at 52 renders over 24 frames (2.2 each), none of them the shell's or the side panel's: the seam's own
        // light going on and off, and the board's cards folding at its breakpoint, which waits for the release. When the
        // width was a template binding it was 244 (10.2 a frame): the shell, its rail's every tile and the side panel,
        // each frame. Five leaves room for a release that redraws more and fails when the frames redraw again.
        claim: "a frame of a drag of the chat's edge redraws no component; the release redraws what changed size",
        reads: ["chat-edge-drag"],
        value: (measured) => measured["chat-edge-drag"]!["vue.renders"]! / DRAG_MOVES,
        max: 5,
    },
];
