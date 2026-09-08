// @vitest-environment jsdom
// Pins that a sub-agent delegation nests its own calls and thinking under the card (ChatToolCard renders
// itself recursively) instead of a flat sibling list. Needs jsdom: a failed resolve renders wrong, not a throw.
import { afterEach, describe, expect, it } from "vitest";
import { type App, createApp, h } from "vue";
import type { TranscriptTool } from "@intentic/sandbox-contract";
import type { ChatSurface } from "./chatToolSurface";
import { IconStub } from "@intentic/ui/testing";

// Import chain reads window.matchMedia and window.env at module load; vitest.setup.ts stands both up before
// this file loads, same as the real page.

const { default: ChatToolCard } = await import("./ChatToolCard.vue");
const { CHAT_SURFACE } = await import("./chatToolSurface");

let app: App | undefined;
// `surface` is what the card reaches beyond itself; omitted, it falls back to the inert one, the same shape a
// publicly shared conversation renders under.
const mount = (tool: TranscriptTool, live = true, surface?: ChatSurface): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(ChatToolCard, { tool, live }) });
    if (surface !== undefined) {
        app.provide(CHAT_SURFACE, surface);
    }
    // Icon/tooltip stubs keep the test off the real UI plugin; Icon still renders the glyph and spin state.
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

describe(`ChatToolCard`, () => {
    it(`nests a sub-agent's child calls and thinking under the delegation card (renders itself recursively)`, () => {
        // A running Agent card starts expanded, so its nested transcript is visible.
        const thinking = `weighing the options`;
        const element = mount({
            id: `a1`,
            name: `Agent`,
            category: `other`,
            status: `in_progress`,
            thinking,
            children: [
                { id: `b1`, name: `Bash`, category: `execute`, status: `completed`, target: `ls -la`, content: [{ type: `text`, text: `file.txt` }] },
            ],
        });

        // `.border-l` is the child's own card; its presence proves the recursive reference resolved.
        const nested = element.querySelector(`.border-l`);
        expect(nested).not.toBeNull();
        expect(nested?.textContent).toContain(`Bash`);
        expect(nested?.textContent).toContain(`ls -la`);
        // The sub-agent's thinking rides on the card, not the parent turn.
        expect(element.textContent).toContain(thinking);
    });

    it(`shows no nested transcript for an ordinary tool call`, () => {
        const element = mount({ id: `t1`, name: `Read`, category: `read`, status: `completed`, target: `a.ts` });
        expect(element.querySelector(`.border-l`)).toBeNull();
    });

    it(`keeps an output-less tool name on one line beside a long, elastic target`, () => {
        const element = mount({
            id: `t1`,
            name: `Edit`,
            category: `edit`,
            status: `completed`,
            target: `update /history/worktrees/very-long-worktree-name/intentic/_editor/web/src/chat/ChatToolCard.vue`,
        });
        const name = element.querySelector(`span.font-medium`)!;

        // Chat messages inherit `overflow-wrap: anywhere`, so the name needs its own no-wrap boundary.
        expect(name.parentElement?.classList).toContain(`shrink-0`);
        expect(name.parentElement?.classList).toContain(`whitespace-nowrap`);
        expect(name.parentElement?.nextElementSibling?.classList).toContain(`min-w-0`);
        expect(name.parentElement?.nextElementSibling?.classList).toContain(`truncate`);
    });

    it(`spins a call in flight while its turn is live`, () => {
        const element = mount({ id: `t1`, name: `Bash`, category: `execute`, status: `in_progress`, target: `pnpm test` });
        expect(element.querySelector(`[data-icon="spinner"]`)).not.toBeNull();
        expect(element.querySelector(`[data-spin]`)).not.toBeNull();
    });

    it(`freezes a call the turn never finished: no animation on a transcript that is only a record`, () => {
        // A stopped or disk-restored turn with no tool_result still reads `in_progress`; nothing will ever move it.
        const element = mount({ id: `t1`, name: `Bash`, category: `execute`, status: `in_progress`, target: `pnpm test` }, false);
        expect(element.querySelector(`[data-spin]`)).toBeNull();
        expect(element.querySelector(`[data-icon="clock"]`)).not.toBeNull();
        expect(element.textContent).toContain(`interrupted`);
    });

    it(`freezes a sub-agent's nested calls with the delegation that holds them`, () => {
        const element = mount(
            {
                id: `a1`,
                name: `Agent`,
                category: `other`,
                status: `in_progress`,
                children: [{ id: `b1`, name: `Bash`, category: `execute`, status: `in_progress`, target: `ls` }],
            },
            false,
        );
        expect(element.querySelector(`[data-spin]`)).toBeNull();
    });
});
