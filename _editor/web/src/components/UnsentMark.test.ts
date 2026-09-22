// Tests what the hover says, not the markup: the mark itself can only say a message exists, so the hover carries
// which one and how long. Mounted with plain Vue, glyph and tooltip stubbed as in MatchLine.test / Subagents.test.
import "@intentic/testing/dom";
import { describe, it, expect, spyOn, jest } from "bun:test";
import { mocked } from "@intentic/testing/bun";
import { type App, createApp, h, nextTick } from "vue";

import UnsentMark from "./UnsentMark.vue";
import { IconStub } from "@intentic/ui/testing";

let app: App | undefined;
// Hover direction, read off the tooltip directive's binding modifiers (a stub renders nothing else to measure).
let opens: Partial<Record<string, boolean>> = {};

const render = (props: { preview?: string; at?: number }): HTMLElement => {
    app?.unmount();
    const host = document.createElement(`div`);
    document.body.append(host);
    app = createApp({ render: () => h(UnsentMark, props) });
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

// Read off aria-label, which mirrors the tooltip text since a tooltip itself isn't announced.
const hintOf = (props: { preview?: string; at?: number }): string | null => render(props).querySelector(`span`)!.getAttribute(`aria-label`);

describe(`<UnsentMark>`, () => {
    // A chip with the send glyph, not a lone icon, so it doesn't blend in while skimming the rail.
    it(`says it in a word, beside the send glyph`, () => {
        const host = render({ preview: `fix the login redirect`, at: 1_000 });
        expect(host.textContent?.trim()).toBe(`Unsent`);
        expect(host.querySelector(`[data-icon]`)?.getAttribute(`data-icon`)).toBe(`send`);
    });

    it(`names the message and how long it has been standing`, () => {
        spyOn(Date, `now`).mockReturnValue(1_000_000);
        try {
            expect(hintOf({ preview: `fix the login redirect`, at: 1_000_000 - 12 * 60_000 })).toBe(`Not sent, 12m: fix the login redirect`);
        } finally {
            mocked(Date.now).mockRestore();
        }
    });

    // Ages off the shared clock the mark arms itself, and keeps ageing: a tick handed down as a prop made the rail
    // that hosts the mark redraw every card it holds, once a second, to move this one line.
    it(`ages against the shared clock as it advances`, async () => {
        jest.useFakeTimers();
        // A multiple of the mark's 15s step, so the quantised reading is the system time itself.
        jest.setSystemTime(600_000);
        try {
            const host = render({ preview: `fix the login redirect`, at: 580_000 });
            expect(host.querySelector(`span`)!.getAttribute(`aria-label`)).toBe(`Not sent, just now: fix the login redirect`);
            jest.advanceTimersByTime(45_000);
            await nextTick();
            expect(host.querySelector(`span`)!.getAttribute(`aria-label`)).toBe(`Not sent, 1m: fix the login redirect`);
        } finally {
            app?.unmount();
            app = undefined;
            jest.useRealTimers();
        }
    });

    // An attachment or a queued message has nothing to quote; the mark still shows, the hint just omits the words.
    it(`reports the age alone when what is unsent is not typed words`, () => {
        spyOn(Date, `now`).mockReturnValue(2 * 86_400_000);
        try {
            expect(hintOf({ at: 0 })).toBe(`Not sent, 2d`);
        } finally {
            mocked(Date.now).mockRestore();
        }
    });

    // With neither the words nor the age (e.g. a snapshot with no stamp), the hint names the state plainly rather
    // than repeating the chip's own 'Unsent' label.
    it(`falls back to naming the state when it has neither the words nor the age`, () => {
        expect(hintOf({})).toBe(`You have an unsent message here`);
    });

    // Opens downward: the mark sits under the session title in every frame, and an upward hover would cover it
    // instead of the meta line below. On the rail this also clears HoverCard, opening to the right off the same hover.
    it(`opens away from the title it belongs to`, () => {
        render({ preview: `fix the login redirect`, at: 1_000 });
        expect(opens).toEqual({ bottom: true });
    });
});
