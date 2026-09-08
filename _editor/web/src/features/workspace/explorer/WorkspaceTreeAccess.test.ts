// @vitest-environment jsdom
// jsdom: the subject is a keystroke and its answer, a refusal in words or silence. Tests what a
// member below the write tier sees in the explorer, not just the daemon's 403.
import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { VueQueryPlugin } from "@tanstack/vue-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick } from "vue";
import { IconStub } from "@intentic/ui/testing";

globalThis.Element.prototype.scrollIntoView = function scrollIntoView(): void {};

const SANDBOX = `sb-shared`;
localStorage.setItem(`intentic.activeSandboxId`, SANDBOX);

// Records daemon calls; a refused gesture must not reach the daemon at all, not just get a 403.
const daemon = vi.hoisted(() => ({ calls: [] as { path: string; init?: RequestInit }[] }));
vi.mock("../../sandbox/client/sandboxClient", async (importOriginal) => {
    const original = await importOriginal<typeof import("../../sandbox/client/sandboxClient")>();
    return {
        ...original,
        sandboxJson: async (path: string, init?: RequestInit): Promise<unknown> => {
            daemon.calls.push({ path, init });
            return { ok: true };
        },
    };
});

// Signed-in member's tier, switched per test; mocked directly since the subject is what the explorer does with it.
const role = vi.hoisted(() => ({ canShip: false }));
vi.mock("../../sandbox/secrets/useRole", async () => {
    const { computed } = await import("vue");
    return {
        useRole: () => ({
            role: computed(() => (role.canShip ? `maintainer` : `collaborator`)),
            canDrive: computed(() => true),
            canShip: computed(() => role.canShip),
            isOwner: computed(() => false),
        }),
    };
});

const { default: WorkspaceTree } = await import("./WorkspaceTree.vue");
const { resetWorkspaceTreeState, useWorkspaceTree } = await import("./useWorkspaceTree");
const { queryClient } = await import("../../../lib/queryPersistence");

const file = (path: string): WorkspaceTreeEntry => ({ name: path.slice(path.lastIndexOf(`/`) + 1), path, type: `file` });
const TREE: WorkspaceTreeEntry[] = [file(`README.md`), file(`notes.txt`)];

let app: App | undefined;
// Captured inside setup(): vue-query's client is injected, so the composable can't be called from the test body.
let feedback: ReturnType<typeof useWorkspaceTree> | undefined;

const mount = async (): Promise<HTMLElement> => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({
        setup() {
            feedback = useWorkspaceTree();
            return () => h(WorkspaceTree, { tree: TREE });
        },
    });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.use(VueQueryPlugin, { queryClient });
    app.mount(el);
    await nextTick();
    await nextTick();
    return el;
};

const rowFor = (el: HTMLElement, name: string): HTMLElement =>
    [...el.querySelectorAll(`[role="treeitem"]`)].find((row) => row.textContent?.includes(name)) as HTMLElement;

beforeEach(() => {
    role.canShip = false;
    daemon.calls.length = 0;
    sessionStorage.clear();
    resetWorkspaceTreeState();
});

afterEach(() => {
    app?.unmount();
    app = undefined;
});

it(`answers a read-only member's Delete with the tier, and asks the daemon nothing`, async () => {
    const el = await mount();
    const row = rowFor(el, `notes.txt`);
    row.click();
    await nextTick();
    row.dispatchEvent(new KeyboardEvent(`keydown`, { key: `Delete`, bubbles: true }));
    await nextTick();

    expect(daemon.calls.filter((call) => call.init?.method === `DELETE`)).toEqual([]);
    expect(document.body.textContent).not.toContain(`Delete file?`);
    expect(feedback?.actionError.value?.title).toMatch(/maintainer access/i);
});

it(`does not open the rename field for a read-only member`, async () => {
    const el = await mount();
    const row = rowFor(el, `notes.txt`);
    row.click();
    await nextTick();
    row.dispatchEvent(new KeyboardEvent(`keydown`, { key: `F2`, bubbles: true }));
    await nextTick();

    expect(el.querySelector(`input`)).toBeNull();
    expect(feedback?.actionError.value?.title).toMatch(/maintainer access/i);
});

it(`lets the operating tier through unchanged`, async () => {
    role.canShip = true;
    const el = await mount();
    const row = rowFor(el, `notes.txt`);
    row.click();
    await nextTick();
    row.dispatchEvent(new KeyboardEvent(`keydown`, { key: `F2`, bubbles: true }));
    await nextTick();

    expect(el.querySelector(`input`)).not.toBeNull();
    expect(feedback?.actionError.value).toBeUndefined();
});
