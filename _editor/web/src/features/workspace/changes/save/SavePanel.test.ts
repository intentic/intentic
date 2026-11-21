// jsdom because the subject is what the maker's list prints for a folder of thousands of build files, and what it does
// while the daemon says a discard is running. Only a render can tell the sentences apart.
import "@intentic/testing/dom";
import type { GitChanges } from "@intentic/sandbox-contract/schemas/git/git";
import { IconStub } from "@intentic/ui/testing";
import { VueQueryPlugin } from "@tanstack/vue-query";
import PrimeVue from "primevue/config";
import { type App, createApp, h, nextTick } from "vue";
import { workspaceView } from "../../../../app/workspaceScope";
import { queryClient } from "../../../../lib/queryPersistence";
import { router } from "../../../../router";
import { signalConnection } from "../../../../client/sandbox/useSandbox";
import { registry } from "../../../../models/fleet/useAgents-registry";
import { useChanges } from "../../../../models/changes/useChanges";
import * as actualSandboxRpc from "../../../../client/sandbox/sandboxRpc";
import { fakeSandboxRpc } from "../../../../testing/sandboxRpcFake";

// `git.changes` is handed out a request at a time; every other procedure throws naming itself.
const held: ((response: GitChanges) => void)[] = [];
const changes = jest.fn(() => new Promise<GitChanges>((resolve) => held.push(resolve)));
const discard = jest.fn(() => Promise.resolve({ ok: true as const }));
const realSandboxRpc = { ...actualSandboxRpc };
jest.mock("../../../../client/sandbox/sandboxRpc", () => ({ ...realSandboxRpc, sandboxRpc: fakeSandboxRpc({ git: { changes, viewChanges: changes, discard } }) }));

const { default: SavePanel } = await import("./SavePanel.vue");

let app: App | undefined;

const mount = async (): Promise<HTMLElement> => {
    signalConnection({ kind: `switched`, lastKnownOnline: true });
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ setup: () => () => h(SavePanel) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.use(router);
    app.use(VueQueryPlugin, { queryClient });
    app.use(PrimeVue);
    app.mount(el);
    await nextTick();
    return el;
};

const settle = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
};
const answer = async (response: GitChanges): Promise<void> => {
    held.shift()?.(response);
    await settle();
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    queryClient.clear();
    held.length = 0;
    workspaceView.value = {};
    registry.value = [];
    discard.mockClear();
});

const labelled = (label: string): HTMLButtonElement | undefined =>
    [...document.body.querySelectorAll<HTMLButtonElement>(`button`)].find((button) => button.getAttribute(`aria-label`) === label);

// 4,992 files under build/: one listed besides src/app.ts, the rest cut by the daemon's own budget.
const tree = (extra: Partial<GitChanges> = {}): GitChanges => ({
    repos: [
        {
            repo: `root`,
            branch: `main`,
            conflicted: [],
            staged: [],
            unstaged: [
                { path: `src/app.ts`, status: `modified` },
                { path: `build/a.wasm`, status: `added` },
            ],
            truncated: { staged: 0, unstaged: 4990 },
            scratch: [{ path: `build/`, reason: `bulk`, files: 4992, bytes: Math.round(1.2 * 1024 ** 3) }],
        },
    ],
    ...extra,
});

it(`lists a scratch folder as one row, and Save carries only what it records`, async () => {
    const el = await mount();
    await answer(tree());
    const text = el.textContent ?? ``;
    expect(text).toContain(`4,992 files · 1.2 GB`);
    expect(text).toContain(`Too large to save with your changes`);
    expect(text).not.toContain(`a.wasm`);
    expect(labelled(`Save 1 change`)).toBeInstanceOf(HTMLButtonElement);
});

it(`asks with the folder's count and size, then deletes exactly its path`, async () => {
    await mount();
    await answer(tree());
    labelled(`Delete build/`)?.click();
    await settle();
    expect(document.body.textContent).toContain(`Delete 4,992 files (1.2 GB) in build/?`);
    // The card's own press, which carries no label of its own: the row's Delete is the one named for its folder.
    [...document.body.querySelectorAll<HTMLButtonElement>(`button:not([aria-label])`)].find((button) => button.textContent?.trim() === `Delete`)?.click();
    await settle();
    expect(discard).toHaveBeenCalledTimes(1);
    expect(discard).toHaveBeenCalledWith({ repo: `root`, paths: [`build/`] }, { context: { gitView: {} } });
});

it(`says a discard the daemon reports, after a reload, and holds Save and Delete`, async () => {
    const el = await mount();
    await answer(tree({ discarding: [`root`] }));
    expect(el.textContent).toContain(`Discarding… (taking a restore point first)`);
    expect(labelled(`Delete build/`)?.disabled).toBe(true);
    expect(labelled(`Save 1 change`)?.disabled).toBe(true);
    await useChanges().discardGroups([{ repo: `root`, paths: [`build/`] }]);
    expect(discard).not.toHaveBeenCalled();
});
