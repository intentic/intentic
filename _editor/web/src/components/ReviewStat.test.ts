// @vitest-environment jsdom
//
// The badge's job is to never state a number the pane beside it will contradict, so what is asserted here is
// WHICH reading it prints in each state — not its markup. Mounted with plain Vue, as markdownFigures.test does,
// rather than adding @vue/test-utils for three assertions.
import { describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick } from "vue";

vi.hoisted(() => {
    globalThis.matchMedia ??= ((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
    })) as unknown as typeof matchMedia;
});

import ReviewStat from "./ReviewStat.vue";
import { useLayout } from "../composables/useLayout";
import type { LineStat } from "../composables/workspace/codeStat";

const { showComments, toggleShowComments } = useLayout();

interface Props {
    code?: LineStat;
    additions?: number;
    deletions?: number;
}

const render = (props: Props): HTMLElement => {
    const host = document.createElement(`div`);
    document.body.append(host);
    const app = createApp({ render: () => h(ReviewStat, props) });
    // Both are global in the real app (installUi). The glyph is stubbed away because nothing here asserts on it;
    // the tooltip keeps its text, since which reading the hover offers is half of what this file is about.
    app.component(`Icon`, { render: () => null });
    app.directive(`tooltip`, {
        mounted: (el: HTMLElement, binding: { value?: string }) => {
            if (binding.value !== undefined) {
                el.dataset[`tip`] = binding.value;
            }
        },
    });
    app.mount(host);
    return host;
};

const withComments = async (on: boolean): Promise<void> => {
    if (showComments.value !== on) {
        toggleShowComments();
    }
    await nextTick();
};

describe(`<ReviewStat>`, () => {
    it(`prints the code-only counts while the comments are hidden, and says what git makes it on hover`, async () => {
        await withComments(false);
        const host = render({ code: { additions: 3, deletions: 0 }, additions: 34, deletions: 8 });

        expect(host.textContent).toContain(`+3`);
        expect(host.textContent).not.toContain(`34`);
        expect(host.querySelector<HTMLElement>(`[data-tip]`)?.dataset[`tip`]).toBe(`Code only · +34 −8 counting comments`);
    });

    it(`hands the numbers back to git when the reader asks for the comments`, async () => {
        await withComments(true);
        const host = render({ code: { additions: 3, deletions: 0 }, additions: 34, deletions: 8 });

        expect(host.textContent).toContain(`+34`);
        expect(host.textContent).toContain(`−8`);
        // Nothing differs from what is on screen, so there is nothing for a hover to add.
        expect(host.querySelector(`[data-tip]`)).toBeNull();
    });

    it(`says a change is comments rather than showing it as nothing at all`, async () => {
        await withComments(false);
        const host = render({ code: { additions: 0, deletions: 0 }, additions: 26, deletions: 4 });

        // +0 −0 is how the badge says "a rename", and it reads as though the file were untouched.
        expect(host.textContent).toContain(`comments`);
        expect(host.querySelector<HTMLElement>(`[data-tip]`)?.dataset[`tip`]).toBe(`Only comments changed — +26 −4 of them`);
    });

    it(`shows git's own for a file it could not strip, with nothing extra claimed on hover`, async () => {
        await withComments(false);
        const host = render({ code: undefined, additions: 12, deletions: 2 });

        expect(host.textContent).toContain(`+12`);
        expect(host.textContent).toContain(`−2`);
        expect(host.querySelector(`[data-tip]`)).toBeNull();
    });
});
