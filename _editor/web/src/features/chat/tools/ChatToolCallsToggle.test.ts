// Pins what a press on the tool-calls switch says it did: the switch governs every chat, so in one holding a single call
// (or none) the press changed one small row or nothing, and a reader toggled it eight times looking for the difference.
import "@intentic/testing/dom";
import { type App, computed, createApp, h, nextTick } from "vue";
import type { TranscriptTool } from "@intentic/sandbox-contract";
import { IconStub } from "@intentic/ui/testing";
import { PANE_VIEW } from "../panel/useChat-view";
import type { ChatMessage } from "../transcript/transcript";
import { toolCallsNote, useToolCalls } from "./useToolCalls";

const { default: ChatToolCallsToggle } = await import("./ChatToolCallsToggle.vue");

const { showToolCalls } = useToolCalls();

const read = (path: string): TranscriptTool => ({ id: path, name: `Read`, input: { file_path: path }, status: `done` }) as unknown as TranscriptTool;
const turn = (tools: readonly TranscriptTool[]): ChatMessage =>
    ({ id: `m${tools.length}`, role: `assistant`, text: ``, tools }) as unknown as ChatMessage;

let app: App | undefined;
const mount = (messages: readonly ChatMessage[]): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(ChatToolCallsToggle) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    // The pane's view as far as the switch reads it: the transcript it counts.
    app.provide(PANE_VIEW, { messages: computed(() => messages) } as never);
    app.mount(element);
    return element;
};

beforeEach(() => {
    // The preference is account-wide and persists across mounts; every case states the mode it is about.
    showToolCalls.value = false;
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

const press = async (element: HTMLElement): Promise<string> => {
    element.querySelector<HTMLButtonElement>(`button`)?.click();
    await nextTick();
    return element.querySelector(`[role="status"]`)?.textContent?.trim() ?? ``;
};

describe(`a press on the tool-calls switch`, () => {
    it(`says how many calls it showed in this chat, and that it folded them on the way back`, async () => {
        const element = mount([turn([read(`a.ts`), read(`b.ts`)]), turn([read(`c.ts`)])]);
        expect(await press(element)).toBe(`Showing 3 tool calls`);
        expect(showToolCalls.value).toBe(true);
        expect(await press(element)).toBe(`3 tool calls hidden`);
    });

    it(`says so when this chat has no calls to show yet`, async () => {
        expect(await press(mount([turn([])]))).toBe(`No tool calls in this chat yet`);
    });

    it(`says nothing until pressed`, () => {
        expect(
            mount([turn([read(`a.ts`)])])
                .querySelector(`[role="status"]`)
                ?.textContent?.trim(),
        ).toBe(``);
    });
});

describe(`toolCallsNote`, () => {
    it(`counts one call in the singular`, () => {
        expect(toolCallsNote(true, 1)).toBe(`Showing 1 tool call`);
        expect(toolCallsNote(false, 1)).toBe(`1 tool call hidden`);
        expect(toolCallsNote(false, 0)).toBe(`No tool calls in this chat yet`);
    });
});
