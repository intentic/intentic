// The one surface that answers "what is this chat actually told". Two promises are pinned here: the list is the
// composition in the order the model reads it, and nothing is fetched until a reader asks — the payload is the whole
// prompt, and a transcript that opened one per pane would pay for it every time.
import "@intentic/testing/dom";
import type { ConversationPrompt } from "@intentic/sandbox-contract";
import { IconStub } from "@intentic/ui/testing";
import PrimeVue from "primevue/config";
import { test, expect, afterEach, mock } from "bun:test";
import { type App, createApp, h, ref, toValue } from "vue";
import ChatSystemPrompt from "./ChatSystemPrompt.vue";

const PROMPT: ConversationPrompt = {
    prompt: {
        at: Date.now() - 60_000,
        runtime: `claude-code`,
        mode: `intentic`,
        base: { kind: `intentic`, text: `You are an Intentic agent.` },
        sections: [
            { source: `guidance`, title: `How this sandbox asks agents to work`, text: `Search code with rg.` },
            { source: `field-notes`, title: `Field notes for this sandbox`, text: `## Field notes for this sandbox\n\npnpm's exit code lies here.` },
            {
                source: `memory`,
                title: `Standing instructions for this workspace`,
                text: `## Standing instructions for this workspace\n\nNo legacy support.`,
            },
        ],
    },
};

// The options the component handed the query layer, so the test can read the gate it set rather than the network it
// would have used.
let asked: { enabled?: unknown } | undefined;
const data = ref<ConversationPrompt | undefined>(undefined);

mock.module(`../../../sandbox/client/useSandboxQuery`, () => ({
    useSandboxQuery: (options: { enabled?: unknown }) => {
        asked = options;
        return {
            query: { data, isFetching: ref(false), isSuccess: ref(data.value !== undefined), refetch: mock() },
            error: ref(undefined),
        };
    },
}));
mock.module(`../../../sandbox/client/sandboxClient`, () => ({ sandboxJson: mock() }));

let app: App | undefined;

const mount = (): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(ChatSystemPrompt, { conversationId: `c-1` }) });
    app.use(PrimeVue);
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(element);
    return element;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    asked = undefined;
    data.value = undefined;
    document.body.innerHTML = ``;
});

test("nothing is read until the chip is pressed", async () => {
    const element = mount();
    expect(toValue(asked?.enabled)).toBe(false);
    element.querySelector(`button`)?.click();
    await Promise.resolve();
    expect(toValue(asked?.enabled)).toBe(true);
});

test("the base is the first row and the additions follow in the order they were sent", async () => {
    data.value = PROMPT;
    const element = mount();
    element.querySelector(`button`)?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The title alone: each row carries its size beside it, which is the subject of no assertion here.
    const rows = [...document.querySelectorAll(`[role="dialog"] button[aria-expanded] span:first-of-type`)].map((title) => title.textContent?.trim());
    expect(rows).toEqual([`Intentic's own prompt`, ...(PROMPT.prompt?.sections ?? []).map((section) => section.title)]);
});

test("a section's own heading is dropped from the reading and kept in what is copied", async () => {
    data.value = PROMPT;
    mount();
    document.querySelector<HTMLButtonElement>(`button`)?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const notes = [...document.querySelectorAll<HTMLButtonElement>(`[role="dialog"] button[aria-expanded]`)].find((row) =>
        row.textContent?.includes(`Field notes for this sandbox`),
    );
    notes?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const opened = document.querySelector(`[role="dialog"]`)?.textContent ?? ``;
    // The title is drawn once, by the row; the words under it are the section's own.
    expect(opened).toContain(`pnpm's exit code lies here.`);
    expect(opened.match(/Field notes for this sandbox/g)).toHaveLength(1);
});
