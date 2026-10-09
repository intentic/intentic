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
const sandboxUpload = jest.fn((path: string, body: Blob, options?: { readonly signal?: AbortSignal; readonly whole?: boolean }) =>
    Promise.resolve(void [path, body, options]),
);
jest.mock(`../../../../client/sandbox/sandboxClient`, () => ({
    sandboxJson,
    sandboxUpload,
    sandboxRequest: () => Promise.reject(new Error(`sandboxRequest is not this suite's`)),
    sandboxError: (response: Response) => new Error(String(response.status)),
    sandboxBlob: () => Promise.reject(new Error(`sandboxBlob is not this suite's`)),
}));
const install = jest.fn((input: { readonly dirs: readonly string[] }) => Promise.resolve({ queued: [...input.dirs] }));
jest.mock(`../../../../client/sandbox/sandboxRpc`, () => ({ sandboxRpc: fakeSandboxRpc({ workspace: { install } }) }));

const { setDaemonRoutes } = await import(`../../../../client/sandbox/useDaemonRoutes`);
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
// Each write's route, without its query.
const writes = (): string[] => sandboxUpload.mock.calls.map(([path]) => path.split(`?`)[0] ?? path);

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
        expect([helperCalls(), writes(), queue.doneCount.value, queue.setupProjects.value]).toEqual([[], Array.from({ length: 25 }, () => `/workspace/upload`), 25, []]);
    });

    it(`onto a sandbox asks what is unchanged, sends the project as one archive and installs it`, async () => {
        setDaemonRoutes(undefined);
        const queue = mounted(() => useUploadQueue());
        queue.setInstallAfterUpload(true);
        await queue.enqueue(``, PROJECT);
        await waitFor(() => expect([queue.finished.value, queue.installSettled.value]).toEqual([true, true]), { timeout: 5_000 });
        expect([helperCalls(), writes(), sandboxUpload.mock.calls[0]?.[2]?.whole, install.mock.calls]).toEqual([
            [`/workspace/upload-diff`, `workspace.install`],
            [`/workspace/upload-archive`],
            true,
            [[{ dirs: [`shop`] }]],
        ]);
    });

    // 66,412 files is what the drop that froze a page and left its rows spinning held: queued in one call, the batch
    // overflowed Chromium's stack after its placeholder rows were already drawn. Bun's engine takes that call, so this
    // pins the scale rather than the overflow itself.
    it(`of 70,000 files queues them all, and the card counts every one in and out`, async () => {
        setDaemonRoutes(undefined);
        const queue = mounted(() => useUploadQueue());
        queue.setInstallAfterUpload(false);
        const many = Array.from({ length: 70_000 }, (_, index) => ({ path: `marketing/${index % 50}/clip-${index}.mp4`, file: new File([`x`], `clip-${index}.mp4`) }));
        await queue.enqueue(``, many);
        await waitFor(() => expect(queue.finished.value).toBe(true), { timeout: 20_000 });
        expect([queue.fileCount.value, queue.doneCount.value, queue.failedCount.value, queue.bytesDone.value, queue.groups.value]).toEqual([
            70_000,
            70_000,
            0,
            70_000,
            [{ name: `marketing`, total: 70_000, done: 70_000, failed: 0 }],
        ]);
        // Archives of at most 200 files each.
        expect(writes()).toEqual(Array.from({ length: 350 }, () => `/workspace/upload-archive`));
    });

    it(`whose archive fails sends that chunk file by file, and the card ends with every file landed once`, async () => {
        setDaemonRoutes(undefined);
        sandboxUpload.mockImplementationOnce(() => Promise.reject(new Error(`a file changed on disk`)));
        const queue = mounted(() => useUploadQueue());
        queue.setInstallAfterUpload(false);
        await queue.enqueue(``, PROJECT);
        await waitFor(() => expect(queue.finished.value).toBe(true), { timeout: 5_000 });
        expect([writes(), queue.doneCount.value, queue.failedCount.value, queue.bytesDone.value]).toEqual([
            [`/workspace/upload-archive`, ...Array.from({ length: 25 }, () => `/workspace/upload`)],
            25,
            0,
            PROJECT.reduce((sum, entry) => sum + entry.file.size, 0),
        ]);
    });

    it(`that cannot be queued says why on the card instead of leaving rows spinning`, async () => {
        setDaemonRoutes(undefined);
        const queue = mounted(() => useUploadQueue());
        const unreadable = { path: `broken.txt`, file: undefined as unknown as File };
        await queue.enqueue(``, [unreadable]);
        expect([queue.startError.value !== undefined, queue.fileCount.value, queue.preparing.value, writes()]).toEqual([true, 0, 0, []]);
    });
});
