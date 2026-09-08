import { useQueryClient } from "@tanstack/vue-query";
import { sleep } from "@intentic/base/async";
import { errorMessage } from "@intentic/ui/async";
import { computed, markRaw, reactive, ref } from "vue";
import { detectProjects, managerFromPackageJson, type ProjectSetup } from "@intentic/workspace-setup";
import { collectDroppedFiles, type DroppedFile, isRootGitPath } from "../explorer/transfer/dropEntries";
import { packTar } from "../explorer/transfer/tarStream";
import { sandboxJson, sandboxUpload } from "../../sandbox/client/sandboxClient";
import { jsonBody } from "../../sandbox/client/jsonBody";
import { WORKSPACE_TREE } from "../../../lib/queryKeys";
import { chunkItems, dedupeByPath } from "./uploadChunking";

// Workspace upload queue: drops and picks append to a shared queue rather than clobbering an in-flight upload.
// Per-file transport is a bounded XHR pool (HTTP/1.1 and HTTP/2); large trees stream as one tar instead, falling
// back to the pool once that's proven unavailable.

type FileStatus = "queued" | "uploading" | "done" | "failed";
export interface QueueFile {
    readonly path: string; // root-relative destination (targetDir already joined in)
    readonly size: number;
    status: FileStatus;
    error?: string;
    readonly file: File;
}

const TAR_THRESHOLD = 20;
const POOL_SIZE = 5;

// Each chunk gets its own stall watchdog and retry, so one bad chunk can't freeze or fail the whole drop.
const RETRY_ATTEMPTS = 4;
const RETRY_BASE_MS = 1000;
// Aborts a stalled tar chunk (no bytes for this long) so it retries; separate from XHR's UPLOAD_STALL_MS.
const TAR_STALL_MS = 60_000;

// Optimistic; flips false once proven unavailable (HTTP/1.1), and stays false for the session.
let canStreamRequestBody = true;

const files = ref<QueueFile[]>([]);
const bytesTotal = ref(0);
const bytesDone = ref(0);
const currentName = ref("");
const finished = ref(false);
const startedAt = ref(0);

// Pre-upload tree walk; scanning narrates progress until every overlapping scan (activeScans) finishes.
const scanning = ref(false);
const scannedCount = ref(0);
const scanningName = ref("");
let activeScans = 0;

// Set when a drop produced no files (unreadable items or an empty folder), so the panel can say so.
const skippedNotice = ref<number | undefined>(undefined);

// Files skipped as identical on the sandbox (size + mtime); shown so nothing looks silently dropped.
const skippedUnchanged = ref(0);

const joinPath = (dir: string, rel: string): string => (dir === `` ? rel : `${dir}/${rel}`);

// Projects detected in the drop, offered for install; dirs are workspace-root-relative already.
const setupProjects = ref<readonly ProjectSetup[]>([]);

const INSTALL_PREF_KEY = `intentic.install-on-import`;
// Sticky default rather than a separate "always" toggle; the last choice predicts better than a fixed one, and
// a wrong "yes" is a cancellable install while a wrong "no" silently leaves the workspace unset up.
const readInstallPreference = (): boolean => {
    try {
        return localStorage.getItem(INSTALL_PREF_KEY) !== `never`;
    } catch {
        return true;
    }
};
const installAfterUpload = ref(readInstallPreference());
const setInstallAfterUpload = (enabled: boolean): void => {
    installAfterUpload.value = enabled;
    try {
        localStorage.setItem(INSTALL_PREF_KEY, enabled ? `always` : `never`);
    } catch {
        // Storage unavailable (private mode); the choice still holds for this session.
    }
};

// What the daemon actually queued (the client's list is only a guess); installSettled gates dismissal.
const installQueued = ref<readonly string[]>([]);
const installError = ref<string | undefined>(undefined);
const installSettled = ref(false);

// Reads each detected project's package.json for `packageManager`; that beats any lockfile guess since the File
// is already on hand. A missing or unreadable manifest leaves the lockfile answer standing.
const detectSetup = async (targetDir: string, entries: readonly DroppedFile[]): Promise<readonly ProjectSetup[]> => {
    const paths = entries.map((entry) => entry.path);
    const fields = new Map<string, string>();
    await Promise.all(
        detectProjects(paths).map(async ({ dir }) => {
            const manifest = entries.find((entry) => entry.path === (dir === `` ? `package.json` : `${dir}/package.json`));
            if (manifest === undefined) {
                return;
            }
            const manager = managerFromPackageJson(await manifest.file.text().catch(() => ``));
            if (manager !== undefined) {
                fields.set(dir, manager);
            }
        }),
    );
    // Reprojects onto the workspace root so `dir` is what the daemon resolves, not the drop-relative path.
    return detectProjects(paths, fields).map((project) => ({ dir: joinPath(targetDir, project.dir), recipe: project.recipe }));
};

// Starts the install once bytes are down. Errors are reported, not thrown: an upload that succeeds but fails
// to install is still a successful import.
const runInstall = async (): Promise<void> => {
    const projects = setupProjects.value;
    if (!installAfterUpload.value || projects.length === 0) {
        installSettled.value = true;
        return;
    }
    try {
        const { queued } = await sandboxJson<{ queued: string[] }>(`/workspace/setup/install`, {
            method: `POST`,
            headers: { "content-type": `application/json` },
            body: JSON.stringify({ dirs: projects.map((project) => project.dir) }),
        });
        installQueued.value = queued;
    } catch (error) {
        installError.value = errorMessage(error, `Couldn't start the install.`);
    } finally {
        installSettled.value = true;
    }
};

const pending: QueueFile[][] = [];
let running = false;
let queryClient: ReturnType<typeof useQueryClient> | undefined;

// Threaded into the scan, XHR pool, and tar fetch; a run keeps its own captured signal across a reset.
let controller = new AbortController();

// Clears the queue and aborts anything in flight, then mints a fresh controller. Used for a fresh start, dismiss,
// and cancel alike; running/activeScans are left for the in-flight run/scan to settle once they observe the abort.
export const resetUploadQueue = (): void => {
    controller.abort();
    controller = new AbortController();
    files.value = [];
    bytesTotal.value = 0;
    bytesDone.value = 0;
    currentName.value = "";
    finished.value = false;
    startedAt.value = 0;
    scanning.value = false;
    scannedCount.value = 0;
    scanningName.value = "";
    skippedNotice.value = undefined;
    skippedUnchanged.value = 0;
    setupProjects.value = [];
    installQueued.value = [];
    installError.value = undefined;
    installSettled.value = false;
    pending.length = 0;
};

// Matches a repo's own .git: the directory, anything under it, or the file a worktree/submodule uses instead.
// Segment-wise, so `src/.gitignore` or `notes/git` don't match.
const isGitEntry = (path: string): boolean => path.split(`/`).includes(`.git`);

// Sum of bytes for files marked done. Recomputed on a retry reset so a failed attempt's partial bytes don't
// linger; live onProgress deltas add on top between calls.
const recomputeBytesDone = (): void => {
    bytesDone.value = files.value.reduce((sum, file) => sum + (file.status === `done` ? file.size : 0), 0);
};

// Asks the daemon which dropped files are already identical (size + mtime) so a re-drop only sends what changed.
// Any error returns everything unfiltered; dedup must never block or drop an upload.
const filterUnchanged = async (targetDir: string, entries: readonly DroppedFile[]): Promise<readonly DroppedFile[]> => {
    try {
        const stats = entries.map((entry) => ({ path: joinPath(targetDir, entry.path), size: entry.file.size, mtime: entry.file.lastModified }));
        const { skip } = await sandboxJson<{ skip: string[] }>(`/workspace/upload-diff`, jsonBody(`POST`, { files: stats }));
        if (skip.length === 0) {
            return entries;
        }
        const skipSet = new Set(skip);
        return entries.filter((entry) => !skipSet.has(joinPath(targetDir, entry.path)));
    } catch {
        return entries;
    }
};

// Uploads one file via XHR with a plain File body (streams from disk, works on HTTP/1.1 and HTTP/2). onProgress
// reports cumulative bytes; only the delta since the last event is added to the aggregate.
const uploadOneXhr = (item: QueueFile, signal: AbortSignal): Promise<void> => {
    let last = 0;
    return sandboxUpload(`/workspace/upload?path=${encodeURIComponent(item.path)}&mtime=${item.file.lastModified}`, item.file, {
        signal,
        onProgress: (loaded) => {
            bytesDone.value += loaded - last;
            last = loaded;
        },
    });
};

// Bounded-concurrency per-file upload (POOL_SIZE at once). A failed file is recorded and skipped; the rest keeps
// going. On cancel, workers stop pulling without marking the in-flight file failed.
const uploadParallel = async (items: readonly QueueFile[], signal: AbortSignal): Promise<void> => {
    let next = 0;
    const worker = async (): Promise<void> => {
        for (let item = items[next++]; item !== undefined; item = items[next++]) {
            if (signal.aborted) {
                return;
            }
            // A retry pass re-runs the chunk; files already landed on an earlier attempt are skipped.
            if (item.status === `done`) {
                continue;
            }
            item.status = `uploading`;
            currentName.value = item.path;
            try {
                await uploadOneXhr(item, signal);
                item.status = `done`;
            } catch (error) {
                if (signal.aborted) {
                    return;
                }
                item.status = `failed`;
                item.error = errorMessage(error, `Upload failed.`);
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(POOL_SIZE, items.length) }, worker));
};

// Streams one bounded chunk as a tar (fetch streaming body, HTTP/2 only); packTar walks items in order, so
// onFileStart's count indexes the chunk. A private AbortController also races a stall watchdog (TAR_STALL_MS).
// Returns:
// - done: the chunk landed.
// - fallback: the browser refused a streaming body (HTTP/1.1); caller falls back to the XHR pool.
// - failed: a stall or a genuine mid-stream/daemon error; caller retries the chunk.
const uploadViaTar = async (items: readonly QueueFile[], signal: AbortSignal): Promise<"done" | "fallback" | "failed"> => {
    const control = new AbortController();
    const onOuterAbort = (): void => control.abort();
    signal.addEventListener(`abort`, onOuterAbort, { once: true });
    let stall: ReturnType<typeof setTimeout> | undefined;
    const arm = (): void => {
        clearTimeout(stall);
        stall = setTimeout(() => control.abort(), TAR_STALL_MS);
    };
    let index = -1;
    let streamed = 0;
    const body = packTar(
        items.map((item) => ({ file: item.file, path: item.path })),
        {
            onFileStart: (path) => {
                index += 1;
                const current = items[index];
                if (current !== undefined) {
                    current.status = `uploading`;
                }
                currentName.value = path;
            },
            onBytes: (delta) => {
                streamed += delta;
                bytesDone.value += delta;
                arm();
            },
        },
    );
    arm();
    try {
        await sandboxJson<{ ok: true }>(`/workspace/upload-archive`, { method: `POST`, body, duplex: `half`, signal: control.signal } as RequestInit);
        for (const item of items) {
            item.status = `done`;
        }
        return `done`;
    } catch (error) {
        // A real user cancel, not the watchdog; leave statuses alone.
        if (signal.aborted) {
            return `done`;
        }
        // No bytes streamed + a TypeError means HTTP/1.1 refused the body; reset to queued for the XHR fallback.
        if (streamed === 0 && error instanceof TypeError) {
            canStreamRequestBody = false;
            for (const item of items) {
                if (item.status === `uploading`) {
                    item.status = `queued`;
                }
            }
            return `fallback`;
        }
        // Stall or a real error: record it for the give-up message, but leave status alone; a retry resends the chunk.
        for (const item of items) {
            if (item.status !== `done`) {
                item.error = errorMessage(error, `Upload failed.`);
            }
        }
        return `failed`;
    } finally {
        clearTimeout(stall);
        signal.removeEventListener(`abort`, onOuterAbort);
    }
};

// Uploads one bounded chunk with retry and exponential backoff. Each attempt resends the whole chunk (idempotent);
// after RETRY_ATTEMPTS, whatever hasn't landed is marked failed.
const uploadChunk = async (chunk: readonly QueueFile[], signal: AbortSignal): Promise<void> => {
    for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
        if (signal.aborted) {
            return;
        }
        if (attempt > 0) {
            // Reset everything not confirmed landed, drop the failed attempt's partial byte progress, then back off.
            for (const item of chunk) {
                if (item.status !== `done`) {
                    item.status = `queued`;
                    item.error = undefined;
                }
            }
            recomputeBytesDone();
            await sleep(RETRY_BASE_MS * 2 ** (attempt - 1), { signal });
            if (signal.aborted) {
                return;
            }
        }
        if (chunk.length > TAR_THRESHOLD && canStreamRequestBody) {
            const result = await uploadViaTar(chunk, signal);
            if (result === `done` || signal.aborted) {
                return;
            }
            if (result === `failed`) {
                continue;
            }
            // "fallback" means HTTP/1.1: fall through to the per-file pool for this chunk, and later ones via the flag.
        }
        await uploadParallel(chunk, signal);
        if (signal.aborted || chunk.every((item) => item.status === `done`)) {
            return;
        }
    }
    // Retries exhausted: fail whatever never landed, keeping the last real error message where present.
    for (const item of chunk) {
        if (item.status !== `done`) {
            item.status = `failed`;
            item.error ??= `Upload failed after ${RETRY_ATTEMPTS} attempts.`;
        }
    }
};

const run = async (): Promise<void> => {
    if (running) {
        return;
    }
    running = true;
    finished.value = false;
    if (startedAt.value === 0) {
        startedAt.value = performance.now();
    }
    // This run's own captured signal; a mid-run reset swaps the module controller, not this loop's copy.
    const signal = controller.signal;
    try {
        while (pending.length > 0) {
            if (signal.aborted) {
                break;
            }
            const batch = pending.shift() as QueueFile[];
            // Uploads in bounded chunks retried independently, so a stall or reset costs one chunk, not the whole drop.
            for (const chunk of chunkItems(batch)) {
                if (signal.aborted) {
                    break;
                }
                await uploadChunk(chunk, signal);
            }
        }
    } finally {
        // Always clears running, even on a throw, so the queue can't wedge; work queued during the unwind keeps going.
        running = false;
        if (!controller.signal.aborted && pending.length > 0) {
            void run();
        } else if (!signal.aborted) {
            finished.value = true;
            // `.every`, not a single scope: a drop can land files outside the focused scope, so every variant is stale.
            await queryClient?.invalidateQueries({ queryKey: WORKSPACE_TREE.every });
            // Runs after the tree refresh and after the abort check, so a cancelled drop installs nothing.
            await runInstall();
        }
    }
};

export function useUploadQueue() {
    queryClient = useQueryClient();

    // Adds a drop/pick to the queue and (re)starts the worker. targetDir is baked into each file's path here, so
    // the transports below don't need to thread it separately.
    const enqueue = async (targetDir: string, dropped: readonly DroppedFile[]): Promise<void> => {
        // Filtered out before project detection or the diff manifest, so the root's own .git never reaches either.
        const entries = dropped.filter((entry) => !isRootGitPath(joinPath(targetDir, entry.path)));
        if (entries.length === 0) {
            // A bare `.git` drop on the root leaves nothing to send; say so, since the scan already narrated a file
            // count.
            if (dropped.length > 0 && !running && pending.length === 0) {
                skippedNotice.value = dropped.length;
                finished.value = true;
            }
            return;
        }
        // A finished-and-untouched queue starts fresh on the next drop.
        if (finished.value && !running) {
            resetUploadQueue();
        }
        // Detected before the unchanged-file filter prunes the usually-unchanged manifests; dedupe by dir across drops.
        const detected = await detectSetup(targetDir, entries);
        const known = new Set(setupProjects.value.map((project) => project.dir));
        setupProjects.value = [...setupProjects.value, ...detected.filter((project) => !known.has(project.dir))];
        // Capture the signal before the round-trip, so a cancel during it aborts the enqueue too.
        const signal = controller.signal;
        const unchanged = await filterUnchanged(targetDir, entries);
        if (signal.aborted) {
            return;
        }
        // Two entries can target the same destination; keep only the last, or parallel writes interleave into one file.
        const surviving = dedupeByPath(unchanged, (entry) => entry.path);
        // Sinks .git entries to the back (stable sort) so the daemon doesn't see a repo before its work tree lands.
        surviving.sort((left, right) => (isGitEntry(left.path) ? 1 : 0) - (isGitEntry(right.path) ? 1 : 0));
        skippedUnchanged.value += entries.length - surviving.length;
        if (surviving.length === 0) {
            // Drop already fully up to date; surface via skippedUnchanged rather than a silent no-op.
            if (!running && pending.length === 0) {
                finished.value = true;
                // Still offer install: re-dropping an up-to-date project is exactly what someone does when it isn't
                // working.
                await runInstall();
            }
            return;
        }
        // markRaw the File so Vue doesn't proxy it; .stream() throws on a reactive proxy of a File.
        const items = surviving.map((entry): QueueFile =>
            reactive({ path: joinPath(targetDir, entry.path), size: entry.file.size, status: `queued`, file: markRaw(entry.file) }),
        );
        files.value.push(...items);
        bytesTotal.value += items.reduce((sum, item) => sum + item.size, 0);
        pending.push(items);
        void run();
    };

    // Drop-target entry point: shows the panel immediately, walks the tree with streaming progress, then hands the
    // files to enqueue. Must call collectDroppedFiles synchronously, before the drag store tears down.
    const enqueueFromDataTransfer = (targetDir: string, dataTransfer: DataTransfer): void => {
        if (finished.value && !running && activeScans === 0) {
            resetUploadQueue();
        }
        // Captures this session's signal so a cancel during the walk stops it and skips the enqueue.
        const signal = controller.signal;
        activeScans += 1;
        scanning.value = true;
        finished.value = false;
        skippedNotice.value = undefined;
        collectDroppedFiles(
            dataTransfer,
            (path) => {
                scannedCount.value += 1;
                scanningName.value = path;
            },
            signal,
        )
            .then((result) => {
                if (signal.aborted) {
                    return;
                }
                void enqueue(targetDir, result.files);
                // Only set when nothing was uploaded; a drop that did yield files ignores stray skips.
                if (result.files.length === 0) {
                    skippedNotice.value = result.skipped;
                }
            })
            .catch((error: unknown) => console.error(`Failed to read the dropped items`, error))
            .finally(() => {
                activeScans -= 1;
                if (activeScans === 0) {
                    scanning.value = false;
                }
            });
    };

    const failedCount = computed(() => files.value.filter((file) => file.status === `failed`).length);
    const doneCount = computed(() => files.value.filter((file) => file.status === `done`).length);
    const throughput = computed(() => {
        const elapsed = (performance.now() - startedAt.value) / 1000;
        return elapsed > 0 ? bytesDone.value / elapsed : 0;
    });

    return {
        files,
        bytesTotal,
        bytesDone,
        currentName,
        finished,
        scanning,
        scannedCount,
        scanningName,
        skippedNotice,
        skippedUnchanged,
        failedCount,
        doneCount,
        throughput,
        setupProjects,
        installAfterUpload,
        setInstallAfterUpload,
        installQueued,
        installError,
        installSettled,
        enqueue,
        enqueueFromDataTransfer,
        dismiss: resetUploadQueue,
    };
}
