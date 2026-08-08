// @vitest-environment jsdom
import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, nextTick } from "vue";
import type { MenuItem } from "primevue/menuitem";
import type { ChatMessage } from "../composables/chat/transcript";

/* THE CUT'S MENU IS THE WHOLE FEATURE — three outcomes that differ in what happens to the conversation and to
 * the files, and the user picks between them by reading three rows. So what is asserted here is the menu: which
 * rows it offers at a given cut, which of them a cut with no saved state is allowed to offer at all, and that
 * the one destructive row will not fire on a single press. */

const forkAt = vi.hoisted(() => vi.fn());
const rewindTo = vi.hoisted(() => vi.fn(async () => true));
const state = vi.hoisted(() => ({ messages: [] as ChatMessage[], streaming: false, isolated: true, fleet: [] as { id: string; title?: string; forkedFrom?: { conversationId: string; index: number } }[] }));
const opened = vi.hoisted(() => ({ ids: [] as string[] }));
// What the ContextMenu was last handed — the component under test builds it, PrimeVue only draws it.
const shown = vi.hoisted(() => ({ model: [] as MenuItem[], opened: 0 }));

vi.hoisted(() => {
    globalThis.matchMedia ??= ((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
    })) as unknown as typeof globalThis.matchMedia;
    // The fleet read below reaches the environment chain, which every component test has to stand up.
    globalThis.window.env ??= {
        production: false,
        api: { url: `http://localhost` },
        auth: { googleClientId: `` },
        analytics: { posthogKey: ``, posthogHost: `` },
    };
});

vi.mock("@intentic/ui", async () => {
    const { ref: vueRef, defineComponent: define, h: hyper, watchEffect } = await import("vue");
    return {
        useDevice: () => ({ mobile: vueRef(false) }),
        // A stand-in that records the model instead of rendering a popup: jsdom has no layout for PrimeVue's
        // overlay, and the model is the thing worth asserting on anyway.
        ContextMenu: define({
            props: { model: { type: Array, default: () => [] } },
            setup(props, { expose }) {
                watchEffect(() => (shown.model = props.model as MenuItem[]));
                expose({
                    show: () => {
                        shown.opened += 1;
                    },
                    hide: () => {},
                });
                return () => hyper(`div`);
            },
        }),
    };
});
vi.mock("../composables/workspace/useHistory", () => ({ invalidateWorkspace: vi.fn() }));
vi.mock("../composables/chat/useChatPopout", () => ({ useChatPopout: () => ({ overlayTarget: undefined }) }));
/* Built fresh per mount rather than once for the file: `state` is a plain object, so a computed over it caches
 * its first reading forever — which silently gave every test the first one's chat. */
vi.mock("../composables/chat/useChat", async () => {
    const { computed, shallowRef } = await import("vue");
    return {
        usePaneView: () => ({
            // The chat this cut belongs to: whether it works in a copy of its own is what decides how many
            // forks the menu has to offer.
            conversation: shallowRef({ conversationId: `c1`, rewindTo, isolated: computed(() => state.isolated) }),
            messages: computed(() => state.messages),
            streaming: computed(() => state.streaming),
            forkAt,
        }),
        useChat: () => ({ conversations: computed(() => []), setActive: (id: string) => opened.ids.push(id) }),
        openAgentConversation: (agent: { id: string }) => opened.ids.push(agent.id),
    };
});
// The forks taken from this conversation are read off the fleet, not off the open tabs — that is what makes the
// mark survive a closed tab, and what lets it count a colleague's fork.
vi.mock("../composables/agents/useAgents", async () => {
    const { computed } = await import("vue");
    return { useAgents: () => ({ fleet: computed(() => state.fleet), agentById: (id: string) => state.fleet.find((agent) => agent.id === id) }) };
});

const { default: ChatForkCut } = await import("./ChatForkCut.vue");

let app: App | undefined;

const mount = (cut: number, last = false): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(ChatForkCut, { cut, last }) });
    app.use(VueQueryPlugin, { queryClient: new QueryClient() });
    app.component(`Icon`, defineComponent({ render: () => h(`i`) }));
    app.directive(`tooltip`, {});
    app.mount(element);
    return element;
};

// Open the menu the way a click does, then read the row by its label's opening words.
const openMenu = async (element: HTMLElement): Promise<void> => {
    element.querySelector(`button`)?.click();
    await nextTick();
};
const row = (label: string): MenuItem | undefined => shown.model.find((item) => String(item.label ?? ``).startsWith(label));

// An anchored message is one the daemon still holds a restorable state for; an unanchored one is a turn from
// before that record, or one that has been evicted.
const anchored = (id: number): ChatMessage => ({ id, role: `user`, text: `prompt ${id}`, rewindIndex: id });
const unanchored = (id: number): ChatMessage => ({ id, role: `user`, text: `prompt ${id}` });

beforeEach(() => {
    vi.useFakeTimers();
    forkAt.mockClear();
    rewindTo.mockClear();
    shown.model = [];
    shown.opened = 0;
    state.messages = [anchored(0), { id: 1, role: `assistant`, text: `answer` }, anchored(2), { id: 3, role: `assistant`, text: `answer` }];
    state.streaming = false;
    state.isolated = true;
    state.fleet = [];
    opened.ids = [];
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    vi.useRealTimers();
});

describe(`the fork cut`, () => {
    it(`offers both forks and the rewind at a cut the daemon still holds a state for`, async () => {
        const element = mount(2);
        await openMenu(element);

        expect(shown.opened).toBe(1);
        expect(row(`Fork`)?.disabled).toBe(false);
        expect(row(`Fork chat only`)?.disabled).toBe(false);
        expect(row(`Rewind`)?.disabled).toBe(false);
    });

    // The two rows that promise old files are the two that need a state to go back to. "Fork chat only" promises
    // the files as they ARE, which is always available — that is the whole reason it is a separate row.
    it(`withholds the rows that promise old files where there is no state to go back to`, async () => {
        state.messages = [anchored(0), { id: 1, role: `assistant`, text: `answer` }, unanchored(2)];
        const element = mount(2);
        await openMenu(element);

        expect(row(`Fork`)?.disabled).toBe(true);
        expect(row(`Fork`)?.[`hint`]).toBe(`No saved state for this point`);
        expect(row(`Rewind`)?.disabled).toBe(true);
        expect(row(`Fork chat only`)?.disabled).toBe(false);
    });

    it(`forks with the files of the moment it names`, async () => {
        const element = mount(2);
        await openMenu(element);

        row(`Fork`)?.command?.({ originalEvent: new Event(`click`), item: {} });
        expect(forkAt).toHaveBeenCalledWith(2, `then`);

        row(`Fork chat only`)?.command?.({ originalEvent: new Event(`click`), item: {} });
        expect(forkAt).toHaveBeenLastCalledWith(2, `now`);
    });

    /* THE WHOLE CONVERSATION rides the LAST turn's mark. It has no boundary of its own — there is no turn past
     * the end, and so no state filed under it either — which leaves exactly one honest offer, the one that
     * promises nothing about old files. It used to be a cut line of its own drawn past the final message,
     * which is to say a full-width row sitting on top of the composer. */
    it(`offers the whole conversation on the last turn's mark`, async () => {
        const element = mount(2, true);
        await openMenu(element);

        expect(row(`Fork the whole conversation`)?.disabled).toBe(false);
        row(`Fork the whole conversation`)?.command?.({ originalEvent: new Event(`click`), item: {} });
        expect(forkAt).toHaveBeenCalledWith(4, `now`);
    });

    // Anywhere else that row would be a second name for the cut below it, which has a mark of its own.
    it(`keeps the whole-conversation row off the turns that are not last`, async () => {
        const element = mount(2);
        await openMenu(element);

        expect(row(`Fork the whole conversation`)).toBeUndefined();
    });

    // A one-turn chat has no boundary inside it — a fork above its first turn would inherit nothing — so its
    // mark carries the single offer that still means something rather than a menu of dead rows.
    it(`offers only the whole conversation on a lone first turn`, async () => {
        const element = mount(0, true);
        await openMenu(element);

        expect(shown.model.map((item) => item.label)).toEqual([`Fork the whole conversation`]);
    });

    // The one row that destroys anything: the first press only arms, and says what the second one would cost.
    it(`arms the rewind before it fires, naming what it would drop`, async () => {
        const element = mount(2);
        await openMenu(element);

        row(`Rewind`)?.command?.({ originalEvent: new Event(`click`), item: {} });
        await nextTick();
        expect(rewindTo).not.toHaveBeenCalled();
        expect(row(`Click again`)?.label).toBe(`Click again — drops 2 messages`);

        row(`Click again`)?.command?.({ originalEvent: new Event(`click`), item: {} });
        await nextTick();
        expect(rewindTo).toHaveBeenCalledWith(state.messages[2]);
    });

    // Arming decays, so a menu left open cannot fire on a stray press minutes later.
    it(`disarms the rewind after four seconds`, async () => {
        const element = mount(2);
        await openMenu(element);

        row(`Rewind`)?.command?.({ originalEvent: new Event(`click`), item: {} });
        await nextTick();
        expect(row(`Click again`)).toBeDefined();

        vi.advanceTimersByTime(4000);
        await nextTick();
        expect(row(`Click again`)).toBeUndefined();
        expect(row(`Rewind`)?.disabled).toBe(false);
    });

    /* A TURN IN FLIGHT OWNS THE FILES, NOT THE TRANSCRIPT ABOVE IT. Copying the turns above the cut into a new
     * chat takes nothing away from the run still writing below, and a turn that has been going twenty minutes
     * is exactly when a second line of attack is worth opening — so the chat fork stands. The two rows that
     * would put files back where they were wait, and say why rather than going quietly grey. */
    it(`forks the chat while a turn is running, and holds back the rows that move files`, async () => {
        state.streaming = true;
        const element = mount(2);
        await openMenu(element);

        expect(row(`Fork chat only`)?.disabled).toBe(false);
        expect(row(`Fork`)?.disabled).toBe(true);
        expect(row(`Fork`)?.[`hint`]).toBe(`Old files have to wait for the turn to finish`);
        expect(row(`Rewind`)?.disabled).toBe(true);

        row(`Fork chat only`)?.command?.({ originalEvent: new Event(`click`), item: {} });
        expect(forkAt).toHaveBeenCalledWith(2, `now`);
    });

    // A shared-workspace chat's one fork IS the chat fork, so a running turn leaves it alone entirely.
    it(`still forks a shared-workspace chat while a turn is running`, async () => {
        state.isolated = false;
        state.streaming = true;
        const element = mount(2);
        await openMenu(element);

        expect(row(`Fork`)?.disabled).toBe(false);
    });

    /* A chat working in the SHARED workspace has one fork to give — its files are everyone else's too, so
     * "as they were here" is not a thing it can offer without rolling the tree back under other chats. Two
     * rows then, not a third that could never be pressed, and the one fork still says which files it lands on.
     * Going back is untouched: that moves this chat's own files, which is what it has always meant. */
    it(`offers one fork where the chat shares the workspace, and still says which files it lands on`, async () => {
        state.isolated = false;
        const element = mount(2);
        await openMenu(element);

        expect(row(`Fork chat only`)).toBeUndefined();
        expect(row(`Fork`)?.disabled).toBe(false);
        expect(row(`Fork`)?.[`hint`]).toBe(`New chat, files as they are now`);
        expect(row(`Rewind`)?.disabled).toBe(false);

        row(`Fork`)?.command?.({ originalEvent: new Event(`click`), item: {} });
        expect(forkAt).toHaveBeenCalledWith(2, `now`);
    });
});

/* THE OTHER END OF THE RELATIONSHIP. A fork's own transcript says where it came from; this is what the SOURCE
 * shows at the point it was cut — because the reason to fork is to compare, and a path you cannot reach from
 * where it left is one you will not compare. */
describe(`a cut that has been forked`, () => {
    // In the MENU, by name — out in the margin they were a row of chips, which is the width this control gave
    // back. The menu costs a click and keeps every branch findable from the point it left.
    it(`names the forks taken from exactly this point, and opens them`, async () => {
        state.fleet = [
            { id: `fork-a`, title: `Without the cache`, forkedFrom: { conversationId: `c1`, index: 2 } },
            { id: `fork-b`, title: `Somewhere else entirely`, forkedFrom: { conversationId: `c1`, index: 4 } },
            { id: `stranger`, title: `Unrelated`, forkedFrom: { conversationId: `other`, index: 2 } },
        ];
        const element = mount(2);
        await openMenu(element);

        // Only this cut's fork — the one taken four messages down belongs to a different point, and an
        // unrelated conversation's fork belongs to a different chat.
        const labels = shown.model.map((item) => String(item.label ?? ``));
        expect(labels).toContain(`Without the cache`);
        expect(labels).not.toContain(`Somewhere else entirely`);
        expect(labels).not.toContain(`Unrelated`);

        row(`Without the cache`)?.command?.({ originalEvent: new Event(`click`), item: {} });
        expect(opened.ids).toEqual([`fork-a`]);
    });

    // A junction is worth seeing without hunting for it, so its mark stands lit and permanent.
    it(`stands lit where a fork was taken`, async () => {
        state.fleet = [{ id: `fork-a`, title: `Without the cache`, forkedFrom: { conversationId: `c1`, index: 2 } }];
        const element = mount(2);
        await nextTick();

        expect(element.querySelector(`button`)?.className).toContain(`text-link`);
    });

    // An untaken cut stays out of the way: the mark is in the margin but invisible until a pointer arrives.
    it(`stays dim at a cut nobody has forked`, async () => {
        const element = mount(2);
        await nextTick();

        const className = element.querySelector(`button`)?.className ?? ``;
        expect(className).toContain(`opacity-0`);
        expect(className).not.toContain(`text-link`);
    });

    /* AND IT DOES NOT APPEAR JUST BECAUSE SOMETHING IS RUNNING. The chip this replaced did exactly that — it
     * was visible only while a turn was in flight, which was the one state in which it refused to be pressed,
     * so the only version of the control most people ever saw was a greyed-out one that did nothing. */
    it(`does not light up merely because a turn is running`, async () => {
        state.streaming = true;
        const element = mount(2);
        await nextTick();

        expect(element.querySelector(`button`)?.className).toContain(`opacity-0`);
    });
});
