import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import { waitFor } from "@intentic/testing/bun";
import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { createApp, defineComponent, h } from "vue";
import { fakeSandboxRpc } from "../../../../testing/sandboxRpcFake";

// Pins which calls a drop makes beside its writes: a sandbox's daemon is asked what is unchanged, takes a big drop as
// one archive and installs the projects in it; a folder on this computer (the desktop app's sidecar) serves none of
// those, so its drop is the writes alone.

const sandboxJson = jest.fn((path: string, init?: RequestInit) =>
    Promise.resolve(path === `/workspace/upload-diff` ? { skip: [] } : { ok: true as const, method: init?.method }),
);
const sandboxUpload = jest.fn((path: string, body: Blob, options?: { readonly signal?: AbortSignal }) => Promise.resolve(void [path, body, options]));
jest.mock(`../../../sandbox/client/sandboxClient`, () => ({
    sandboxJson,
    sandboxUpload,
    sandboxRequest: () => Promise.reject(new Error(`sandboxRequest is not this suite's`)),
    sandboxError: (response: Response) => new Error(String(response.status)),
    sandboxBlob: () => Promise.reject(new Error(`sandboxBlob is not this suite's`)),
}));
const install = jest.fn((input: { readonly dirs: readonly string[] }) => Promise.resolve({ queued: [...input.dirs] }));
jest.mock(`../../../sandbox/client/sandboxRpc`, () => ({ sandboxRpc: fakeSandboxRpc({ workspace: { install } }) }));

const { setDaemonRoutes } = await import(`../../../sandbox/overview/useDaemonRoutes`);
const { useUploadQueue } = await import(`./useUploadQueue`);

// The routes the sidecar's hello names for a folder window (local-files procedures.ts): the write, and no helper.
const FOLDER_ROUTES = [`POST /workspace/upload`, `GET /workspace/raw`, `workspace.tree`, `workspace.children`, `workspace.move`];

// A dropped project past the archive threshold: a manifest and 24 files beside it.
const PROJECT = [
    { path: `shop/package.json`, file: new File([`{"name":"shop"}`], `package.json`) },
    ...Array.from({ length: 24 }, (_, index) => ({ path: `shop/f${index}.txt`, file: new File([`f${index}`], `f${index}.txt`) })),
];

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
    app.use(VueQueryPlugin, { queryClient: new QueryClient() });
    app.mount(document.createElement(`div`));
    return result;
};

// The paths a drop asked the backend about, beside its per-file writes.
const helperCalls = (): string[] => [...sandboxJson.mock.calls.map(([path]) => path), ...install.mock.calls.map(() => `workspace.install`)];

beforeEach(() => {
    resetSandboxScope();
    sandboxJson.mockClear();
    sandboxUpload.mockClear();
    install.mockClear();
});

describe(`a drop`, () => {
    it(`onto a folder of this computer is its writes alone, every file one of them, and offers no install`, async () => {
        setDaemonRoutes(FOLDER_ROUTES, undefined, `folder`);
        const queue = mounted(() => useUploadQueue());
        await queue.enqueue(``, PROJECT);
        await waitFor(() => expect([queue.finished.value, queue.installSettled.value]).toEqual([true, true]), { timeout: 5_000 });
        expect([helperCalls(), sandboxUpload.mock.calls.length, queue.doneCount.value, queue.setupProjects.value]).toEqual([[], 25, 25, []]);
    });

    it(`onto a sandbox asks what is unchanged, sends the project as one archive and installs it`, async () => {
        setDaemonRoutes(undefined);
        const queue = mounted(() => useUploadQueue());
        queue.setInstallAfterUpload(true);
        await queue.enqueue(``, PROJECT);
        await waitFor(() => expect([queue.finished.value, queue.installSettled.value]).toEqual([true, true]), { timeout: 5_000 });
        expect([helperCalls(), sandboxUpload.mock.calls.length, install.mock.calls]).toEqual([
            [`/workspace/upload-diff`, `/workspace/upload-archive`, `workspace.install`],
            0,
            [[{ dirs: [`shop`] }]],
        ]);
    });
});
