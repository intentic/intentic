// A collapsed run renders outside a ChatPane (the Subagents page) and opens its file through the injected surface.
import "@intentic/testing/dom";
import { describe, it, expect, afterEach } from "bun:test";
import { type App, createApp, h } from "vue";
import type { TranscriptTool } from "@intentic/sandbox-contract";
import type { ChatSurface } from "./chatToolSurface";
import { IconStub } from "@intentic/ui/testing";

const { default: ChatToolRows } = await import("./ChatToolRows.vue");
const { CHAT_SURFACE } = await import("./chatToolSurface");

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

    it(`opens the run's file through the surface it is mounted under`, () => {
        const opened: [string, number | undefined][] = [];
        const element = mount(edits(3), { imageUrl: () => undefined, openFile: (path, line) => opened.push([path, line]) });
        const chip = [...element.querySelectorAll(`button`)].find((button) => button.textContent?.includes(`src/store.ts`));
        chip?.click();
        expect(opened).toEqual([[`src/store.ts`, 12]]);
    });
});
