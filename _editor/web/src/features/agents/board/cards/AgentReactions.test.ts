// jsdom: the subject is what the strip draws and what a press sends, neither of which is readable off the code.
// What it pins: the names ride with the chip (the whole point of a reaction over a private bookmark), and a press
// states an intent rather than flipping whatever the daemon happens to hold.
import "@intentic/testing/dom";
import type { AgentReaction } from "@intentic/sandbox-contract";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";
import { PICKER_EMOJI, QUICK_EMOJI } from "./reactions";

const reacted = jest.fn(async () => ({}) as never);
const refresh = jest.fn(async () => {});
const me = ref<string | undefined>(`ada@example.com`);

// The factory is synchronous: a jest.mock factory runs in place, and awaiting inside one that replaces a module
// already in this file's graph never returns.
jest.mock("@intentic/ui", () => {
    return {
        ui: { iconButton: () => `` },
        // Draws its slot when open, since whether the picker is open — and what it then offers — is half of what this
        // component does; anchoring and placement are the overlay's own business, tested where it lives.
        ResponsiveOverlay: defineComponent({
            name: `ResponsiveOverlay`,
            props: { modelValue: Boolean },
            setup:
                (props, { slots }) =>
                () =>
                    props.modelValue ? h(`div`, { "data-picker": `` }, slots[`default`]?.()) : null,
        }),
        useDevice: () => ({ mobile: ref(false) }),
    };
});
jest.mock("../../fleet/agentActions", () => ({ reactToAgent: reacted }));
jest.mock("../../fleet/useAgents", () => ({ useAgents: () => ({ refresh, notice: ref(undefined) }) }));
jest.mock("../../../sandbox/live/fleetAcross", () => ({ refreshAcross: jest.fn() }));
jest.mock("../../../sandbox/session/sandboxSession", () => ({ useSandboxSession: () => ({ presentedEmail: me }) }));

const { default: AgentReactions } = await import("./AgentReactions.vue");

let app: App | undefined;
// The instance a host holds: `open` is the whole of what one can ask of this component.
const strip = ref<{ open: (from: HTMLElement) => void } | null>(null);

const mount = (reactions?: readonly AgentReaction[], dense = false): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(AgentReactions, { ref: strip, agentId: `a1`, dense, ...(reactions === undefined ? {} : { reactions }) }) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(el);
    return el;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    reacted.mockClear();
    refresh.mockClear();
    me.value = `ada@example.com`;
});

// The chip is a button whose accessible name carries the same line the hover prints.
const chips = (el: HTMLElement): HTMLButtonElement[] =>
    [...el.querySelectorAll(`button`)].filter((button) => /\d$/.test(button.textContent?.trim() ?? ``));

it(`names everyone behind a mark, and says which one is yours`, () => {
    const el = mount([
        {
            emoji: `👍`,
            by: [
                { email: `bob@example.com`, name: `Bob`, at: 1 },
                { email: `ada@example.com`, name: `Ada`, at: 2 },
            ],
        },
        { emoji: `🎉`, by: [{ email: `bob@example.com`, name: `Bob`, at: 3 }] },
    ]);
    const [first, second] = chips(el);
    expect(first?.textContent?.replace(/\s+/g, ``)).toBe(`👍2`);
    expect(first?.getAttribute(`aria-label`)).toBe(`👍 from Bob, you`);
    expect(first?.getAttribute(`aria-pressed`)).toBe(`true`);
    expect(second?.getAttribute(`aria-label`)).toBe(`🎉 from Bob`);
    expect(second?.getAttribute(`aria-pressed`)).toBe(`false`);
});

it(`takes a mark back by asking for it off, not by asking for a flip`, async () => {
    const el = mount([{ emoji: `👍`, by: [{ email: `ada@example.com`, name: `Ada`, at: 1 }] }]);
    chips(el)[0]?.click();
    await nextTick();
    expect(reacted).toHaveBeenCalledWith(`a1`, `👍`, false, undefined);
    // The card is repainted from the daemon's answer rather than from an optimistic guess about it.
    expect(refresh).toHaveBeenCalledTimes(1);
});

it(`adds somebody else's mark rather than removing it`, async () => {
    const el = mount([{ emoji: `👍`, by: [{ email: `bob@example.com`, name: `Bob`, at: 1 }] }]);
    chips(el)[0]?.click();
    await nextTick();
    expect(reacted).toHaveBeenCalledWith(`a1`, `👍`, true, undefined);
});

// The quick answers are how a page gets a first mark on a card; one already worn is a chip, and drawing both would
// offer the same press twice.
it(`offers both quick answers on a page, and drops the one already worn`, () => {
    const answers = (el: HTMLElement): string[] =>
        [...el.querySelectorAll(`button`)].flatMap((button) => {
            const label = button.getAttribute(`aria-label`) ?? ``;
            return label.startsWith(`React with `) ? [label.slice(`React with `.length)] : [];
        });

    expect(answers(mount())).toEqual([...QUICK_EMOJI]);
    app?.unmount();
    document.body.innerHTML = ``;

    expect(answers(mount([{ emoji: `👍`, by: [{ email: `bob@example.com`, at: 1 }] }]))).toEqual([`👎`]);
});

// A CARD NOBODY HAS MARKED DRAWS NOTHING. Not an empty box, which still takes the gap of the row it sits in, and not
// a control holding a seat for itself, which pushed that row onto a second line for good — on every card, for a
// press most of them never receive.
it(`draws nothing at all on an unmarked card`, () => {
    const el = mount(undefined, true);
    expect(el.querySelector(`div`)).toBeNull();
    expect(el.querySelectorAll(`button`)).toHaveLength(0);
});

// Which is why the press that adds one is the host's: the card draws it up in its own hover-action row and opens the
// picker through this, so marks and the press that makes one need not share a row.
it(`opens its picker from a button the host owns, on a card drawing no controls of its own`, async () => {
    const el = mount(undefined, true);
    expect(el.querySelector(`[data-picker]`)).toBeNull();

    strip.value!.open(document.body);
    await nextTick();
    const grid = el.querySelector(`[data-picker]`)!;
    expect(grid.querySelectorAll(`button`).length).toBe(PICKER_EMOJI.length);

    // Found by reading the labels rather than by an attribute selector: jsdom's selector engine will not match an
    // astral character in one.
    [...grid.querySelectorAll(`button`)].find((button) => button.getAttribute(`aria-label`) === `🎉`)!.click();
    await nextTick();
    expect(reacted).toHaveBeenCalledWith(`a1`, `🎉`, true, undefined);
    // Closed before the answer lands, or the panel covers the very chip the press just made.
    expect(el.querySelector(`[data-picker]`)).toBeNull();
});

// On the card a mark is one more counted stat, so it wears the row's own type rather than the kit's pill, which at
// this size would be the loudest thing on a card about the work.
it(`draws a card's marks as stats and a page's as chips`, () => {
    const marked = [{ emoji: `👍`, by: [{ email: `ada@example.com`, name: `Ada`, at: 1 }] }];
    expect(chips(mount(marked, true))[0]?.className).not.toContain(`ui-chip`);
    app?.unmount();
    document.body.innerHTML = ``;
    expect(chips(mount(marked))[0]?.className).toContain(`ui-chip-on`);
});

it(`claims nothing for a reader whose session has not settled yet`, () => {
    me.value = undefined;
    const el = mount([{ emoji: `👍`, by: [{ email: `ada@example.com`, name: `Ada`, at: 1 }] }]);
    expect(chips(el)[0]?.getAttribute(`aria-pressed`)).toBe(`false`);
    expect(chips(el)[0]?.getAttribute(`aria-label`)).toBe(`👍 from Ada`);
});
