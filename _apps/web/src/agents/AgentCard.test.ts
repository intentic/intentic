// @vitest-environment jsdom
//
// jsdom because the subject is what the card actually PUTS ON SCREEN — a press is only what the user sees come
// back, and a stat is only what renders. Landing an agent's work is a round trip to a daemon that has to
// commit, diff and patch-apply before the card can change lane, and for that whole span the only honest report
// is on the control that was pressed. Three properties are pinned here, and none can be read off the code: the
// Land button states its own progress; it states it for ITS action only — the card is equally busy while an
// archive is out, and a Land button spinning through one would be reporting work nobody asked for; and the
// stat row shows a fact the moment the agent has it, rather than waiting on numbers a turn only produces when
// it ends.
import type { AgentSummary } from "@intentic/sandbox-contract";
import { afterEach, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h } from "vue";
import type { PendingAction } from "../composables/agents/laneDrop";
import type { FleetAgent } from "../composables/agents/useAgents";

// The card's import chain pulls in app-wide singletons that read browser globals at import time
// (@intentic/ui's useDevice reads window.matchMedia; environment.ts reads window.env). matches:false keeps
// the device DESKTOP, which is the form factor that renders the drill-in affordance beside the button.
vi.hoisted(() => {
    globalThis.matchMedia ??= ((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
    })) as unknown as typeof globalThis.matchMedia;
    globalThis.window.env ??= {
        production: false,
        api: { url: `http://localhost` },
        auth: { googleClientId: `` },
        analytics: { posthogKey: ``, posthogHost: `` },
    };
});

const { default: AgentCard } = await import("./AgentCard.vue");
const { router } = await import("../router");

const NO_ATTENTION: AgentSummary[`attention`] = { plan: false, question: false, permission: false, conflict: false };

// An agent holding finished work on its branch: auto-land off, nothing refused — the one state the card offers
// "Land now" for.
const ready = (status: FleetAgent[`status`] = `ready`): FleetAgent => ({
    id: `a1`,
    status,
    provider: `claude`,
    harness: `native`,
    branch: `agent/a1`,
    title: `fix the thing`,
    updatedAt: 1,
    attention: NO_ATTENTION,
    open: false,
    unread: false,
});

/* AN AGENT ON ITS FIRST TURN, delegating. Nothing is counted yet — no cost, no tokens, no completed turns, no
 * diff — because a turn produces all four when it ENDS, and this one is still running eight children. */
const delegating = (): FleetAgent => ({
    id: `a2`,
    status: `running`,
    provider: `claude`,
    harness: `native`,
    title: `analyse the gap`,
    updatedAt: 1,
    startedAt: 1,
    attention: NO_ATTENTION,
    open: false,
    unread: false,
    activity: { tool: `Agent` },
    subagents: { running: 8, total: 8 },
});

let app: App | undefined;
// Icon and v-tooltip are registered app-wide by installUi; stand-ins keep this off the whole UI plugin. Icon
// prints the glyph it was handed, because WHICH glyph is what says "in flight" on the button.
const mount = (agent: FleetAgent, pending?: PendingAction, onClose?: () => void): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({
        render: () =>
            h(AgentCard, {
                agent,
                now: 2,
                ...(pending !== undefined ? { pending } : {}),
                ...(onClose !== undefined ? { onClose } : {}),
            }),
    });
    app.component(
        `Icon`,
        defineComponent({
            props: { name: String, spin: Boolean },
            render() {
                return h(`i`, { "data-icon": this.name });
            },
        }),
    );
    app.directive(`tooltip`, {});
    app.use(router);
    app.mount(el);
    return el;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

/* A CONVERSATION THE FLEET NEVER REGISTERED, because the daemon refused its send. No branch, no diff, no entry
 * to address — which is what made this card the one the board could do nothing at all with. */
const refused = (): FleetAgent => ({
    id: `a3`,
    status: `failed`,
    provider: `claude`,
    harness: `native`,
    title: `make the subagent limit configurable`,
    updatedAt: 0,
    attention: NO_ATTENTION,
    open: true,
    unread: false,
});

const landButton = (el: HTMLElement): HTMLButtonElement | undefined =>
    [...el.querySelectorAll(`button`)].find((button) => /Land now|Landing/.test(button.textContent ?? ``));

const buttonLabelled = (el: HTMLElement, label: string): HTMLButtonElement | undefined =>
    [...el.querySelectorAll(`button`)].find((button) => button.getAttribute(`aria-label`) === label);

it(`offers the land on the card, so finished work needs no second surface to release it`, () => {
    expect(landButton(mount(ready()))?.textContent?.trim()).toBe(`Land now`);
});

it(`answers the press on the button that was pressed, glyph and words`, () => {
    const button = landButton(mount(ready(), `land`))!;
    expect(button.textContent?.trim()).toBe(`Landing…`);
    expect(button.querySelector(`[data-icon="spinner"]`)).not.toBeNull();
});

// The card dims for every action the board runs against it, archiving included — and the whole reason
// `pending` carries the action rather than a flag is that a Land button spinning through an archive would be
// reporting a land nobody asked for.
it(`leaves the land button alone while some other action holds the card`, () => {
    expect(landButton(mount(ready(), `archive`))?.textContent?.trim()).toBe(`Land now`);
});

// The end of the press, and the point of the whole exercise: the standing the daemon re-derives after a land
// takes the button off the card. Nothing about it is a local edit — the card simply has no land left to offer.
it(`drops the button once the work is in the workspace`, () => {
    expect(landButton(mount(ready(`landed`)))).toBeUndefined();
});

/* THE STAT ROW CARRIES WHAT THE AGENT HAS NOW. Its chips were gated on tokens/cost/diff/turns, and all four
 * only exist once a turn has ended — so an agent whose FIRST turn delegated ran eight children with the board
 * saying nothing, which is the exact case the count was added for. The row is the only surface that outlives
 * the turn (the live line below it goes with the spinner), so this is not a duplicate of that line. */
it(`counts the agents it started while its first turn is still running`, () => {
    expect([...mount(delegating()).querySelectorAll(`button`)].some((button) => button.textContent?.trim() === `8 / 8`)).toBe(true);
});

/* THE CARD THE BOARD COULD DO NOTHING WITH. A refused send leaves a conversation the daemon never registered,
 * and every exit on this board goes through the daemon by id: archive, discard, land and each drop are refused
 * for it, correctly and unanimously. What that left was a card offering a rename and nothing else — permanent,
 * because the tab behind it is restored on every reload. So the exit it DOES have, closing that tab, is offered
 * on the card itself instead of only on the chat rail, which the board never points at. */
it(`offers a close on a card the daemon has no entry for — the only way it can leave the board`, () => {
    expect(buttonLabelled(mount(refused()), `Close agent`)).not.toBeUndefined();
});

it(`asks the board to close it on the press`, () => {
    const closed = vi.fn();
    buttonLabelled(mount(refused(), undefined, closed), `Close agent`)!.click();
    expect(closed).toHaveBeenCalledTimes(1);
});

// The two never appear together, which is what lets them share one slot: an agent the daemon knows is ARCHIVED
// (its branch, diff and transcript all kept), and one it has never heard of is CLOSED, because there is nothing
// to keep. Offering the wrong one is worse than offering neither — an archive here posts an id that 404s.
it(`withholds the archive from a card with no entry to archive`, () => {
    expect(buttonLabelled(mount(refused()), `Archive agent`)).toBeUndefined();
});

it(`withholds the close from a registered agent, which archives instead`, () => {
    const landed = mount(ready(`landed`));
    expect(buttonLabelled(landed, `Close agent`)).toBeUndefined();
    expect(buttonLabelled(landed, `Archive agent`)).not.toBeUndefined();
});
