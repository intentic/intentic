// A CARD STAMPS WHAT CHECKED ITS WORK: one badge per check that ran, in the rail's row and the board's card alike, left of
// the standing, which keeps the corner's right edge. Nothing is spelled out on the card: every stamp's words are its
// card's (CardStamps), and its accessible name.
import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import { VueQueryPlugin } from "@tanstack/vue-query";
import { type App, createApp, h, nextTick } from "vue";
import { setAgents } from "../../../../models/fleet/useAgents-registry";
import type { FleetAgent } from "../../../../models/fleet/useAgents-fleet";
import { openAgentConversation } from "../../../../models/conversations/panel/useChat-reveal";
import { queryClient } from "../../../../lib/queryPersistence";
import { router } from "../../../../router/index";
import ChatTabList from "../ChatTabList.vue";
import { IconStub } from "@intentic/ui/testing";

// The board's card reads browser globals through its import chain, so it's pulled in once the environment is up.
const { default: AgentCard } = await import("../../../agents/board/cards/AgentCard.vue");

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
const stampsIn = (root: HTMLElement): HTMLElement | null => root.querySelector<HTMLElement>(`[data-stamps]`);
// Each stamp drawn, as `kind:outcome` and the mark beside its badge.
const drawn = (root: HTMLElement): string[] =>
    [...root.querySelectorAll<HTMLElement>(`[data-stamp]`)].map(
        (stamp) => `${stamp.dataset[`stampKind`]}:${stamp.dataset[`stampOutcome`]}${stamp.textContent?.trim() ? ` ${stamp.textContent.trim()}` : ``}`,
    );
// The stamps' accessible name, one line each after the heading.
const readings = (stamps: HTMLElement | null): string[] => stamps?.getAttribute(`aria-label`)?.split(`\n`).slice(1) ?? [];

// A dashed variant of a passing glyph was a difference nobody could read: work nothing checked has no stamp at all.
it(`stamps nothing on a row whose last turn proved nothing, and keeps its standing glyph`, async () => {
    const row = rowOf(await mountRail(), `unproven`);
    expect(stampsIn(row)).toBeNull();
    expect(row.querySelector(`[data-icon="check-circle"]`)).not.toBeNull();
});

it(`stamps the agent's own check on a rail row`, async () => {
    const el = await mountRail();
    const failing = stampsIn(rowOf(el, `failing`))!;
    expect(drawn(failing)).toEqual([`self:failed !`]);
    expect(readings(failing)).toEqual([`Self-check: its last run failed`]);
    expect(failing.closest(`[data-corner]`)).not.toBeNull();

    const proven = stampsIn(rowOf(el, `proven`))!;
    expect(drawn(proven)).toEqual([`self:passed`]);
    // The standing keeps its glyph beside the stamps: landed is not a verdict on the work.
    expect(rowOf(el, `proven`).querySelector(`[data-icon="check-circle"]`)).not.toBeNull();
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

it(`stamps a board card's own failed check in its corner, with no words line in the body`, async () => {
    const el = await mountCard(cardOf(`failing`));
    const stamps = stampsIn(el)!;
    expect(drawn(stamps)).toEqual([`self:failed !`]);
    // A mark, never a press: a click on it is the card's.
    expect(stamps.tagName).toBe(`SPAN`);
    expect(el.textContent).not.toContain(`signup.spec.ts`);
    expect(el.querySelector(`[data-work-assurance]`)).toBeNull();
});

it(`keeps a landed card's glyph as its standing, beside a passing stamp`, async () => {
    const el = await mountCard(cardOf(`proven`));
    expect(drawn(stampsIn(el)!)).toEqual([`self:passed`]);
    expect(el.querySelector(`[data-icon="check-circle"]`)).not.toBeNull();
    // Left of the standing, so the standing keeps the card's right edge.
    const corner = stampsIn(el)!.parentElement!;
    expect(corner.lastElementChild?.getAttribute(`data-icon`)).toBe(`check-circle`);
});

it(`stamps nothing on a card that landed without proving anything`, async () => {
    const el = await mountCard({ ...cardOf(`proven`), proof: { at: 1_900, verification: `unproven` } });
    expect(stampsIn(el)).toBeNull();
});

// "Updated" is the corner's word for a card whose turn just ended, which is exactly when its stamps are news.
it(`keeps the stamps beside an unread card's chip rather than under it`, async () => {
    const el = await mountCard({ ...cardOf(`proven`), unread: true, seenAt: 1_000 });
    expect(el.querySelector(`span.ui-status-pill`)).not.toBeNull();
    expect(drawn(stampsIn(el)!)).toEqual([`self:passed`]);
});

// The stamps are about the work as it was, so a turn redoing it hides them.
it(`stamps nothing while a turn is redoing the work`, async () => {
    const el = await mountCard({ ...cardOf(`proven`), status: `running` });
    expect(stampsIn(el)).toBeNull();
});

// A fresh session's check is a stamp of its own kind beside the agent's own, in one order on every card.
it(`stamps each kind of check a fresh session ran, after the agent's own`, async () => {
    const origin = cardOf(`proven`);
    const reviewer: AgentSummary = {
        id: `reviewer`,
        title: `Code review: Soft-delete the users table`,
        status: `idle`,
        updatedAt: 2_000,
        seenAt: 2_000,
        provider: `claude`,
        harness: `native`,
        attention: NO_ATTENTION,
        turns: 1,
        fresh: { of: origin.id, kind: `review`, at: 1_950 },
        review: { at: 1_990, source: `claude`, findings: 3, open: 2 },
    };
    setAgents([summary(`proven`), reviewer], 100);
    await settle();
    const el = await mountCard(origin);
    expect(drawn(stampsIn(el)!)).toEqual([`self:passed`, `review:findings 2`]);
    expect(readings(stampsIn(el))).toEqual([`Self-check: passed after its last edit`, `Code review: 2 of 3 findings open`]);
});
