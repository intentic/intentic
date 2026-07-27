// @vitest-environment jsdom
//
// jsdom because the whole point of this card is what it RENDERS: a sub-agent (Agent/Task) delegation nests its
// own tool calls and thinking UNDER the card (ChatToolCard renders itself recursively), so the run reads as one
// unit instead of a flat sibling list with a lone spinner stranded above it. Recursion that fails to resolve
// draws nothing and throws nothing — only a mounted render catches it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, h } from "vue";
import type { ChatTool } from "../composables/chat/conversation";

// ChatToolCard's import chain pulls in app-wide singletons that read browser/runtime globals at import time:
// @intentic-app/ui's useDevice reads window.matchMedia (its device refs are module-level), and environment.ts
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
const mount = (tool: ChatTool): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(ChatToolCard, { tool }) });
    // Icon is registered app-wide in the real app; v-tooltip is PrimeVue's directive. No-op stand-ins keep the
    // test off the whole UI plugin — neither the glyph nor the tooltip content is what's under test.
    app.component(`Icon`, { render: () => null });
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
            children: [{ id: `b1`, name: `Bash`, category: `execute`, status: `completed`, target: `ls -la`, content: [{ type: `text`, text: `file.txt` }] }],
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
});
