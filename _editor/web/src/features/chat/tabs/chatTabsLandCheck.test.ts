// A CARD SAYS WHAT CHECKED ITS WORK, NOW THAT NOTHING DOES INSIDE THE TURN. Its land's verdict on the main line, and
// what its last turn showed of its own work, drawn on the rail's row and the board's card from the one read their list
// makes, never as the corner's word: the corner is the standing's (chatTabsStanding.test.ts).
import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import type { AgentSummary, MainlineRun, MainlineStatus } from "@intentic/sandbox-contract";
import { VueQueryPlugin } from "@tanstack/vue-query";
import { type App, createApp, defineComponent, h, nextTick } from "vue";
import { setAgents } from "../../agents/fleet/useAgents-registry";
import type { FleetAgent } from "../../agents/fleet/useAgents-fleet";
import { provideMainline } from "../../agents/mainline/useMainline";
import { openAgentConversation } from "../panel/useChat-reveal";
import { queryClient } from "../../../lib/queryPersistence";
import { rpcKey } from "../../../lib/queryKeys";
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

// Read and settled, so no corner word competes: one agent whose land broke main and never checked or looked at its own
// work, one whose last check failed, one whose last check passed.
const SEEDS = {
    breaker: {
        id: `breaker`,
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

// The breaker's land turned web red; the sandbox handed the three failures to a fresh conversation.
const RED: MainlineRun = {
    project: `web`,
    command: `pnpm verify`,
    status: `red`,
    startedAt: 1_000,
    at: 1_200,
    lands: [{ conversationId: `breaker`, title: `Draft the release notes`, at: 900 }],
    failures: [`a.test.ts › one`, `b.test.ts › two`, `c.test.ts › three`],
    failureCount: 3,
    attempt: 1,
    suspects: [`breaker`],
    routing: { kind: `fix-up`, conversationId: `land-fix-web-abc`, at: 1_300 },
};
const MAINLINE: MainlineStatus = { projects: [{ project: `web`, queued: [], last: RED, redSince: RED.at }], recent: [RED] };

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
    // The one read the list makes, answered before it mounts (the test sandbox is never reachable, so it is never fetched).
    queryClient.setQueryData(rpcKey(`workspace.mainline`), MAINLINE);
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    queryClient.clear();
    document.body.replaceChildren();
});

const rowOf = (el: HTMLElement, key: Seed): HTMLElement => el.querySelector<HTMLElement>(`[data-chat-tab="${SEEDS[key].id}"]`)!;
const markOf = (row: HTMLElement, check: string): HTMLElement | null => row.querySelector<HTMLElement>(`[data-check="${check}"]`);

it(`says a card's land broke main, how badly and who has it, in words on its own line`, async () => {
    const row = rowOf(await mountRail(), `breaker`);
    const land = markOf(row, `land`)!;
    expect(land.textContent?.trim()).toBe(`Broke 3 · fix-up`);
    expect(land.getAttribute(`aria-label`)).toBe(`Broke 3 · fix-up`);
    expect(land.querySelector(`[data-icon="exclamation-circle"]`)).not.toBeNull();
    // Not the corner: that stays the standing's, and a read, settled card has none to say.
    expect(row.querySelector(`span.ui-status-pill`)).toBeNull();
});

it(`badges what the last turn showed of its own work`, async () => {
    const el = await mountRail();
    const breaker = rowOf(el, `breaker`);
    expect(markOf(breaker, `verification`)?.getAttribute(`aria-label`)).toBe(`Unverified`);
    expect(markOf(breaker, `verification`)?.querySelector(`[data-icon="exclamation-triangle"]`)).not.toBeNull();
    expect(markOf(breaker, `unviewed`)?.getAttribute(`aria-label`)).toBe(`Changed 2 interface files without looking`);
    expect(markOf(breaker, `unviewed`)?.querySelector(`[data-icon="eye-slash"]`)).not.toBeNull();

    expect(markOf(rowOf(el, `failing`), `verification`)?.getAttribute(`aria-label`)).toBe(`Last check failed`);
    expect(markOf(rowOf(el, `proven`), `verification`)?.getAttribute(`aria-label`)).toBe(`Verified`);
    // Neither of those two landed anything main's check measured.
    expect(markOf(rowOf(el, `failing`), `land`)).toBeNull();
    expect(markOf(rowOf(el, `proven`), `land`)).toBeNull();
});

// At the column's foot, not over the header that decides what it lists: the top of the rail is the rail's own.
it(`carries the main line itself at the rail's foot`, async () => {
    const el = await mountRail();
    const dock = el.querySelector<HTMLElement>(`[role="region"][aria-label="Main line status"]`)!;
    expect(dock.querySelector(`[data-item="red"]`)?.textContent).toContain(`3 failures`);
    expect(dock.querySelector(`[data-item="red"]`)?.textContent).toContain(`web red since`);
    expect(dock.textContent).toContain(`A fresh conversation is fixing it`);
    expect(rowOf(el, `breaker`).compareDocumentPosition(dock) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
});

// The board spells it out and can open the conversation the red was handed to, which the rail's row (a button) cannot.
it(`spells the same reading out on the board's card, with the fix-up one press away`, async () => {
    const card: FleetAgent = { ...summary(`breaker`), open: false, unread: false, unsent: false };
    const el = document.createElement(`div`);
    document.body.append(el);
    const board = defineComponent({
        setup: () => {
            provideMainline();
            return () => h(AgentCard, { agent: card });
        },
    });
    app = createApp({ render: () => h(board) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.use(router);
    app.mount(el);
    await settle();

    const land = el.querySelector<HTMLElement>(`[data-check="land"]`)!;
    expect(land.textContent).toContain(`Broke 3 · fix-up`);
    expect(land.querySelector(`button[aria-label="Open the conversation working on it"]`)).not.toBeNull();
    expect(el.querySelector(`[data-check="verification"]`)?.textContent).toContain(`Unverified`);
    expect(el.querySelector(`[data-check="unviewed"]`)?.textContent).toContain(`Changed 2 interface files without looking`);
});
