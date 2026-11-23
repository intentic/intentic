// jsdom: the subject is what each fit of the card draws (boardGrid.ts `CardFit`), which only a render can show.
// Pins what a squeezed board keeps of a card: compact and mini keep the whole title and the standing's word, compact keeps
// the one press the card asks for, and a tile keeps the ring, its initials and a dot for the reader, the title in its name.
import "@intentic/testing/dom";
import { providerLabel } from "@intentic/sandbox-contract/models/agent-catalog";
import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import { IconStub } from "@intentic/ui/testing";
import { type App, createApp, h } from "vue";
import type { FleetAgent } from "../../../../models/fleet/useAgents-fleet";
import type { CardFit } from "../view/boardGrid";

// A reader the daemon takes every press from, so the card offers what an owner sees.
jest.mock("../../../../client/sandbox/access/useAccess", () => ({
    useAccess: () => ({ known: { value: true }, tier: { value: `owner` }, can: () => true, refusal: () => undefined, holds: () => true }),
}));

const { default: AgentCard } = await import("./AgentCard.vue");
const { router } = await import("../../../../router/index");

const NO_ATTENTION: AgentSummary[`attention`] = {
    plan: false,
    question: false,
    permission: false,
    capability: false,
    credential: false,
    conflict: false,
};

// Finished work on its branch with auto-land off, the card that asks for Land now; a long title, so a cut would show.
const TITLE = `Fix the flaky signup end-to-end test on the checkout page`;
const ready = (): FleetAgent => ({
    id: `a1`,
    status: `ready`,
    provider: `claude`,
    harness: `native`,
    branch: `agent/a1`,
    title: TITLE,
    updatedAt: 1,
    attention: NO_ATTENTION,
    open: false,
    unread: false,
    unsent: false,
});
// A turn waiting on a permission: the card's corner says so in a word.
const asking = (): FleetAgent => ({ ...ready(), status: `awaiting`, attention: { ...NO_ATTENTION, permission: true } });

const apps: App[] = [];
const mount = (agent: FleetAgent, fit: CardFit): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.append(el);
    const app = createApp({ render: () => h(AgentCard, { agent, fit }) });
    apps.push(app);
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.use(router);
    app.mount(el);
    return el;
};

afterEach(() => {
    for (const app of apps.splice(0)) {
        app.unmount();
    }
    document.body.innerHTML = ``;
});

const titleButton = (el: HTMLElement): HTMLButtonElement | undefined =>
    [...el.querySelectorAll(`button`)].find((button) => button.textContent?.trim() === TITLE);
const landButton = (el: HTMLElement): HTMLButtonElement | undefined =>
    [...el.querySelectorAll(`button`)].find((button) => /Land now|Landing/.test(button.textContent ?? ``));

it(`keeps the whole title on a compact card, clamped to three lines rather than cut to a few letters`, () => {
    const button = titleButton(mount(ready(), `compact`));
    expect(button).not.toBeUndefined();
    expect(button?.className).toContain(`line-clamp-3`);
});

it(`keeps the standing's word and the land press on a compact card, and drops the facts line`, () => {
    const full = mount(asking(), `full`);
    const compact = mount(asking(), `compact`);
    expect(compact.textContent).toContain(full.querySelector(`.ui-status-pill`)?.textContent?.trim() ?? `missing`);
    expect(full.textContent).toContain(providerLabel(`claude`));
    expect(compact.textContent).not.toContain(providerLabel(`claude`));
    expect(landButton(mount(ready(), `compact`))).not.toBeUndefined();
});

it(`keeps the title and the standing's word on a mini card, and leaves its presses to its menu`, () => {
    const card = mount(asking(), `mini`);
    expect(titleButton(card)).not.toBeUndefined();
    expect(card.querySelector(`.ui-status-pill`)).not.toBeNull();
    expect(landButton(mount(ready(), `mini`))).toBeUndefined();
});

it(`draws a tile card as its ring, named for the agent, with the title's initials and a dot while it asks`, () => {
    const card = mount(asking(), `tile`);
    expect(titleButton(card)).toBeUndefined();
    expect(card.querySelector(`button[aria-label*="${TITLE}"]`)).not.toBeNull();
    expect(card.querySelector(`[data-initials]`)?.textContent).toBe(`FT`);
    expect(card.querySelector(`[data-tile-ask]`)).not.toBeNull();
    expect(mount(ready(), `tile`).querySelector(`[data-tile-ask]`)).toBeNull();
});
