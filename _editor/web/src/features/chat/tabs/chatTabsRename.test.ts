// The rail's rename is one state shared by every row, so it has to end with the row it was opened on.
// Regression: a row that left mid-rename took its input with it and left nothing to blur the edit shut, so
// reopening that chat from the board drew an empty "New agent" field in the lane instead of its card.
import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import type { AgentSummary } from "@intentic/sandbox-contract";
import { VueQueryPlugin } from "@tanstack/vue-query";
import { t } from "@intentic/ui/i18n";
import { type App, type ComponentPublicInstance, createApp, h, nextTick, ref } from "vue";
import { setAgents } from "../../agents/fleet/useAgents-registry";
import { useChat } from "../run/useChat";
import { draftConversation, openAgentConversation, reveal } from "../panel/useChat-reveal";
import { queryClient } from "../../../lib/queryPersistence";
import { router } from "../../../router";
import ChatTabList from "./ChatTabList.vue";
import { IconStub } from "@intentic/ui/testing";

// Globals a mounted chat needs that jsdom lacks.
(() => {
    globalThis.Element.prototype.scrollIntoView = function scrollIntoView(): void {};
})();

let app: App | undefined;
// Re-renders by component name, the unit perf-browser's probe counts in.
const updates = new Map<string, number>();
// The list's own rename door, the one F2 reaches it by (ChatTabList.defineExpose).
const list = ref<{ beginRename: (id: string) => void } | undefined>(undefined);

const settle = async (): Promise<void> => {
    await nextTick();
    await nextTick();
    await nextTick();
};

// Mounted once per test, mirroring the floating window's own lifetime: the state this pins only survives
// because the rail is never remounted.
const mountList = async (): Promise<HTMLElement> => {
    const el = document.createElement(`div`);
    document.body.appendChild(el);
    app = createApp({ render: () => h(ChatTabList, { ref: list, onClose: (ids: ReadonlySet<string>) => useChat().closeTabs(ids) }) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mixin({
        updated(this: ComponentPublicInstance) {
            const options = this.$options as { readonly __name?: string; readonly name?: string };
            const name = options.__name ?? options.name;
            if (name !== undefined) {
                updates.set(name, (updates.get(name) ?? 0) + 1);
            }
        },
    });
    app.use(router);
    app.use(VueQueryPlugin, { queryClient });
    app.mount(el);
    await settle();
    return el;
};

beforeEach(async () => {
    localStorage.clear();
    resetSandboxScope();
    updates.clear();
    await nextTick();
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.replaceChildren();
});

// Two running agents on their own branches, so their chats are isolated ones (an agent, not a workspace chat)
// and both sit in Active.
const seed = (revision = 100): void =>
    setAgents(
        [`working`, `other`].map((id, at) => ({
            id,
            status: `running`,
            provider: `claude`,
            harness: `native`,
            branch: `agent/${id}`,
            updatedAt: 2_000 - at,
            attention: { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false },
        })) satisfies AgentSummary[],
        revision,
    );

// The same call a board card's click makes.
const openFromBoard = (id: string): void => {
    openAgentConversation({ id, provider: `claude`, harness: `native`, branch: `agent/${id}`, registered: true });
};

const cardOf = (el: HTMLElement, id: string): HTMLElement | null => el.querySelector(`[data-chat-tab="${id}"]`);
// Rename fields open in the lanes, by what they offer as a name; an untitled agent chat shows "New agent".
const fields = (el: HTMLElement): string[] =>
    [...el.querySelectorAll<HTMLInputElement>(`input[aria-label="Chat title"]`)].map((input) => input.placeholder);

// Rename is F2, the pencil and the menu; a double-click on a row is two clicks and nothing more.
const renameRow = async (_el: HTMLElement, id: string): Promise<void> => {
    list.value?.beginRename(id);
    await settle();
};

it(`opens a rename field on the row it was asked for`, async () => {
    seed();
    const el = await mountList();
    openFromBoard(`working`);
    await settle();

    await renameRow(el, `working`);

    expect(fields(el)).toEqual([`New agent`]);
    expect(cardOf(el, `working`)).toBeNull();
});

it(`opens no rename field on a double-click`, async () => {
    seed();
    const el = await mountList();
    openFromBoard(`working`);
    await settle();

    cardOf(el, `working`)?.dispatchEvent(new MouseEvent(`dblclick`, { bubbles: true }));
    await settle();

    expect(fields(el)).toEqual([]);
    expect(cardOf(el, `working`)).not.toBeNull();
});

it(`draws a reopened chat as its card, not the rename field its row was closed in`, async () => {
    seed();
    const el = await mountList();
    openFromBoard(`working`);
    openFromBoard(`other`);
    await settle();
    await renameRow(el, `working`);
    expect(fields(el)).toEqual([`New agent`]);

    useChat().closeTabs(new Set([`working`]));
    await settle();
    openFromBoard(`working`);
    await settle();

    expect(fields(el)).toEqual([]);
    expect(cardOf(el, `working`)).not.toBeNull();
});

it(`keeps the field open while its row is on screen, roster frames and all`, async () => {
    seed();
    const el = await mountList();
    openFromBoard(`working`);
    await settle();
    await renameRow(el, `working`);

    seed(101);
    await settle();

    expect(fields(el)).toEqual([`New agent`]);
});

// A keystroke in the composer redraws what shows the draft, not the rail around it: perf-browser's chat-typing budget
// counts every render a key causes, and the unsent mark's words, read in the slot of the card that carries the mark,
// put the whole card and everything on it on each key. Here beside the rename, the rail's other per-row state.
it(`redraws the unsent mark on a keystroke, and not the rail card or row that carry it`, async () => {
    const typed = useChat().active.value;
    typed.title.value = `Provider usage limits · audit`;
    const other = draftConversation();
    reveal({ verb: `show`, entries: [other], focus: typed.conversationId, caret: false });
    other.title.value = `Pipeline triggers · implement`;
    other.draft.value = `kept`;
    // Already unsent, so the mark is on the card before the first counted key: its arrival is the card's to draw.
    typed.draft.value = `t`;
    const el = await mountList();
    updates.clear();

    for (const key of `he plan looks right`) {
        typed.draft.value += key;
        await settle();
    }

    expect(updates.get(`RailCard`) ?? 0).toBe(0);
    expect(updates.get(`ChatTabRow`) ?? 0).toBe(0);
    // The words still follow the draft, to the last key: the mark reads them itself.
    const mark = el.querySelector(`[data-chat-tab="${typed.conversationId}"] [aria-label^="${t(`common.unsentMark.notSent`)}"]`);
    expect(mark?.getAttribute(`aria-label`)).toContain(`the plan looks right`);
});
