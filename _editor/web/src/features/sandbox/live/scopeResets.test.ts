import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import type { AgentSummary } from "@intentic/sandbox-contract";
import { VueQueryPlugin } from "@tanstack/vue-query";
import { afterEach, beforeEach, expect, it, mock } from "bun:test";
import { createApp, effectScope, nextTick, ref } from "vue";
import { activeSandboxId } from "../overview/activeSandbox";
import { fakeSandboxRpc } from "../../../testing/sandboxRpcFake";

// What each door into a new sandbox scope starts over, read off the stores themselves rather than the primitive: a
// workspace replaced under the same sandbox id (the hello) and a switch to another sandbox (sandboxScope.ts). The
// sandboxes' own reads answer with nothing; the stores, the hello and the switch are the real ones.

mock.module("../../../router", () => ({ router: { push: mock() } }));
mock.module("../../../app/analytics", () => ({ track: mock() }));
const reachable = ref(false);
mock.module("../client/useSandbox", () => ({ useSandbox: () => ({ activeSandboxId, reachable }) }));
mock.module("../client/sandboxRpc", () => ({
    sandboxRpc: fakeSandboxRpc({
        agents: { list: async () => ({ agents: [], rev: 0, held: [] }), archived: async () => ({ agents: [], rev: 0, held: [] }) },
    }),
}));

const { queryClient } = await import("../../../lib/queryPersistence");
const { applySystemEvent } = await import("./systemEvents");
await import("../client/sandboxScope");
const { useChat } = await import("../../chat/run/useChat");
const { useEditBuffers } = await import("../../workspace/files/useEditBuffers");
const { useWorkspaceTree } = await import("../../workspace/explorer/useWorkspaceTree");
const { useWorkspaceTabs } = await import("../../workspace/tabs/useWorkspaceTabs");
const { useHome } = await import("../../workspace/home/useHome");
const { useLayout } = await import("../../../shell/window/useLayout");
const { changeEpochOf, markWorkspaceChanged } = await import("../../workspace/changes/live/useWorkspaceLive");
const { markPreviewOpened, previewOpened } = await import("../../preview/previewSurface");
const { presenceOthers, setPresenceUsers } = await import("../../../shell/presence/usePresence");
const { useAgents } = await import("../../agents/fleet/useAgents");
const { archived, setAgents } = await import("../../agents/fleet/useAgents-registry");

const SANDBOX = `sbx-1`;
const hello = (workspaceId: string): void => applySystemEvent({ kind: `hello`, workspaceId, build: `build-1` }, SANDBOX);

// The composables that read the query client, run where a mounted surface would run them.
const app = createApp({});
app.use(VueQueryPlugin, { queryClient });
const scope = effectScope();
const tree = app.runWithContext(() => scope.run(() => useWorkspaceTree())!);

const agent = (id: string): AgentSummary => ({
    id,
    status: `idle`,
    provider: `claude`,
    harness: `native`,
    updatedAt: 1_000,
    attention: { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false },
});

// Every workspace store holding something of this sandbox's; the staged push is usePushFlow.test.ts's, whose seams it
// needs.
const fillWorkspace = (): void => {
    useChat().active.value.draft.value = `half a thought`;
    useEditBuffers().setBuffer(`src/app.ts`, `edited, unsaved`);
    tree.expanded.value = new Set([`src`]);
    tree.clipboard.value = { mode: `cut`, paths: [`src/app.ts`] };
    useWorkspaceTabs().openFile(`src/app.ts`);
    useHome().pick(`src`, `dir`);
    useLayout().setTerminalOpen(true);
    markWorkspaceChanged([`src/app.ts`]);
    markPreviewOpened();
};

// What each of those stores reads as now, in the order filled.
const workspaceReading = () => ({
    draft: useChat().active.value.draft.value,
    buffer: useEditBuffers().bufferOf(`src/app.ts`),
    expanded: [...tree.expanded.value],
    clipboard: tree.clipboard.value,
    tabs: useWorkspaceTabs().tabs.value.map((tab) => tab.id),
    home: useHome().homeDir.value,
    terminalOpen: useLayout().terminalOpen.value,
    changed: changeEpochOf(`src/app.ts`),
    preview: previewOpened.value,
});

beforeEach(async () => {
    activeSandboxId.value = SANDBOX;
    await nextTick();
    resetSandboxScope();
    localStorage.clear();
    hello(`workspace-1`);
});

afterEach(() => {
    activeSandboxId.value = undefined;
});

it(`starts every workspace store over when the workspace is replaced under the same sandbox id`, () => {
    fillWorkspace();
    const filled = workspaceReading();

    hello(`workspace-2`);

    expect(filled).toEqual({
        draft: `half a thought`,
        buffer: `edited, unsaved`,
        expanded: [`src`],
        clipboard: { mode: `cut`, paths: [`src/app.ts`] },
        tabs: [`src/app.ts`],
        home: `src`,
        terminalOpen: true,
        changed: 1,
        preview: true,
    });
    expect(workspaceReading()).toEqual({
        draft: ``,
        buffer: undefined,
        expanded: [],
        clipboard: undefined,
        tabs: [],
        home: ``,
        terminalOpen: false,
        changed: 0,
        preview: false,
    });
});

// The same workspace answering again is a reconnect, not a new machine: nothing in view is thrown away.
it(`keeps them through a hello from the same workspace`, () => {
    fillWorkspace();
    const filled = workspaceReading();

    hello(`workspace-1`);

    expect(workspaceReading()).toEqual(filled);
});

it(`starts presence, the fleet and the archive over on a switch`, async () => {
    setPresenceUsers([{ clientId: `c-2`, email: `maya@example.com`, name: `Maya`, role: `writer`, idle: false }]);
    setAgents([agent(`a1`)], 1);
    archived.value = [{ ...agent(`old`), open: false, unread: false, unsent: false }];
    const filled = {
        present: presenceOthers.value.map((member) => member.email),
        fleet: useAgents()
            .fleet.value.filter((card) => card.status !== `draft`)
            .map((card) => card.id),
        archived: archived.value.map((card) => card.id),
    };

    activeSandboxId.value = `sbx-2`;
    await nextTick();

    expect(filled).toEqual({ present: [`maya@example.com`], fleet: [`a1`], archived: [`old`] });
    expect({
        present: presenceOthers.value.map((member) => member.email),
        fleet: useAgents()
            .fleet.value.filter((card) => card.status !== `draft`)
            .map((card) => card.id),
        archived: archived.value.map((card) => card.id),
    }).toEqual({ present: [], fleet: [], archived: [] });
});
