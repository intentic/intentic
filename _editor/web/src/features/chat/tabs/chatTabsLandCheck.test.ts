// A CARD SAYS WHAT CHECKED ITS WORK, NOW THAT NOTHING DOES INSIDE THE TURN. Its land's verdict on the main line, and
// what its last turn showed of its own work, drawn as one seal on the rail's row and the board's card from the one read
// their list makes, never as the corner's word: the word is the standing's (chatTabsStanding.test.ts). Only a red is
// spelled out on the card; every other reading is the seal's hover.
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
const sealOf = (root: HTMLElement): HTMLElement | null => root.querySelector<HTMLElement>(`[data-seal]`);
// The seal's hover, one reading per line; its accessible name is the same words.
const readings = (seal: HTMLElement | null): string[] => seal?.querySelector(`svg`)?.getAttribute(`aria-label`)?.split(`\n`) ?? [];

it(`seals a card whose land broke main in red, and says how badly and who has it in words beside the seal`, async () => {
    const row = rowOf(await mountRail(), `breaker`);
    const seal = sealOf(row)!;
    expect(seal.dataset[`sealKind`]).toBe(`broke`);
    expect(seal.textContent?.trim()).toBe(`Broke 3 · fixing`);
    expect(readings(seal)).toEqual([
        `Main's check of web: Broke 3 · fixing`,
        `Its own check: none since the last edit`,
        `Changed 2 interface files without looking`,
    ]);
    // Not the corner: that stays the standing's, and a read, settled card has none to say.
    expect(row.querySelector(`span.ui-status-pill`)).toBeNull();
});

it(`draws what the last turn showed of its own work as the seal alone, its words in the hover`, async () => {
    const el = await mountRail();
    const failing = sealOf(rowOf(el, `failing`))!;
    expect(failing.dataset[`sealKind`]).toBe(`broke`);
    expect(readings(failing)).toEqual([`Its own check: pnpm -C web e2e signup.spec.ts failed`]);
    // A red of its own turn's, not main's: nobody else has it, so there is nobody to name beside the glyph.
    expect(failing.textContent?.trim()).toBe(``);

    const proven = sealOf(rowOf(el, `proven`))!;
    expect(proven.dataset[`sealKind`]).toBe(`closed`);
    expect(readings(proven)).toEqual([`Its own check: pnpm -C api test passed`]);
    // One glyph per row, whatever it has to say.
    expect(rowOf(el, `breaker`).querySelectorAll(`[data-seal]`)).toHaveLength(1);
    expect(el.querySelector(`[data-check]`)).toBeNull();
});

// The sandbox-wide main line is the board's alone: the chat column keeps each row's own mark and draws no bar of it.
it(`leaves the main line's bar to the board`, async () => {
    const el = await mountRail();
    expect(el.querySelector(`[role="region"]`)).toBeNull();
    expect(el.textContent).not.toContain(`web failing`);
});

const mountCard = async (agent: FleetAgent): Promise<HTMLElement> => {
    const el = document.createElement(`div`);
    document.body.append(el);
    const board = defineComponent({
        setup: () => {
            provideMainline();
            return () => h(AgentCard, { agent });
        },
    });
    app = createApp({ render: () => h(board) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.use(router);
    app.mount(el);
    await settle();
    return el;
};

const cardOf = (key: Seed): FleetAgent => ({ ...summary(key), open: false, unread: false, unsent: false });

// The board spells a red out and can open the conversation it was handed to, which the rail's row (a button) cannot.
it(`spells only the red out on the board's card, with the fix-up one press away`, async () => {
    const el = await mountCard(cardOf(`breaker`));
    const land = el.querySelector<HTMLElement>(`[data-check="land"]`)!;
    expect(land.textContent).toContain(`Broke 3 · fixing`);
    expect(land.querySelector(`button[aria-label="Open the conversation working on it"]`)).not.toBeNull();
    // Unverified and the unseen interface are no red: the seal's hover says them, and the body says nothing.
    expect(el.querySelector(`[data-check="verification"]`)).toBeNull();
    expect(el.textContent).not.toContain(`Unverified`);
    expect(el.textContent).not.toContain(`interface files`);
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

// "Updated" is the corner's word for a card that just landed, which is exactly when its check is being answered.
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
