// ONE STANDING, ONE READING, ON BOTH SURFACES THAT DRAW IT: the rail's rows (the popped-out chat) and the board's
// cards. Regression: the rail spent its corner on a status glyph — one triangle for "Usage limit", "Didn't start" and
// "Conflict" alike — and tucked the word itself a line lower, in a tone of its own, so the same stopped agent read one
// way on /agents and another in the chat window.
import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import type { AgentSummary } from "@intentic/sandbox-contract";
import { VueQueryPlugin } from "@tanstack/vue-query";
import { type App, createApp, h, nextTick } from "vue";
import { agentStatusMeta } from "../../agents/fleet/agentStatus";
import { setAgents } from "../../agents/fleet/useAgents-registry";
import type { FleetAgent } from "../../agents/fleet/useAgents-fleet";
import { openAgentConversation } from "../panel/useChat-reveal";
import { queryClient } from "../../../lib/queryPersistence";
import { router } from "../../../router";
import ChatTabList from "./ChatTabList.vue";
import { IconStub } from "@intentic/ui/testing";

// The board's card reads browser globals through its import chain, so it's pulled in once the environment is up.
const { default: AgentCard } = await import("../../agents/board/cards/AgentCard.vue");

(() => {
    globalThis.Element.prototype.scrollIntoView = function scrollIntoView(): void {};
})();

const NO_ATTENTION: AgentSummary[`attention`] = {
    plan: false,
    question: false,
    permission: false,
    capability: false,
    credential: false,
    conflict: false,
};

// One agent per standing worth a corner: a turn the user stopped, a turn the provider refused, work that carried on
// since the reader last looked, and work they have read. `seenAt` against `updatedAt` is what makes a card unread
// (useAgents-fleet), so each fixture states both rather than leaving the fleet to decide.
const SEEDS = {
    halted: { id: `halted`, title: `verify-core job`, status: `stopped`, updatedAt: 2_000, seenAt: 2_000 },
    spent: { id: `spent`, title: `intentic i18n`, status: `error`, failureCode: `rate_limit`, updatedAt: 2_000, seenAt: 2_000 },
    worked: { id: `worked`, title: `mobile UX audit`, status: `landed`, updatedAt: 2_000, seenAt: 1_000 },
    read: { id: `read`, title: `the landed refactor`, status: `landed`, updatedAt: 1_000, seenAt: 2_000 },
} as const satisfies Record<string, Pick<AgentSummary, "id" | "title" | "status" | "updatedAt" | "seenAt" | "failureCode">>;

type Standing = keyof typeof SEEDS;
const STANDINGS = Object.keys(SEEDS) as Standing[];

const summary = (key: Standing): AgentSummary => ({ ...SEEDS[key], provider: `claude`, harness: `native`, attention: NO_ATTENTION });

// The same agent as the board's card takes it; `unread` is the fleet's own derivation, stated here.
const card = (key: Standing): FleetAgent => ({
    ...summary(key),
    open: false,
    unread: SEEDS[key].updatedAt > SEEDS[key].seenAt,
    unsent: false,
});

let app: App | undefined;

const settle = async (): Promise<void> => {
    await nextTick();
    await nextTick();
    await nextTick();
};

// The rail as the floating window hosts it, holding every seeded agent's chat.
const mountRail = async (): Promise<HTMLElement> => {
    setAgents(STANDINGS.map(summary), 100);
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(ChatTabList) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.use(router);
    app.use(VueQueryPlugin, { queryClient });
    app.mount(el);
    for (const key of STANDINGS) {
        openAgentConversation({ id: SEEDS[key].id, provider: `claude`, harness: `native` });
    }
    await settle();
    return el;
};

// One board card, read and torn down inside the call: several of them in a test would otherwise outlive it.
const readCard = <T>(key: Standing, read: (el: HTMLElement) => T): T => {
    const el = document.createElement(`div`);
    document.body.append(el);
    const one = createApp({ render: () => h(AgentCard, { agent: card(key) }) });
    one.component(`Icon`, IconStub);
    one.directive(`tooltip`, {});
    one.use(router);
    one.mount(el);
    try {
        return read(el);
    } finally {
        one.unmount();
        el.remove();
    }
};

beforeEach(async () => {
    localStorage.clear(); // the tab snapshot persists per sandbox; each test starts from one fresh chat
    resetSandboxScope();
    await nextTick();
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.replaceChildren();
});

const rowOf = (el: HTMLElement, key: Standing): HTMLElement => el.querySelector<HTMLElement>(`[data-chat-tab="${SEEDS[key].id}"]`)!;

// What the corner says in words, and how it's tinted. Geometry (`ui-status-pill`, the type scale) is each surface's
// own business; the word and the ink are not.
const wordOf = (el: HTMLElement): { label: string; tone: string } | undefined => {
    const found = el.querySelector<HTMLElement>(`span.ui-status-pill`);
    if (found === null) {
        return undefined;
    }
    return {
        label: found.textContent?.trim() ?? ``,
        tone: [...found.classList]
            .filter((name) => name.startsWith(`bg-`) || name.startsWith(`text-`))
            .toSorted()
            .join(` `),
    };
};

// The resting glyph for a standing, looked up through the projection rather than transcribed, so a changed glyph
// changes this test's expectation with it.
const glyphOf = (el: HTMLElement, key: Standing): string | undefined => {
    const meta = agentStatusMeta(SEEDS[key].status);
    return el.querySelector(`[data-icon="${meta.icon}"][aria-label="${meta.label}"]`) === null ? undefined : meta.icon;
};

// A row's whole corner: the word if it has one, the glyph if it doesn't — and the point is that it is never both.
const cornerOf = (el: HTMLElement, key: Standing): { word: string | undefined; glyph: string | undefined } => ({
    word: wordOf(el)?.label,
    glyph: glyphOf(el, key),
});

// One reading per standing, keyed so a single expectation covers the whole set rather than four near-identical tests.
const perStanding = <T>(read: (key: Standing) => T): Record<Standing, T> =>
    Object.fromEntries(STANDINGS.map((key) => [key, read(key)])) as Record<Standing, T>;

it(`gives each row's corner one reading: the word when there is one, the glyph when there is not`, async () => {
    const el = await mountRail();
    expect(perStanding((key) => cornerOf(rowOf(el, key), key))).toEqual({
        // A stopped turn and a spent allowance name themselves; the triangle that stood here said neither.
        halted: { word: `Stopped`, glyph: undefined },
        spent: { word: `Usage limit`, glyph: undefined },
        // Nothing is owed, but the card worked since it was last opened, which is the corner's second-rank word.
        worked: { word: `Updated`, glyph: undefined },
        // Nothing to say: the corner goes back to the resting glyph, as it always was.
        read: { word: undefined, glyph: agentStatusMeta(`landed`).icon },
    });
});

it(`reads every standing exactly as the board's own card reads it, word and tone`, async () => {
    const el = await mountRail();
    const rail = perStanding((key) => wordOf(rowOf(el, key)));
    app?.unmount();
    app = undefined;

    const board = perStanding((key) => readCard(key, wordOf));

    expect(rail).toEqual(board);
    // Stated, not merely matched: a spent allowance is the quiet one (it needs a person, but nothing is wrong and
    // nothing is lost), and the two surfaces used to disagree about exactly that.
    expect(rail.halted).toEqual({ label: `Stopped`, tone: expect.stringContaining(`text-warning`) });
    expect(rail.spent).toEqual({ label: `Usage limit`, tone: expect.stringContaining(`text-muted`) });
    expect(rail.worked).toEqual({ label: `Updated`, tone: expect.stringContaining(`text-link`) });
});
