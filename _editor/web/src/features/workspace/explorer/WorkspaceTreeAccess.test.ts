// jsdom: the subject is a keystroke and its answer, a refusal in words or silence. Tests what a
// member below the write tier sees in the explorer, not just the daemon's 403.
import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { VueQueryPlugin } from "@tanstack/vue-query";
import { it, expect, beforeEach, afterEach, mock } from "bun:test";
import { hoisted } from "@intentic/testing/bun";
import { type App, computed, createApp, h, nextTick } from "vue";
import { IconStub } from "@intentic/ui/testing";
import { ACTIVE_KEY, activeSandboxId } from "../../sandbox/overview/activeSandbox";
import * as actualSandboxRpc from "../../sandbox/client/sandboxRpc";
import type { ProcedureName } from "../../sandbox/client/sandboxRpc";
import { fakeSandboxRpc } from "../../../testing/sandboxRpcFake";

globalThis.Element.prototype.scrollIntoView = function scrollIntoView(): void {};

const SANDBOX = `sb-shared`;
localStorage.setItem(ACTIVE_KEY, SANDBOX);
// Written to the ref as well: it is read out of storage once, as its module is evaluated, which every
// static import below has already done by the time this line runs.
activeSandboxId.value = SANDBOX;

// Records daemon calls by procedure and input; a refused gesture must not reach the daemon at all, not just get a 403.
const daemon = hoisted(() => ({ calls: [] as { procedure: ProcedureName; input: unknown }[] }));
// Snapshotted before the mock replaces the module: a namespace is a live binding, so spreading it afterwards would
// spread the stand-in.
const realSandboxRpc = { ...actualSandboxRpc };
mock.module("../../sandbox/client/sandboxRpc", () => {
    return {
        ...realSandboxRpc,
        sandboxRpc: fakeSandboxRpc({
            workspace: {
                delete: async (input) => {
                    daemon.calls.push({ procedure: `workspace.delete`, input });
                    return { ok: true };
                },
            },
        }),
    };
});

// Signed-in member's tier, switched per test; mocked directly since the subject is what the explorer does with it.
// The tier that writes is `writer`, below the operating one: a collaborator is read-only in the tree.
const role = hoisted(() => ({ canWrite: false }));
mock.module("../../sandbox/secrets/useRole", () => {
    return {
        useRole: () => ({
            role: computed(() => (role.canWrite ? `writer` : `collaborator`)),
            canDrive: computed(() => true),
            canWrite: computed(() => role.canWrite),
            canShip: computed(() => false),
            isOwner: computed(() => false),
        }),
    };
});

const { default: WorkspaceTree } = await import("./WorkspaceTree.vue");
const { useWorkspaceTree } = await import("./useWorkspaceTree");
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
    role.canWrite = false;
    daemon.calls.length = 0;
    sessionStorage.clear();
    resetSandboxScope();
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

    expect(daemon.calls.filter((call) => call.procedure === `workspace.delete`)).toEqual([]);
    expect(document.body.textContent).not.toContain(`Delete file?`);
    expect(feedback?.actionError.value?.title).toMatch(/writer access/i);
});

it(`does not open the rename field for a read-only member`, async () => {
    const el = await mount();
    const row = rowFor(el, `notes.txt`);
    row.click();
    await nextTick();
    row.dispatchEvent(new KeyboardEvent(`keydown`, { key: `F2`, bubbles: true }));
    await nextTick();

    expect(el.querySelector(`input`)).toBeNull();
    expect(feedback?.actionError.value?.title).toMatch(/writer access/i);
});

it(`lets the writing tier through unchanged`, async () => {
    role.canWrite = true;
    const el = await mount();
    const row = rowFor(el, `notes.txt`);
    row.click();
    await nextTick();
    row.dispatchEvent(new KeyboardEvent(`keydown`, { key: `F2`, bubbles: true }));
    await nextTick();

    expect(el.querySelector(`input`)).not.toBeNull();
    expect(feedback?.actionError.value).toBeUndefined();
});
