// @vitest-environment jsdom
//
// jsdom because the whole point of this card is what it RENDERS: a sub-agent (Agent/Task) delegation nests its
// own tool calls and thinking UNDER the card (ChatToolCard renders itself recursively), so the run reads as one
// unit instead of a flat sibling list with a lone spinner stranded above it. Recursion that fails to resolve
// draws nothing and throws nothing — only a mounted render catches it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h } from "vue";
import type { ChatTool } from "../composables/chat/transcript";

// ChatToolCard's import chain pulls in app-wide singletons that read browser/runtime globals at import time:
// @intentic/ui's useDevice reads window.matchMedia (its device refs are module-level), and environment.ts
// reads window.env (set by env.js before the app in the real page). jsdom provides neither, so both are stood up
// in vi.hoisted — which runs before the imports evaluate — mirroring what the real page sets up.
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

const { default: ChatToolCard } = await import("./ChatToolCard.vue");

let app: App | undefined;
const mount = (tool: ChatTool, live = true): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(ChatToolCard, { tool, live }) });
    // Icon and v-tooltip are both registered app-wide by installUi. Stand-ins keep the test
    // off the whole UI plugin. Icon renders which glyph it was handed (and whether it spins), because that IS
    // what the liveness rule below decides; the tooltip's content is not under test.
    app.component(
        `Icon`,
        defineComponent({
            props: { name: String, spin: Boolean },
            render() {
                return h(`i`, { "data-icon": this.name, class: this.spin ? `animate-spin` : undefined });
            },
        }),
    );
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
        // A running Agent card starts expanded (live output is the point), so its nested transcript is visible.
        const element = mount({
            id: `a1`,
            name: `Agent`,
            category: `other`,
            status: `in_progress`,
            thinking: `weighing the options`,
            children: [
                { id: `b1`, name: `Bash`, category: `execute`, status: `completed`, target: `ls -la`, content: [{ type: `text`, text: `file.txt` }] },
            ],
        });

        // The child's own card rendered — proof the recursive <ChatToolCard> reference resolved.
        const nested = element.querySelector(`.border-l`);
        expect(nested).not.toBeNull();
        expect(nested?.textContent).toContain(`Bash`);
        expect(nested?.textContent).toContain(`ls -la`);
        // The sub-agent's thinking rides on the card, not the parent turn.
        expect(element.textContent).toContain(`weighing the options`);
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
            target: `update /history/worktrees/very-long-worktree-name/intentic/_apps/web/src/chat/ChatToolCard.vue`,
        });
        const name = element.querySelector(`span.font-medium`)!;

        // Chat messages inherit `overflow-wrap: anywhere`. The name therefore needs both a non-shrinking
        // header boundary and an explicit no-wrap rule; the adjacent target owns all width compression.
        expect(name.parentElement?.classList).toContain(`shrink-0`);
        expect(name.parentElement?.classList).toContain(`whitespace-nowrap`);
        expect(name.parentElement?.nextElementSibling?.classList).toContain(`min-w-0`);
        expect(name.parentElement?.nextElementSibling?.classList).toContain(`truncate`);
    });

    it(`spins a call in flight while its turn is live`, () => {
        const element = mount({ id: `t1`, name: `Bash`, category: `execute`, status: `in_progress`, target: `pnpm test` });
        expect(element.querySelector(`[data-icon="spinner"]`)).not.toBeNull();
        expect(element.querySelector(`.animate-spin`)).not.toBeNull();
    });

    it(`freezes a call the turn never finished — no animation on a transcript that is only a record`, () => {
        // How a stopped turn (and a session restored from disk with no tool_result) reads back: still
        // `in_progress`, but nothing will ever move it, so an animation there claims work that is not happening.
        const element = mount({ id: `t1`, name: `Bash`, category: `execute`, status: `in_progress`, target: `pnpm test` }, false);
        expect(element.querySelector(`.animate-spin`)).toBeNull();
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
        expect(element.querySelector(`.animate-spin`)).toBeNull();
    });
});
