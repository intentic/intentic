// The Memory group is a list of the AGENTS.md files the agent reads, read off the workspace tree, each opening its page
// beside Settings; writing the workspace's own when there is none, and bringing memory over, are its two actions.
// Mounted, since what is under test is what the group offers and where a press goes.
import "@intentic/testing/dom";
import PrimeVue from "primevue/config";
import { type App, computed, createApp, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";
import type { WorkspaceTreeEntry } from "@intentic/sandbox-contract/schemas/workspace/workspace-tree";

const tree = ref<readonly WorkspaceTreeEntry[]>([]);
const loaded = ref(true);
const files = new Map<string, string>();
const readFile = jest.fn(async (path: string) => files.get(path));
const saveText = jest.fn(async (path: string, text: string) => void files.set(path, text));
jest.mock(`../../../../models/workspace/tree/useWorkspaceTree`, () => ({
    useWorkspaceTree: () => ({ tree, hasSnapshot: computed(() => loaded.value), readFile, saveText }),
}));

const revealSideView = jest.fn();
jest.mock(`../../../../workbench/side/sideViews`, () => ({ revealSideView }));
jest.mock(`../../../../workbench/side/sideTabs`, () => ({ sideDocked: ref(true) }));

const { default: AgentMemory } = await import("./AgentMemory.vue");

const file = (path: string, size: number): WorkspaceTreeEntry => ({ name: `AGENTS.md`, path, type: `file`, size });

let app: App | undefined;
const mount = async (): Promise<HTMLElement> => {
    const host = document.createElement(`div`);
    document.body.append(host);
    app = createApp({ render: () => h(AgentMemory) });
    app.use(PrimeVue);
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(host);
    await nextTick();
    return host;
};

afterEach(() => {
    tree.value = [];
    loaded.value = true;
    files.clear();
    revealSideView.mockClear();
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

const buttonSaying = (text: string): HTMLButtonElement | undefined =>
    [...document.querySelectorAll(`button`)].find((button) => button.textContent?.includes(text));
const chips = (el: HTMLElement): string[] => [...el.querySelectorAll(`[data-memory-chip]`)].map((chip) => chip.textContent?.trim() ?? ``);

it(`shows the workspace's file and each folder's as chips, and opens one beside the section`, async () => {
    tree.value = [file(`AGENTS.md`, 400), { name: `shop`, path: `shop`, type: `dir`, children: [file(`shop/AGENTS.md`, 120)] }];
    const el = await mount();

    expect(chips(el)).toEqual([`AGENTS.md`, `shop`]);
    expect(el.textContent).toContain(`Every turn`);
    expect(el.textContent).toContain(`Turns inside`);
    expect(buttonSaying(`Write memory`)).toBeUndefined();

    el.querySelectorAll<HTMLButtonElement>(`[data-memory-chip]`)[1]?.click();
    expect(revealSideView).toHaveBeenCalledWith(`memory`, { path: `shop/AGENTS.md` }, { keep: false });
});

it(`offers to write the workspace's file when there is none, opening its empty page kept`, async () => {
    const el = await mount();

    expect(chips(el)).toEqual([]);
    expect(el.textContent).toContain(`Nothing yet`);
    expect(el.textContent).not.toContain(`Turns inside`);
    buttonSaying(`Write memory`)?.click();

    expect(revealSideView).toHaveBeenCalledWith(`memory`, { path: `AGENTS.md` }, { keep: true });
});

it(`does not call the file missing before the tree has answered`, async () => {
    loaded.value = false;
    const el = await mount();

    expect(el.textContent).not.toContain(`Nothing yet`);
    expect(buttonSaying(`Write memory`)).toBeUndefined();
});

it(`brings memory over from another assistant in a dialog, then opens the file it landed in`, async () => {
    files.set(`AGENTS.md`, `Be brief.`);
    const el = await mount();
    expect(el.textContent).not.toContain(`Paste its answer`);

    buttonSaying(`Import`)?.click();
    await nextTick();
    await nextTick();
    const links = [...document.querySelectorAll<HTMLAnchorElement>(`a[data-assistant]`)];
    expect(links.map((link) => link.textContent?.trim())).toEqual([`ChatGPT`, `Claude`, `Gemini`, `Grok`]);
    expect(links[0]?.href).toMatch(/^https:\/\/chatgpt\.com\/\?q=Export%20everything/u);
    expect(links.every((link) => link.target === `_blank` && link.rel.includes(`noopener`))).toBe(true);

    const field = document.querySelector<HTMLTextAreaElement>(`#memory-import-answer`);
    if (field === null) {
        throw new Error(`no answer field`);
    }
    field.value = `## About me\n\nWrites in Polish.`;
    field.dispatchEvent(new Event(`input`));
    await nextTick();
    buttonSaying(`Add to memory`)?.click();
    await new Promise((resolve) => setTimeout(resolve));
    await nextTick();

    expect(files.get(`AGENTS.md`)).toMatch(/^Be brief\.\n\n<!-- intentic:imported-memory:start -->\n## Imported memory\n\n## About me/u);
    expect(revealSideView).toHaveBeenCalledWith(`memory`, { path: `AGENTS.md` }, { keep: false });
});
