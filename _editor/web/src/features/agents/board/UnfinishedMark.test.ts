// @vitest-environment jsdom
// The mark for work a session's last turn left open, on the fleet board's card; the hover is load-bearing, like the
// unsent chip's, since the face only says something was left.
// Two independent evidence halves (steps left, and the workspace's own check); each must read as a sentence alone and
// both together.
import { describe, expect, it } from "vitest";
import { type App, createApp, h } from "vue";
import type { UnfinishedWork } from "@intentic/sandbox-contract";

import UnfinishedMark from "./UnfinishedMark.vue";
import { IconStub } from "@intentic/ui/testing";

let app: App | undefined;
let opens: Partial<Record<string, boolean>> = {};

const render = (work: UnfinishedWork, now?: number): HTMLElement => {
    app?.unmount();
    const host = document.createElement(`div`);
    document.body.append(host);
    app = createApp({ render: () => h(UnfinishedMark, { work, now }) });
    app.component(`Icon`, IconStub);
    opens = {};
    app.directive(`tooltip`, {
        mounted: (_el, binding) => {
            opens = binding.modifiers;
        },
    });
    app.mount(host);
    return host;
};

// Reads the accessible name, the same string as the tooltip, since a tooltip itself is never announced.
const hintOf = (work: UnfinishedWork, now?: number): string | null => render(work, now).querySelector(`span`)!.getAttribute(`aria-label`);

const HOUR = 3_600_000;

describe(`<UnfinishedMark>`, () => {
    it(`says it in a word, beside the checklist glyph`, () => {
        const host = render({ at: 1_000, steps: { open: 3, total: 7 } }, 1_000);
        expect(host.textContent?.trim()).toBe(`Unfinished`);
        expect(host.querySelector(`[data-icon]`)?.getAttribute(`data-icon`)).toBe(`list-check`);
    });

    // Count and next step are the hover's whole job: "3 of 7" says how far the session got, and the step names the work
    // in the agent's own words.
    it(`counts what was left and names what came next`, () => {
        expect(hintOf({ at: 1_000, steps: { open: 3, total: 7, next: `Wire the badge into the card` } }, 1_000 + 2 * HOUR)).toBe(
            `Stopped with 3 of 7 steps unfinished, 2h: Wire the badge into the card`,
        );
    });

    // A list with one thing left is not "1 steps".
    it(`says one step in the singular`, () => {
        expect(hintOf({ at: 1_000, steps: { open: 1, total: 4, next: `Run the suite` } }, 1_000)).toBe(
            `Stopped with 1 of 4 steps unfinished, just now: Run the suite`,
        );
    });

    // An agent that kept no checklist leaves the check to speak alone: a failing gate is a fact about the tree, needing
    // no list behind it.
    it(`reports a red check on its own when there was no list`, () => {
        expect(hintOf({ at: 1_000, check: `Verify before you finish` }, 1_000 + HOUR)).toBe(
            `Its own check was still failing, 1h: Verify before you finish`,
        );
    });

    // Both halves share one hover with the age said once: they're separate evidence (what the agent said it would do,
    // what the workspace measured), so separate sentences, but repeating the age would read as two different moments.
    it(`says both without repeating the age`, () => {
        expect(hintOf({ at: 1_000, steps: { open: 2, total: 5, next: `Cover it with tests` }, check: `Verify before you finish` }, 1_000 + 2 * HOUR)).toBe(
            `Stopped with 2 of 5 steps unfinished, 2h: Cover it with tests. Its own check was still failing too: Verify before you finish`,
        );
    });

    // A step the daemon couldn't name (a harness whose frames carry no content) still reports the count, rather than
    // trailing a colon into nothing.
    it(`drops the step rather than rendering a hole when there is none to name`, () => {
        expect(hintOf({ at: 1_000, steps: { open: 2, total: 5 } }, 1_000)).toBe(`Stopped with 2 of 5 steps unfinished, just now`);
    });

    // Age comes from the host's own tick, not the wall clock, since a settled card's props never change and a
    // self-reading clock would freeze at build time.
    it(`ages against the tick it is given rather than the wall clock`, () => {
        expect(hintOf({ at: 1_000, steps: { open: 1, total: 2 } }, 1_000 + 3 * HOUR)).toContain(`unfinished, 3h`);
    });

    // Opens downward, like the unsent chip: both sit under the session's title, and a hover covering the title would
    // hide the answer to "which session is this".
    it(`opens away from the title it belongs to`, () => {
        render({ at: 1_000, steps: { open: 1, total: 2 } }, 1_000);
        expect(opens).toEqual({ bottom: true });
    });
});
