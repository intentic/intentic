// A CARD SAYS WHAT ITS LAST TURN SHOWED OF ITS OWN WORK, NOW THAT NOTHING CHECKS IT FOR THE CONVERSATION: one seal on the
// rail's row and the board's card alike, never the corner's word, which is the standing's (chatTabsStanding.test.ts).
// Nothing is spelled out on the card, a failure included: every reading is the seal's hover.
import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import type { AgentSummary } from "@intentic/sandbox-contract";
import { VueQueryPlugin } from "@tanstack/vue-query";
import { type App, createApp, h, nextTick } from "vue";
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

// Read and settled, so no corner word competes: one agent that never checked or looked at its own work, one whose last
// check failed, one whose last check passed.
const SEEDS = {
    unproven: {
        id: `unproven`,
        title: `Draft the release notes`,
        status: `landed`,
        updatedAt: 2_000,
        seenAt: 2_000,
        proof: { at: 1_900, verification: `unproven`, unviewed: 2 },
    },
    failing: {
        id: `failing`,
        title: `Chase the flaky signup test`,
        status: `idle`,
        updatedAt: 2_000,
        seenAt: 2_000,
        proof: { at: 1_900, verification: `failing`, check: `pnpm -C web e2e signup.spec.ts` },
    },
    proven: {
        id: `proven`,
        title: `Soft-delete the users table`,
        status: `landed`,
        updatedAt: 2_000,
        seenAt: 2_000,
        proof: { at: 1_900, verification: `verified`, check: `pnpm -C api test` },
    },
} as const satisfies Record<string, Pick<AgentSummary, "id" | "title" | "status" | "updatedAt" | "seenAt" | "proof">>;

type Seed = keyof typeof SEEDS;
const SEEDED = Object.keys(SEEDS) as Seed[];

const summary = (key: Seed): AgentSummary => ({ ...SEEDS[key], provider: `claude`, harness: `native`, attention: NO_ATTENTION });

let app: App | undefined;

const settle = async (): Promise<void> => {
    await nextTick();
    await nextTick();
};

const mountRail = async (): Promise<HTMLElement> => {
    setAgents(SEEDED.map(summary), 100);
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(ChatTabList) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.directive(`middleclick`, {});
    app.use(router);
    app.use(VueQueryPlugin, { queryClient });
    app.mount(el);
    for (const key of SEEDED) {
        openAgentConversation({ id: SEEDS[key].id, provider: `claude`, harness: `native` });
    }
    await settle();
    return el;
};

beforeEach(async () => {
    localStorage.clear(); // the tab snapshot persists per sandbox; each test starts from one fresh chat
    resetSandboxScope();
    await nextTick();
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    queryClient.clear();
    document.body.replaceChildren();
});

const rowOf = (el: HTMLElement, key: Seed): HTMLElement => el.querySelector<HTMLElement>(`[data-chat-tab="${SEEDS[key].id}"]`)!;
const sealOf = (root: HTMLElement): HTMLElement | null => root.querySelector<HTMLElement>(`[data-seal]`);
// The seal's hover, one reading per line; its accessible name is the same words.
const readings = (seal: HTMLElement | null): string[] => seal?.querySelector(`svg`)?.getAttribute(`aria-label`)?.split(`\n`) ?? [];

it(`leaves the seal's ring open on a row whose last turn proved nothing, its words in the hover alone`, async () => {
    const row = rowOf(await mountRail(), `unproven`);
    const seal = sealOf(row)!;
    expect(seal.dataset[`sealKind`]).toBe(`open`);
    expect(seal.textContent?.trim()).toBe(``);
    // The row is a button of its own, and the seal is never a press.
    expect(seal.tagName).toBe(`SPAN`);
    expect(readings(seal)).toEqual([`Its own check: none since the last edit`, `Changed 2 interface files without looking`]);
    // Not the corner: that stays the standing's, and a read, settled card has none to say.
    expect(row.querySelector(`span.ui-status-pill`)).toBeNull();
});

it(`draws what the last turn showed of its own work as the seal alone, its words in the hover`, async () => {
    const el = await mountRail();
    const failing = sealOf(rowOf(el, `failing`))!;
    expect(failing.dataset[`sealKind`]).toBe(`broke`);
    expect(readings(failing)).toEqual([`Its own check: pnpm -C web e2e signup.spec.ts failed`]);

    const proven = sealOf(rowOf(el, `proven`))!;
    expect(proven.dataset[`sealKind`]).toBe(`closed`);
    expect(readings(proven)).toEqual([`Its own check: pnpm -C api test passed`]);
    // One glyph per row, whatever it has to say.
    expect(rowOf(el, `unproven`).querySelectorAll(`[data-seal]`)).toHaveLength(1);
    expect(el.querySelector(`[data-check]`)).toBeNull();
});

const mountCard = async (agent: FleetAgent): Promise<HTMLElement> => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(AgentCard, { agent }) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.use(router);
    app.mount(el);
    await settle();
    return el;
};

const cardOf = (key: Seed): FleetAgent => ({ ...summary(key), open: false, unread: false, unsent: false });

// A failure is the seal's to say on the board too: a red glyph whose words are its hover, and no line of the card's.
it(`breaks the seal on a board card whose last check failed, with no words line`, async () => {
    const el = await mountCard(cardOf(`failing`));
    const seal = sealOf(el)!;
    expect([seal.tagName, seal.dataset[`sealKind`]]).toEqual([`SPAN`, `broke`]);
    expect(readings(seal)).toEqual([`Idle`, `Its own check: pnpm -C web e2e signup.spec.ts failed`]);
    expect(el.textContent).not.toContain(`signup.spec.ts`);
});

// A resting glyph says only that nothing is going on; the seal says that and more, so it takes the corner, and its hover
// still leads with the word the glyph wore.
it(`stands the seal in for a landed card's glyph`, async () => {
    const el = await mountCard(cardOf(`proven`));
    const seal = sealOf(el)!;
    expect(seal.dataset[`sealKind`]).toBe(`closed`);
    expect(readings(seal)).toEqual([`Landed`, `Its own check: pnpm -C api test passed`]);
    expect(el.querySelector(`[data-icon="check-circle"]`)).toBeNull();
    expect(el.querySelector(`[data-check]`)).toBeNull();
});

it(`leaves the seal's ring open on a card that landed without proving anything`, async () => {
    const el = await mountCard({ ...cardOf(`proven`), proof: { at: 1_900, verification: `unproven` } });
    expect(sealOf(el)?.dataset[`sealKind`]).toBe(`open`);
    expect(readings(sealOf(el))).toEqual([`Landed`, `Its own check: none since the last edit`]);
});

// "Updated" is the corner's word for a card whose turn just ended, which is exactly when its proof is news.
it(`keeps the seal beside an unread card's chip rather than under it`, async () => {
    const el = await mountCard({ ...cardOf(`proven`), unread: true, seenAt: 1_000 });
    expect(el.querySelector(`span.ui-status-pill`)).not.toBeNull();
    expect(sealOf(el)?.dataset[`sealKind`]).toBe(`closed`);
});

// A status that says something of its own keeps its glyph, and the seal rides beside it.
it(`sets the seal beside a glyph that has something of its own to say`, async () => {
    const el = await mountCard({ ...cardOf(`proven`), status: `ready` });
    expect(el.querySelector(`[data-icon="download"]`)).not.toBeNull();
    expect(readings(sealOf(el))).toEqual([`Its own check: pnpm -C api test passed`]);
});
