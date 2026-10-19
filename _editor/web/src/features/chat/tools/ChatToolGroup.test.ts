// A collapsed run renders wherever a surface is provided, not only in a ChatPane, and opens its file through it.
import "@intentic/testing/dom";
import { type App, createApp, h } from "vue";
import type { TranscriptTool } from "@intentic/sandbox-contract/events/transcript";
import type { ChatSurface } from "../../../models/conversations/tools/chatToolSurface";
import { IconStub } from "@intentic/ui/testing";

const { default: ChatToolRows } = await import("./ChatToolRows.vue");
const { CHAT_SURFACE } = await import("../../../models/conversations/tools/chatToolSurface");

let app: App | undefined;
const mount = (tools: readonly TranscriptTool[], surface?: ChatSurface): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(ChatToolRows, { tools, live: false }) });
    if (surface !== undefined) {
        app.provide(CHAT_SURFACE, surface);
    }
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(element);
    return element;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

const edits = (count: number): TranscriptTool[] =>
    Array.from({ length: count }, (_, index) => ({
        id: `e${index}`,
        name: `Edit`,
        category: `edit`,
        status: `completed`,
        target: `src/store.ts`,
        locations: [{ path: `src/store.ts`, line: 12 }],
    }));

describe(`ChatToolGroup`, () => {
    it(`renders a collapsed run outside any chat pane`, () => {
        const element = mount(edits(3));
        expect(element.textContent).toContain(`×3`);
        expect(element.textContent).toContain(`src/store.ts`);
        // No surface to open files through, so the target is text rather than a button that does nothing.
        const chip = [...element.querySelectorAll(`button`)].find((button) => button.textContent?.includes(`src/store.ts`));
        expect(chip).toBeUndefined();
    });

    it(`names a run of MCP calls as its server and tool, the id kept as the title`, () => {
        const waits: TranscriptTool[] = [0, 1, 2].map((index) => ({ id: `w${index}`, name: `mcp__subagents__wait`, category: `other`, status: `completed` }));
        const element = mount(waits);
        const named = [...element.querySelectorAll(`span.font-medium`)].find((span) => span.textContent?.includes(`Subagents`));
        expect(named?.textContent?.trim()).toBe(`Subagents · wait`);
        expect(named?.getAttribute(`title`)).toBe(`mcp__subagents__wait`);
    });

    it(`opens the run's file through the surface it is mounted under`, () => {
        const opened: [string, number | undefined][] = [];
        const element = mount(edits(3), { imageUrl: () => undefined, openFile: (path, line) => opened.push([path, line]) });
        const chip = [...element.querySelectorAll(`button`)].find((button) => button.textContent?.includes(`src/store.ts`));
        chip?.click();
        expect(opened).toEqual([[`src/store.ts`, 12]]);
    });
});
