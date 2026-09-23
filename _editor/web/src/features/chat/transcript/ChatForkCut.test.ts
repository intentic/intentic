import "@intentic/testing/dom";
import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { type App, computed, createApp, defineComponent as define, h, h as hyper, nextTick, ref as vueRef, shallowRef, watchEffect } from "vue";
import type { MenuItem } from "primevue/menuitem";
import type { ChatMessage } from "./transcript";
import { errands } from "../run/errands";
import { IconStub } from "@intentic/ui/testing";

// Pins the cut's menu: which rows a cut offers, which an uncheckpointed cut may still show, and that the destructive rewind
// needs two presses.

const forkAt = jest.fn();
const rewindTo = jest.fn(async () => true);
const beginEdit = jest.fn();
const state = {
    messages: [] as ChatMessage[],
    streaming: false,
    isolated: true,
    // Message an edit is already armed on, if any; its own cut's row drops out when set.
    editing: undefined as ChatMessage | undefined,
    fleet: [] as { id: string; title?: string; forkedFrom?: { conversationId: string; index: number } }[],
};
const opened = { ids: [] as string[] };
// What the ContextMenu component was last handed, since PrimeVue itself isn't mounted here.
const shown = { model: [] as MenuItem[], opened: 0 };

(() => {
    // The fleet read below reaches the environment chain every component test must stand up.
})();

jest.mock("@intentic/ui", () => {
    return {
        useDevice: () => ({ mobile: vueRef(false) }),
        // Stub that records the model instead of rendering a popup; jsdom has no layout for PrimeVue's overlay.
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
jest.mock("../../workspace/changes/history/useHistory", () => ({ invalidateWorkspace: jest.fn() }));
// Built fresh per mount: a computed over the plain `state` object would otherwise cache its first reading.
jest.mock("../panel/useChat-view", () => {
    return {
        usePaneView: () => ({
            // Whether the chat works in a copy of its own decides how many forks the menu offers.
            conversation: shallowRef({ conversationId: `c1`, transcript: { rewindTo, beginEdit }, isolated: computed(() => state.isolated) }),
            messages: computed(() => state.messages),
            streaming: computed(() => state.streaming),
            forkAt,
            editing: computed(() => state.editing),
        }),
    };
});
jest.mock("../run/useChat", () => {
    return { useChat: () => ({ conversations: computed(() => []), setActive: (id: string) => opened.ids.push(id) }) };
});
jest.mock("../panel/useChat-reveal", () => ({ openAgentConversation: (agent: { id: string }) => opened.ids.push(agent.id) }));
// Forks are read off the fleet, not open tabs, so a closed tab or a colleague's fork still counts.
jest.mock("../../agents/fleet/useAgents", () => {
    return { useAgents: () => ({ fleet: computed(() => state.fleet), agentById: (id: string) => state.fleet.find((agent) => agent.id === id) }) };
});

const { default: ChatForkCut } = await import("./ChatForkCut.vue");

let app: App | undefined;

const mount = (cut: number): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(ChatForkCut, { cut }) });
    app.use(VueQueryPlugin, { queryClient: new QueryClient() });
    app.component(`Icon`, IconStub);
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

// Anchored has a restorable state; uncheckpointed predates that record or has been evicted.
const anchored = (id: number): ChatMessage => ({ id, role: `user`, text: `prompt ${id}`, rewindIndex: id });
const uncheckpointed = (id: number): ChatMessage => ({ id, role: `user`, text: `prompt ${id}` });

beforeEach(() => {
    jest.useFakeTimers();
    forkAt.mockClear();
    rewindTo.mockClear();
    beginEdit.mockClear();
    shown.model = [];
    shown.opened = 0;
    state.messages = [anchored(0), { id: 1, role: `assistant`, text: `answer` }, anchored(2), { id: 3, role: `assistant`, text: `answer` }];
    state.streaming = false;
    state.isolated = true;
    state.editing = undefined;
    state.fleet = [];
    opened.ids = [];
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    jest.useRealTimers();
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

    it(`withholds the rows that promise old files where there is no state to go back to`, async () => {
        state.messages = [anchored(0), { id: 1, role: `assistant`, text: `answer` }, uncheckpointed(2)];
        const element = mount(2);
        await openMenu(element);

        expect(row(`Fork`)?.disabled).toBe(true);
        expect(row(`Fork`)?.[`hint`]).toContain(`No saved state`);
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

    it(`offers only the whole conversation where nothing is left below the line`, async () => {
        const element = mount(4);
        await openMenu(element);

        expect(shown.model.map((item) => item.label)).toEqual([`Fork the whole conversation`]);
        row(`Fork the whole conversation`)?.command?.({ originalEvent: new Event(`click`), item: {} });
        expect(forkAt).toHaveBeenCalledWith(4, `now`);
    });

    it(`leads with editing the prompt the cut sits above, and arms rather than fires`, async () => {
        const element = mount(2);
        await openMenu(element);

        expect(shown.model[0]?.label).toBe(`Edit this message`);
        expect(row(`Edit`)?.disabled).toBe(false);

        row(`Edit`)?.command?.({ originalEvent: new Event(`click`), item: {} });
        expect(beginEdit).toHaveBeenCalledWith(state.messages[2]);
        expect(rewindTo).not.toHaveBeenCalled();
        expect(forkAt).not.toHaveBeenCalled();
    });

    it(`refuses the edit where the files cannot come back, and while a turn holds them`, async () => {
        state.messages = [anchored(0), { id: 1, role: `assistant`, text: `answer` }, uncheckpointed(2)];
        const element = mount(2);
        await openMenu(element);
        expect(row(`Edit`)?.disabled).toBe(true);
        const noStateHint = row(`Edit`)?.[`hint`];
        expect(noStateHint).toContain(`No saved state`);
        app?.unmount();

        state.messages = [anchored(0), { id: 1, role: `assistant`, text: `answer` }, anchored(2)];
        state.streaming = true;
        const running = mount(2);
        await openMenu(running);
        expect(row(`Edit`)?.disabled).toBe(true);
        const streamingHint = row(`Edit`)?.[`hint`];
        expect(streamingHint).toContain(`turn`);
        expect(streamingHint).not.toEqual(noStateHint);
    });

    it(`offers no edit where the cut sits above the agent's own words`, async () => {
        state.messages = [anchored(0), { id: 1, role: `assistant`, text: `answer` }, { id: 2, role: `assistant`, text: `more` }];
        const element = mount(2);
        await openMenu(element);

        expect(row(`Edit`)).toBeUndefined();
        expect(row(`Fork`)).toEqual(expect.any(Object));
    });

    it(`drops the edit row from the cut whose own edit is already armed`, async () => {
        state.editing = state.messages[2];
        const element = mount(2);
        await openMenu(element);

        expect(row(`Edit`)).toBeUndefined();
        app?.unmount();
        const other = mount(0);
        await openMenu(other);
        expect(row(`Edit`)).toEqual(expect.any(Object));
    });

    // An errand's text starts with the app's own composed opening, not something the user typed.
    it(`offers no edit above an errand, and still offers every way back to it`, async () => {
        const errand: ChatMessage = {
            id: 2,
            role: `user`,
            rewindIndex: 2,
            text: `${errands().landConflict.opening}\n\nroot: two files`,
        };
        state.messages = [anchored(0), { id: 1, role: `assistant`, text: `answer` }, errand, { id: 3, role: `assistant`, text: `fixed` }];
        const element = mount(2);
        await openMenu(element);

        expect(row(`Edit`)).toBeUndefined();
        expect(row(`Fork`)?.disabled).toBe(false);
        expect(row(`Rewind`)?.disabled).toBe(false);
    });

    it(`drops the chat-only fork at the head, where it would keep nothing`, async () => {
        const element = mount(0);
        await openMenu(element);

        expect(row(`Fork chat only`)).toBeUndefined();
        expect(row(`Fork`)?.disabled).toBe(false);
        expect(row(`Edit`)?.disabled).toBe(false);
        expect(row(`Rewind`)?.disabled).toBe(false);
        row(`Fork`)?.command?.({ originalEvent: new Event(`click`), item: {} });
        expect(forkAt).toHaveBeenCalledWith(0, `then`);
    });

    it(`offers no fork at the head of a chat working in the shared workspace`, async () => {
        state.isolated = false;
        const element = mount(0);
        await openMenu(element);

        expect(row(`Fork`)).toBeUndefined();
        expect(row(`Edit`)?.disabled).toBe(false);
        expect(row(`Rewind`)?.disabled).toBe(false);
    });

    it(`keeps the whole-conversation row off the marks with a turn below them`, async () => {
        const element = mount(2);
        await openMenu(element);

        expect(row(`Fork the whole conversation`)).toBeUndefined();
    });

    it(`arms the rewind before it fires, naming what it would drop`, async () => {
        const element = mount(2);
        await openMenu(element);

        row(`Rewind`)?.command?.({ originalEvent: new Event(`click`), item: {} });
        await nextTick();
        expect(rewindTo).not.toHaveBeenCalled();
        expect(row(`Click again`)?.label).toContain(`2`);
        expect(row(`Click again`)?.label).toContain(`messages`);

        row(`Click again`)?.command?.({ originalEvent: new Event(`click`), item: {} });
        await nextTick();
        expect(rewindTo).toHaveBeenCalledWith(state.messages[2]);
    });

    it(`disarms the rewind after four seconds`, async () => {
        const element = mount(2);
        await openMenu(element);

        row(`Rewind`)?.command?.({ originalEvent: new Event(`click`), item: {} });
        await nextTick();
        expect(row(`Click again`)).toEqual(expect.any(Object));

        jest.advanceTimersByTime(4000);
        await nextTick();
        expect(row(`Click again`)).toBeUndefined();
        expect(row(`Rewind`)?.disabled).toBe(false);
    });

    it(`forks the chat while a turn is running, and holds back the rows that move files`, async () => {
        state.streaming = true;
        const element = mount(2);
        await openMenu(element);

        expect(row(`Fork chat only`)?.disabled).toBe(false);
        expect(row(`Fork`)?.disabled).toBe(true);
        expect(row(`Fork`)?.[`hint`]).toContain(`turn`);
        expect(row(`Rewind`)?.disabled).toBe(true);

        row(`Fork chat only`)?.command?.({ originalEvent: new Event(`click`), item: {} });
        expect(forkAt).toHaveBeenCalledWith(2, `now`);
    });

    it(`still forks a shared-workspace chat while a turn is running`, async () => {
        state.isolated = false;
        state.streaming = true;
        const element = mount(2);
        await openMenu(element);

        expect(row(`Fork`)?.disabled).toBe(false);
    });

    it(`offers one fork where the chat shares the workspace, and still says which files it lands on`, async () => {
        state.isolated = false;
        const element = mount(2);
        await openMenu(element);

        expect(row(`Fork chat only`)).toBeUndefined();
        expect(row(`Fork`)?.disabled).toBe(false);
        expect(row(`Fork`)?.[`hint`]).toContain(`files`);
        expect(row(`Fork`)?.[`hint`]).not.toContain(`turn`);
        expect(row(`Rewind`)?.disabled).toBe(false);

        row(`Fork`)?.command?.({ originalEvent: new Event(`click`), item: {} });
        expect(forkAt).toHaveBeenCalledWith(2, `now`);
    });
});

// What the cut itself shows once something has been forked from it, as opposed to the fork's own "Forked from" line.
describe(`a cut that has been forked`, () => {
    it(`names the forks taken from exactly this point, and opens them`, async () => {
        state.fleet = [
            { id: `fork-a`, title: `Without the cache`, forkedFrom: { conversationId: `c1`, index: 2 } },
            { id: `fork-b`, title: `Somewhere else entirely`, forkedFrom: { conversationId: `c1`, index: 4 } },
            { id: `stranger`, title: `Unrelated`, forkedFrom: { conversationId: `other`, index: 2 } },
        ];
        const element = mount(2);
        await openMenu(element);

        const labels = shown.model.map((item) => String(item.label ?? ``));
        expect(labels).toContain(`Without the cache`);
        expect(labels).not.toContain(`Somewhere else entirely`);
        expect(labels).not.toContain(`Unrelated`);

        row(`Without the cache`)?.command?.({ originalEvent: new Event(`click`), item: {} });
        expect(opened.ids).toEqual([`fork-a`]);
    });

    it(`stands lit where a fork was taken`, async () => {
        state.fleet = [{ id: `fork-a`, title: `Without the cache`, forkedFrom: { conversationId: `c1`, index: 2 } }];
        const element = mount(2);
        await nextTick();

        expect(element.querySelector(`button`)?.className).toContain(`text-link`);
    });

    it(`stays dim at a cut nobody has forked`, async () => {
        const element = mount(2);
        await nextTick();

        const className = element.querySelector(`button`)?.className ?? ``;
        expect(className).toContain(`opacity-0`);
        expect(className).not.toContain(`text-link`);
    });

    it(`does not light up merely because a turn is running`, async () => {
        state.streaming = true;
        const element = mount(2);
        await nextTick();

        expect(element.querySelector(`button`)?.className).toContain(`opacity-0`);
    });
});
