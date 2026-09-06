// @vitest-environment jsdom
//
// The mark for work a session's last turn left open, drawn on the fleet board's card. What is load-bearing here
// is the HOVER, exactly as it is for the unsent chip beside it: the face can only say that something was left,
// and what the reader decides on is what was left, whether the tree is red, and how long ago it happened. The
// two evidence halves are independent, so each has to read as a sentence on its own and both have to read as
// one when they arrive together. Mounted with plain Vue and the same glyph/tooltip stubs UnsentMark.test uses.
import { describe, expect, it } from "vitest";
import { type App, createApp, defineComponent, h } from "vue";
import type { UnfinishedWork } from "@intentic/sandbox-contract";

import UnfinishedMark from "./UnfinishedMark.vue";

let app: App | undefined;
let opens: Partial<Record<string, boolean>> = {};

const render = (work: UnfinishedWork, now?: number): HTMLElement => {
    app?.unmount();
    const host = document.createElement(`div`);
    document.body.append(host);
    app = createApp({ render: () => h(UnfinishedMark, { work, now }) });
    app.component(
        `Icon`,
        defineComponent({
            props: { name: String },
            render() {
                return h(`i`, { "data-icon": this.name });
            },
        }),
    );
    opens = {};
    app.directive(`tooltip`, {
        mounted: (_el, binding) => {
            opens = binding.modifiers;
        },
    });
    app.mount(host);
    return host;
};

// Read off the accessible name, which carries the same string as the tooltip for the reason the aria-label
// exists at all: a tooltip is not announced.
const hintOf = (work: UnfinishedWork, now?: number): string | null => render(work, now).querySelector(`span`)!.getAttribute(`aria-label`);

const HOUR = 3_600_000;

describe(`<UnfinishedMark>`, () => {
    it(`says it in a word, beside the checklist glyph`, () => {
        const host = render({ at: 1_000, steps: { open: 3, total: 7 } }, 1_000);
        expect(host.textContent?.trim()).toBe(`Unfinished`);
        expect(host.querySelector(`[data-icon]`)?.getAttribute(`data-icon`)).toBe(`list-check`);
    });

    /* THE COUNT AND THE NEXT STEP ARE THE HOVER'S WHOLE JOB. "3 of 7" is what says whether this is a session
     * that stopped at the door or one that barely started, and the step names the work in the agent's own
     * words, which is the difference between "go and look" and "go and do this". */
    it(`counts what was left and names what came next`, () => {
        expect(hintOf({ at: 1_000, steps: { open: 3, total: 7, next: `Wire the badge into the card` } }, 1_000 + 2 * HOUR)).toBe(
            `Stopped with 3 of 7 steps unfinished, 2h: Wire the badge into the card`,
        );
    });

    // A list with one thing left on it is not "1 steps".
    it(`says one step in the singular`, () => {
        expect(hintOf({ at: 1_000, steps: { open: 1, total: 4, next: `Run the suite` } }, 1_000)).toBe(
            `Stopped with 1 of 4 steps unfinished, just now: Run the suite`,
        );
    });

    // The list is the agent's, and an agent that kept none leaves the check to speak alone: the workspace's own
    // gate went red on the way out, which is a fact about the tree and needs no checklist behind it.
    it(`reports a red check on its own when there was no list`, () => {
        expect(hintOf({ at: 1_000, check: `Verify before you finish` }, 1_000 + HOUR)).toBe(
            `Its own check was still failing, 1h: Verify before you finish`,
        );
    });

    /* BOTH HALVES, ONE HOVER, and the age is said once. They are separate evidence — what the agent said it
     * would do, and what the workspace measured about what it left — so they are separate sentences; repeating
     * "2h" in the second would read as two different moments. */
    it(`says both without repeating the age`, () => {
        expect(hintOf({ at: 1_000, steps: { open: 2, total: 5, next: `Cover it with tests` }, check: `Verify before you finish` }, 1_000 + 2 * HOUR)).toBe(
            `Stopped with 2 of 5 steps unfinished, 2h: Cover it with tests. Its own check was still failing too: Verify before you finish`,
        );
    });

    // A list whose open item the daemon could not name (a harness whose frames carry no content for it) still
    // reports the count rather than trailing a colon into nothing.
    it(`drops the step rather than rendering a hole when there is none to name`, () => {
        expect(hintOf({ at: 1_000, steps: { open: 2, total: 5 } }, 1_000)).toBe(`Stopped with 2 of 5 steps unfinished, just now`);
    });

    /* The age is computed against the HOST'S TICK, not the clock: a settled card's props never move, so a
     * component reading the clock itself would render the age it was built with and keep it forever. */
    it(`ages against the tick it is given rather than the wall clock`, () => {
        expect(hintOf({ at: 1_000, steps: { open: 1, total: 2 } }, 1_000 + 3 * HOUR)).toContain(`unfinished, 3h`);
    });

    // Downwards, for the reason the unsent chip opens downwards: both sit directly under the session's title,
    // and a hover that covers the title answers "which session is this" by hiding the answer.
    it(`opens away from the title it belongs to`, () => {
        render({ at: 1_000, steps: { open: 1, total: 2 } }, 1_000);
        expect(opens).toEqual({ bottom: true });
    });
});
