// "Open file" for AGENTS.md went to /workspace/AGENTS.md whether or not the file existed, and a new user who had just
// found the Memory card landed on the workspace root with nothing open. Mounted, since what is under test is which
// action the card offers and what a press on it does.
import "@intentic/testing/dom";
import PrimeVue from "primevue/config";
import { type App, createApp, defineComponent, h, nextTick } from "vue";
import { IconStub } from "@intentic/ui/testing";
import * as uiOriginal from "@intentic/ui";
import * as vueRouterOriginal from "vue-router";

// The workspace's files: AGENTS.md absent (undefined) unless a test puts it there.
const files = new Map<string, string>();
const readFile = jest.fn(async (path: string) => files.get(path));
const saveText = jest.fn(async (path: string, text: string) => void files.set(path, text));
jest.mock(`../../../workspace/explorer/useWorkspaceTree`, () => ({ useWorkspaceTree: () => ({ readFile, saveText }) }));

const push = jest.fn();
jest.mock(`vue-router`, () => ({
    ...vueRouterOriginal,
    useRouter: () => ({ push }),
    RouterLink: defineComponent({
        props: { to: { type: String, required: true } },
        setup: (props, { slots }) => () => h(`a`, { href: props.to }, slots[`default`]?.()),
    }),
}));

// The document surface has its own suite; what it shows under itself (the note) is this card's.
jest.mock(`@intentic/ui`, () => ({
    ...uiOriginal,
    MarkdownDocument: defineComponent({
        props: { modelValue: String, stored: String, placeholder: String, label: String, editable: Boolean, saving: Boolean },
        setup: (_props, { slots }) => () => h(`div`, { class: `memory-doc` }, slots[`note`]?.()),
    }),
}));

const { default: AgentMemory } = await import("./AgentMemory.vue");

let app: App | undefined;
const mount = async (): Promise<HTMLElement> => {
    const host = document.createElement(`div`);
    document.body.append(host);
    app = createApp({ render: () => h(AgentMemory) });
    app.use(PrimeVue);
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(host);
    await new Promise((resolve) => setTimeout(resolve));
    await nextTick();
    return host;
};

afterEach(() => {
    files.clear();
    readFile.mockClear();
    saveText.mockClear();
    push.mockReset();
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

const buttonSaying = (text: string): HTMLButtonElement | undefined =>
    [...document.querySelectorAll(`button`)].find((button) => button.textContent?.includes(text));

it(`makes a missing AGENTS.md before opening it, and says it isn't there yet`, async () => {
    const el = await mount();

    expect(el.textContent).toContain(`doesn't exist yet`);
    expect(el.querySelector(`a[href="/workspace/AGENTS.md"]`)).toBeNull();
    buttonSaying(`Create file`)?.click();
    await new Promise((resolve) => setTimeout(resolve));

    expect(saveText).toHaveBeenCalledWith(`AGENTS.md`, ``);
    expect(push).toHaveBeenCalledWith(`/workspace/AGENTS.md`);
});

it(`opens an AGENTS.md that is there`, async () => {
    files.set(`AGENTS.md`, `Be brief.`);
    const el = await mount();

    expect(el.querySelector(`a[href="/workspace/AGENTS.md"]`)?.textContent).toContain(`Open file`);
    expect(buttonSaying(`Create file`)).toBeUndefined();
    expect(el.textContent).toContain(`at the workspace root`);
});
