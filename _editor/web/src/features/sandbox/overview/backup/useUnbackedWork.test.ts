// jsdom mounts a component so vue-query's injection is in place; the import graph reads browser globals at load.
import "@intentic/testing/dom";
import { WORKSPACE_ROOT } from "@intentic/constants";
import type { GitRemoteRepo } from "@intentic/sandbox-contract";
import { VueQueryPlugin } from "@tanstack/vue-query";
import { waitFor } from "@intentic/testing/bun";
import { createApp, defineComponent, h, ref } from "vue";
import { fakeSandboxRpc } from "../../../../testing/sandboxRpcFake";
import type { SandboxRpc } from "../../../../client/sandbox/sandboxRpc";

// Every window's header holds this condition, so what it costs is a read per window: the tree is the whole workspace,
// refetched on every write burst, and it can only change the answer once no repository has a remote.

const remoteRepos = jest.fn<SandboxRpc[`git`][`remoteRepos`]>();
const tree = jest.fn<SandboxRpc[`workspace`][`tree`]>();
const log = jest.fn<SandboxRpc[`git`][`log`]>();
const changes = jest.fn<SandboxRpc[`git`][`changes`]>();
jest.mock("../../../../client/sandbox/sandboxRpc", () => ({
    sandboxRpc: fakeSandboxRpc({ git: { remoteRepos, log, changes }, workspace: { tree } }),
}));
// Every name the import graph takes from the raw client, since bun links an ESM import against exactly what this
// factory returns; nothing here calls it.
jest.mock("../../../../client/sandbox/sandboxClient", () => ({
    sandboxJson: jest.fn(),
    sandboxRequest: jest.fn(),
    sandboxBlob: jest.fn(),
    sandboxUpload: jest.fn(),
    sandboxError: jest.fn(async () => new Error(`unused`)),
}));
jest.mock("../../../../client/sandbox/useSandbox", () => ({
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
    log.mockReset();
    changes.mockReset();
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

// A brand-new hosted sandbox: the daemon's dotted state and the seeded starter site, one commit, no remote. Its owner,
// on a phone, was told their work had nowhere to go before they had sent a message (2026-10-06).
const SEED = {
    sha: `a`.repeat(40),
    short: `aaaaaaa`,
    parents: [],
    subject: `chore: starter site`,
    body: ``,
    author: `agent`,
    email: `a@b`,
    at: 0,
    refs: [],
    head: true,
};
const fresh = (more: boolean): string[] => {
    const asked = daemon([]);
    tree.mockImplementation(async () => {
        asked.push(`workspace.tree`);
        return {
            root: WORKSPACE_ROOT,
            tree: [
                { path: `.intentic`, name: `.intentic`, type: `dir` },
                { path: `site`, name: `site`, type: `dir` },
            ],
            hidden: 0,
            barren: [],
        };
    });
    log.mockImplementation(async () => {
        asked.push(`git.log`);
        return { repo: `site`, branch: `main`, commits: [SEED], hasMore: more };
    });
    changes.mockImplementation(async () => {
        asked.push(`git.changes`);
        return { repos: [] };
    });
    return asked;
};

test(`stays quiet on a fresh workspace, whose only content is the starter site it was seeded with`, async () => {
    const asked = fresh(false);
    const { unbacked } = mounted(() => useUnbackedWork());

    await waitFor(() => expect(asked).toContain(`git.log`));
    await waitFor(() => expect(asked).toContain(`git.changes`));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(unbacked.value).toBe(false);
});

test(`warns once the starter site has a commit past its seed, an agent's landed work`, async () => {
    fresh(true);
    const { unbacked } = mounted(() => useUnbackedWork());

    await waitFor(() => expect(unbacked.value).toBe(true));
});
