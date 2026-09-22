// jsdom mounts a component so vue-query's injection is in place; the import graph reads browser globals at load.
import "@intentic/testing/dom";
import { VueQueryPlugin } from "@tanstack/vue-query";
import { test, expect, beforeEach, mock } from "bun:test";
import { waitFor } from "@intentic/testing/bun";
import { createApp, defineComponent, h, ref } from "vue";

// Every window's header holds this condition, so what it costs is a read per window: the tree is the whole workspace,
// refetched on every write burst, and it can only change the answer once no repository has a remote.

const jsonMock = mock(async (_path: string): Promise<unknown> => ({}));
// Every name the import graph takes from the daemon client, since bun links an ESM import against exactly what this
// factory returns; only sandboxJson is called.
mock.module("../../client/sandboxClient", () => ({
    sandboxJson: (path: string) => jsonMock(path),
    sandboxRequest: mock(),
    sandboxRequestVia: mock(),
    sandboxJsonAt: mock(),
    sandboxJsonQuietly: mock(),
    sandboxJsonVia: mock(),
    sandboxBlob: mock(),
    sandboxUpload: mock(),
    sandboxError: mock(async () => new Error(`unused`)),
    SandboxHttpError: class SandboxHttpError extends Error {},
}));
mock.module("../../client/useSandbox", () => ({
    sandboxKey: (...parts: unknown[]) => [...parts, `sbx-1`],
    useSandbox: () => ({ activeSandboxId: ref(`sbx-1`), reachable: ref(true) }),
}));

const { queryClient } = await import("../../../../lib/queryPersistence");
const { useUnbackedWork } = await import("./useUnbackedWork");

const REMOTE = { repo: `app`, host: `github.com`, project: `acme/app` };

// The daemon's two answers, and which paths were asked.
const daemon = (repos: readonly unknown[]): string[] => {
    const asked: string[] = [];
    jsonMock.mockImplementation(async (path: string) => {
        asked.push(path.split(`?`)[0] ?? path);
        return path.startsWith(`/git/remote-repos`) ? { repos } : { root: `/work`, tree: [{ path: `notes.md`, name: `notes.md`, type: `file` }], hidden: 0 };
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
    jsonMock.mockReset();
});

test(`never walks the tree while a repository has a remote`, async () => {
    const asked = daemon([REMOTE]);
    const { remotes, unbacked } = mounted(() => useUnbackedWork());

    await waitFor(() => expect(remotes.value).toEqual([REMOTE]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(asked).toEqual([`/git/remote-repos`]);
    expect(unbacked.value).toBe(false);
});

test(`reads the tree once no repository has a remote, and warns because files are there`, async () => {
    const asked = daemon([]);
    const { unbacked } = mounted(() => useUnbackedWork());

    await waitFor(() => expect(unbacked.value).toBe(true));
    expect(asked).toEqual([`/git/remote-repos`, `/workspace/tree`]);
});
