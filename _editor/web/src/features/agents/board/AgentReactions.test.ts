// @vitest-environment jsdom
// jsdom: the subject is what the strip draws and what a press sends, neither of which is readable off the code.
// What it pins: the names ride with the chip (the whole point of a reaction over a private bookmark), and a press
// states an intent rather than flipping whatever the daemon happens to hold.
import type { AgentReaction } from "@intentic/sandbox-contract";
import { afterEach, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";

const reacted = vi.fn(async () => ({}) as never);
const refresh = vi.fn(async () => {});
const me = ref<string | undefined>(`ada@example.com`);

vi.mock("@intentic/ui", async () => {
    const vue = await import("vue");
    return {
        ui: { iconButton: () => ``, inputSm: () => `` },
        Button: vue.defineComponent({ name: `Button`, render: () => null }),
        // The picker's body is the overlay's slot; this mount is about the row, not what opening it draws.
        ResponsiveOverlay: vue.defineComponent({ name: `ResponsiveOverlay`, render: () => null }),
        useDevice: () => ({ mobile: vue.ref(false) }),
    };
});
vi.mock("../fleet/agentActions", () => ({ reactToAgent: reacted }));
vi.mock("../fleet/useAgents", () => ({ useAgents: () => ({ refresh, notice: ref(undefined) }) }));
vi.mock("../../sandbox/live/fleetAcross", () => ({ refreshAcross: vi.fn() }));
vi.mock("../../sandbox/client/sandboxSession", () => ({ useSandboxSession: () => ({ presentedEmail: me }) }));

const { default: AgentReactions } = await import("./AgentReactions.vue");

let app: App | undefined;

const mount = (reactions?: readonly AgentReaction[]): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(AgentReactions, { agentId: `a1`, ...(reactions === undefined ? {} : { reactions }) }) });
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
const chips = (el: HTMLElement): HTMLButtonElement[] => [...el.querySelectorAll(`button`)].filter((button) => /\d$/.test(button.textContent?.trim() ?? ``));

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

// The quick answers are how a card with nothing on it gets its first mark; a mark already there is a chip, and
// drawing both would put the same emoji on the row twice.
it(`offers both quick answers on an unmarked card, and drops the one already showing`, () => {
    const bare = mount();
    expect(bare.textContent).toContain(`👍`);
    expect(bare.textContent).toContain(`👎`);
    app?.unmount();
    document.body.innerHTML = ``;

    const marked = mount([{ emoji: `👍`, by: [{ email: `bob@example.com`, at: 1 }] }]);
    expect(marked.textContent?.match(/👍/g)).toHaveLength(1);
    expect(marked.textContent).toContain(`👎`);
});

it(`claims nothing for a reader whose session has not settled yet`, () => {
    me.value = undefined;
    const el = mount([{ emoji: `👍`, by: [{ email: `ada@example.com`, name: `Ada`, at: 1 }] }]);
    expect(chips(el)[0]?.getAttribute(`aria-pressed`)).toBe(`false`);
    expect(chips(el)[0]?.getAttribute(`aria-label`)).toBe(`👍 from Ada`);
});
