// jsdom mounts a component so vue-query's injection is in place; the import graph reads browser globals at load.
import "@intentic/testing/dom";
import { WORKSPACE_ROOT } from "@intentic/constants";
import type { GitRemoteRepo } from "@intentic/sandbox-contract";
import { VueQueryPlugin } from "@tanstack/vue-query";
import { waitFor } from "@intentic/testing/bun";
import { createApp, defineComponent, h, ref } from "vue";
import { fakeSandboxRpc } from "../../../../testing/sandboxRpcFake";
import type { SandboxRpc } from "../../client/sandboxRpc";

// Every window's header holds this condition, so what it costs is a read per window: the tree is the whole workspace,
// refetched on every write burst, and it can only change the answer once no repository has a remote.

const remoteRepos = jest.fn<SandboxRpc[`git`][`remoteRepos`]>();
const tree = jest.fn<SandboxRpc[`workspace`][`tree`]>();
jest.mock("../../client/sandboxRpc", () => ({ sandboxRpc: fakeSandboxRpc({ git: { remoteRepos }, workspace: { tree } }) }));
// Every name the import graph takes from the raw client, since bun links an ESM import against exactly what this
// factory returns; nothing here calls it.
jest.mock("../../client/sandboxClient", () => ({
    sandboxJson: jest.fn(),
    sandboxRequest: jest.fn(),
    sandboxBlob: jest.fn(),
    sandboxUpload: jest.fn(),
    sandboxError: jest.fn(async () => new Error(`unused`)),
}));
jest.mock("../../client/useSandbox", () => ({
    sandboxKey: (...parts: unknown[]) => [...parts, `sbx-1`],
    useSandbox: () => ({ activeSandboxId: ref(`sbx-1`), reachable: ref(true) }),
}));

const { queryClient } = await import("../../../../lib/queryPersistence");
const { useUnbackedWork } = await import("./useUnbackedWork");

const REMOTE = { repo: `app`, host: `github.com`, project: `acme/app` };

// The daemon's two answers, and which reads were asked for, in order.
const daemon = (repos: GitRemoteRepo[]): string[] => {
    const asked: string[] = [];
    remoteRepos.mockImplementation(async () => {
        asked.push(`git.remoteRepos`);
        return { repos };
    });
    tree.mockImplementation(async () => {
        asked.push(`workspace.tree`);
        return { root: WORKSPACE_ROOT, tree: [{ path: `notes.md`, name: `notes.md`, type: `file` }], hidden: 0, barren: [] };
    });
    return asked;
};

const mounted = <T>(composable: () => T): T => {
    let result!: T;
    const app = createApp(
        defineComponent({
            setup() {
                result = composable();
                return () => h(`div`);
            },
        }),
    );
    app.use(VueQueryPlugin, { queryClient });
    app.mount(document.createElement(`div`));
    return result;
};

beforeEach(() => {
    queryClient.clear();
    remoteRepos.mockReset();
    tree.mockReset();
});

test(`never walks the tree while a repository has a remote`, async () => {
    const asked = daemon([REMOTE]);
    const { remotes, unbacked } = mounted(() => useUnbackedWork());

    await waitFor(() => expect(remotes.value).toEqual([REMOTE]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(asked).toEqual([`git.remoteRepos`]);
    expect(unbacked.value).toBe(false);
});

test(`reads the tree once no repository has a remote, and warns because files are there`, async () => {
    const asked = daemon([]);
    const { unbacked } = mounted(() => useUnbackedWork());

    await waitFor(() => expect(unbacked.value).toBe(true));
    expect(asked).toEqual([`git.remoteRepos`, `workspace.tree`]);
});
