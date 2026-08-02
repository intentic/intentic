// @vitest-environment jsdom
//
// jsdom because the subject is the card's PRESS — and a press is only what the user sees come back. Landing an
// agent's work is a round trip to a daemon that has to commit, diff and patch-apply before the card can change
// lane, and for that whole span the only honest report is on the control that was pressed. Two properties are
// pinned here, and neither can be read off the code: the Land button states its own progress, and it states it
// for ITS action only — the card is equally busy while an archive is out, and a Land button spinning through
// one would be reporting work nobody asked for.
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

let app: App | undefined;
// Icon and v-tooltip are registered app-wide by installUi; stand-ins keep this off the whole UI plugin. Icon
// prints the glyph it was handed, because WHICH glyph is what says "in flight" on the button.
const mount = (agent: FleetAgent, pending?: PendingAction): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(AgentCard, { agent, now: 2, ...(pending !== undefined ? { pending } : {}) }) });
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

const landButton = (el: HTMLElement): HTMLButtonElement | undefined =>
    [...el.querySelectorAll(`button`)].find((button) => /Land now|Landing/.test(button.textContent ?? ``));

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
