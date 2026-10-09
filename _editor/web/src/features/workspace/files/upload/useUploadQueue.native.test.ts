import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import { waitFor } from "@intentic/testing/bun";
import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { createApp, defineComponent, h } from "vue";
import { fakeSandboxRpc } from "../../../../testing/sandboxRpcFake";
import type { NativeDrop, NativeEvent } from "./nativeCopy";

// A big drop the desktop app copies itself: what the card counts from the app's reports, and the drop going back to
// the browser's upload when the app declines it.

const sandboxJson = jest.fn((path: string) => Promise.resolve(path === `/workspace/upload-diff` ? { skip: [] } : { ok: true as const }));
const sandboxUpload = jest.fn((path: string, body: Blob) => Promise.resolve(void [path, body]));
jest.mock(`../../../../client/sandbox/sandboxClient`, () => ({
    sandboxJson,
    sandboxUpload,
    sandboxRequest: () => Promise.reject(new Error(`sandboxRequest is not this suite's`)),
    sandboxError: (response: Response) => new Error(String(response.status)),
    sandboxBlob: () => Promise.reject(new Error(`sandboxBlob is not this suite's`)),
}));
const install = jest.fn((input: { readonly dirs: readonly string[] }) => Promise.resolve({ queued: [...input.dirs] }));
jest.mock(`../../../../client/sandbox/sandboxRpc`, () => ({ sandboxRpc: fakeSandboxRpc({ workspace: { install } }) }));

// The app, scripted: what it says to each drop handed to it.
let script: readonly NativeEvent[] | "declined" = `declined`;
const handed: { target: string }[] = [];
jest.mock(`./nativeCopy`, () => ({
    captureNativeDrop: (): NativeDrop => ({ files: [new File([`x`], `marketing`)], port: 28_123 }),
    copyNatively: async (_drop: NativeDrop, target: string, _signal: AbortSignal, onEvent: (event: NativeEvent) => void) => {
        handed.push({ target });
        if (script === `declined`) {
            return `declined` as const;
        }
        for (const event of script) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- the app's reports arrive one after another
            await Promise.resolve();
            onEvent(event);
        }
        return `handled` as const;
    },
}));

const { setDaemonRoutes } = await import(`../../../../client/sandbox/useDaemonRoutes`);
const { useUploadQueue } = await import(`./useUploadQueue`);

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

// A drop with no entries to walk: the browser's fallback uploads its flat file list.
const dropOf = (files: readonly File[]): DataTransfer => ({ items: [], files }) as unknown as DataTransfer;

const GB = 1024 ** 3;

beforeEach(() => {
    resetSandboxScope();
    setDaemonRoutes(undefined);
    jest.clearAllMocks();
    handed.length = 0;
});

describe(`a drop the desktop app copies itself`, () => {
    it(`is counted on the card from the app's own reports, through to a finish with its failures named`, async () => {
        script = [
            { kind: `received` },
            { kind: `scanning`, files: 40_000, bytes: 20 * GB, current: `marketing/films/a.mp4` },
            {
                kind: `copying`,
                files: 66_412,
                bytes: 30 * GB,
                unreadable: 2,
                manifests: [`marketing/site/package.json`],
                roots: [{ name: `marketing`, dir: true, files: 66_412, bytes: 30 * GB }],
            },
            { kind: `progress`, done: 30_000, doneBytes: 10 * GB, sentBytes: 11 * GB, failed: 0, current: `media/marketing/b.mp4`, roots: [{ done: 30_000, failed: 0 }] },
            {
                kind: `finished`,
                done: 66_411,
                doneBytes: 30 * GB - 10,
                sentBytes: 30 * GB - 10,
                failed: 1,
                roots: [{ done: 66_411, failed: 1 }],
                failures: [{ path: `media/marketing/locked.mov`, error: `The process cannot access the file` }],
            },
        ];
        const queue = mounted(() => useUploadQueue());
        queue.enqueueFromDataTransfer(`media`, dropOf([]));
        await waitFor(() => expect(queue.finished.value).toBe(true));
        expect([
            queue.scannedCount.value,
            queue.fileCount.value,
            queue.doneCount.value,
            queue.failedCount.value,
            queue.unreadableCount.value,
            queue.bytesDone.value,
            queue.groups.value,
            queue.failures.value,
            queue.setupProjects.value.map((project) => project.dir),
        ]).toEqual([
            66_412,
            66_412,
            66_411,
            1,
            2,
            30 * GB - 10,
            [{ name: `media/marketing`, total: 66_412, done: 66_411, failed: 1 }],
            [{ path: `media/marketing/locked.mov`, error: `The process cannot access the file` }],
            [`media/marketing/site`],
        ]);
        // Nothing went through the browser's upload.
        expect([handed, sandboxUpload.mock.calls.length]).toEqual([[{ target: `media` }], 0]);
    });

    it(`that stops short counts what it never reached as failed, and says why`, async () => {
        script = [
            { kind: `copying`, files: 100, bytes: GB, unreadable: 0, manifests: [], roots: [{ name: `marketing`, dir: true, files: 100, bytes: GB }] },
            { kind: `finished`, done: 40, doneBytes: GB / 2, sentBytes: GB / 2, failed: 0, roots: [{ done: 40, failed: 0 }], error: `Docker stopped the copy: no space left on device` },
        ];
        const queue = mounted(() => useUploadQueue());
        queue.setInstallAfterUpload(false);
        queue.enqueueFromDataTransfer(``, dropOf([]));
        await waitFor(() => expect(queue.finished.value).toBe(true));
        expect([queue.doneCount.value, queue.failedCount.value, queue.groups.value, queue.failures.value[0]]).toEqual([
            40,
            60,
            [{ name: `marketing`, total: 100, done: 40, failed: 60 }],
            { path: `/`, error: `Docker stopped the copy: no space left on device` },
        ]);
    });

    it(`goes back to the browser's upload when the app declines it, counted once`, async () => {
        script = `declined`;
        const queue = mounted(() => useUploadQueue());
        queue.setInstallAfterUpload(false);
        queue.enqueueFromDataTransfer(``, dropOf([new File([`hello`], `notes.md`)]));
        await waitFor(() => expect(queue.finished.value).toBe(true));
        expect([queue.scannedCount.value, queue.doneCount.value, sandboxUpload.mock.calls.map(([path]) => path.split(`?`)[0])]).toEqual([
            0,
            1,
            [`/workspace/upload`],
        ]);
    });
});
