import { useQueryClient } from "@tanstack/vue-query";
import { sleep } from "@intentic/base/async";
import { isBrowsableArchive } from "@intentic/sandbox-contract";
import { errorMessage } from "@intentic/ui/async";
import { sandboxRef, sandboxScopeGuard, sandboxValue } from "@intentic/extension-api";
import { computed, markRaw, reactive, ref } from "vue";
import { detectProjects, managerFromPackageJson, type ProjectSetup } from "@intentic/workspace-setup";
import { collectDroppedFiles, type DroppedFile, isRootGitPath } from "../../explorer/transfer/dropEntries";
import { packTar } from "../../explorer/transfer/tarStream";
import { sandboxJson, sandboxUpload } from "../../../sandbox/client/sandboxClient";
import { jsonBody } from "../../../sandbox/client/jsonBody";
import { sandboxRpc } from "../../../sandbox/client/sandboxRpc";
import { rpcPrefix } from "../../../../lib/queryKeys";
import { workspaceAgent } from "../../health/workspaceScope";
import { chunkItems, dedupeByPath } from "./uploadChunking";
import { clearUnsettledUploads, markFailed, markSettled, noteArriving } from "../provisionalEntries";

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

// One upload session per sandbox: the bytes go into that sandbox's /work, so a switch starts the card over.
const files = sandboxRef<QueueFile[]>(() => []);
const bytesTotal = sandboxRef(() => 0);
const bytesDone = sandboxRef(() => 0);
const currentName = sandboxRef(() => ``);
const finished = sandboxRef(() => false);
const startedAt = sandboxRef(() => 0);

// Pre-upload tree walk; scanning narrates progress until every overlapping scan (activeScans) finishes.
const scanning = sandboxRef(() => false);
const scannedCount = sandboxRef(() => 0);
const scanningName = sandboxRef(() => ``);
let activeScans = 0;

// Set when a drop produced no files (unreadable items or an empty folder), so the panel can say so.
const skippedNotice = sandboxRef<number | undefined>(() => undefined);

// Files skipped as identical on the sandbox (size + mtime); shown so nothing looks silently dropped.
const skippedUnchanged = sandboxRef(() => 0);

const joinPath = (dir: string, rel: string): string => (dir === `` ? rel : `${dir}/${rel}`);

// Unpacks a just-landed zip or tar ahead of the first click on it. The listing request IS the unpack, so this is the
// same call the home would make, made early and thrown away; a failure here costs nothing, since the home's own call
// will report it when someone actually opens the archive.
const warmArchive = (path: string): void => {
    if (!isBrowsableArchive(path.slice(path.lastIndexOf(`/`) + 1))) {
        return;
    }
    void sandboxRpc.workspace.children({ path, agent: workspaceAgent.value }).catch(() => undefined);
};

// The one place a file's status moves, so the explorer's placeholder row for it can't drift from the card's counts.
// `queued` covers a retry resetting a file that a previous attempt already reported on.
const setStatus = (item: QueueFile, status: FileStatus): void => {
    item.status = status;
    if (status === `done`) {
        markSettled(item.path);
        warmArchive(item.path);
    } else if (status === `failed`) {
        markFailed(item.path);
    } else if (status === `queued`) {
        noteArriving(item.path, { kind: `upload`, size: item.size });
    }
};

// Projects detected in the drop, offered for install; dirs are workspace-root-relative already.
const setupProjects = sandboxRef<readonly ProjectSetup[]>(() => []);

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
// allow(module-state): a preference persisted per browser, the same whichever sandbox is open
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
const installQueued = sandboxRef<readonly string[]>(() => []);
const installError = sandboxRef<string | undefined>(() => undefined);
const installSettled = sandboxRef(() => false);

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
    // An answer arriving after a switch is about the box left behind, whose import this view no longer shows.
    const current = sandboxScopeGuard();
    try {
        const { queued } = await sandboxRpc.workspace.install({ dirs: projects.map((project) => project.dir) });
        if (current()) {
            installQueued.value = queued;
        }
    } catch (error) {
        if (current()) {
            installError.value = errorMessage(error, `Couldn't start the install.`);
        }
    } finally {
        if (current()) {
            installSettled.value = true;
        }
    }
};

// Drops waiting behind the one uploading, oldest first.
const pending = sandboxValue<QueueFile[][]>(() => []);
let running = false;
let queryClient: ReturnType<typeof useQueryClient> | undefined;

// Threaded into the scan, XHR pool, and tar fetch; a run keeps its own captured signal across a restart. A switch
// aborts it, since the bytes in flight are bound for the sandbox being left.
const controller = sandboxValue(
    () => new AbortController(),
    (previous) => previous.abort(),
);

// Clears the queue and aborts anything in flight, then mints a fresh controller. Used for a fresh start, dismiss,
// and cancel alike; running/activeScans are left for the in-flight run/scan to settle once they observe the abort.
const restartQueue = (): void => {
    controller.value.abort();
    controller.value = new AbortController();
    // Placeholder rows for bytes that never landed go with the queue; ones already on disk stay until the tree lists
    // them, since the row is the only sign of them until it does.
    clearUnsettledUploads();
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
    pending.value = [];
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
            setStatus(item, `uploading`);
            currentName.value = item.path;
            try {
                await uploadOneXhr(item, signal);
                setStatus(item, `done`);
            } catch (error) {
                if (signal.aborted) {
                    return;
                }
                setStatus(item, `failed`);
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
// - fallback: the browser refused a streaming body (HTTP/1.1), or a file couldn't be read; caller falls back to the
//   XHR pool, which fails an unreadable file alone.
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
    // The archive died on this browser's side, so it says nothing about whether the transport can stream.
    let unreadable = false;
    const body = packTar(
        items.map((item) => ({ file: item.file, path: item.path })),
        {
            onFileStart: (path) => {
                index += 1;
                const current = items[index];
                if (current !== undefined) {
                    setStatus(current, `uploading`);
                }
                currentName.value = path;
            },
            onBytes: (delta) => {
                streamed += delta;
                bytesDone.value += delta;
                arm();
            },
            onUnreadable: (path, error) => {
                unreadable = true;
                console.warn(`upload: ${path} failed its archive`, error);
            },
        },
    );
    arm();
    try {
        await sandboxJson<{ ok: true }>(`/workspace/upload-archive`, { method: `POST`, body, duplex: `half`, signal: control.signal } as RequestInit);
        for (const item of items) {
            setStatus(item, `done`);
        }
        return `done`;
    } catch (error) {
        // A real user cancel, not the watchdog; leave statuses alone.
        if (signal.aborted) {
            return `done`;
        }
        // No bytes streamed + a TypeError means HTTP/1.1 refused the body; an unreadable file fails only this archive.
        // Either way the chunk resets to queued for the XHR pool, which fails an unreadable file on its own.
        if (unreadable || (streamed === 0 && error instanceof TypeError)) {
            if (!unreadable) {
                canStreamRequestBody = false;
            }
            for (const item of items) {
                if (item.status === `uploading`) {
                    setStatus(item, `queued`);
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
    // Once an archive fell back, this chunk stays on the per-file pool: re-packing it would resend what already landed.
    let archive = true;
    for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
        if (signal.aborted) {
            return;
        }
        if (attempt > 0) {
            // Reset everything not confirmed landed, drop the failed attempt's partial byte progress, then back off.
            for (const item of chunk) {
                if (item.status !== `done`) {
                    setStatus(item, `queued`);
                    item.error = undefined;
                }
            }
            recomputeBytesDone();
            await sleep(RETRY_BASE_MS * 2 ** (attempt - 1), { signal });
            if (signal.aborted) {
                return;
            }
        }
        if (archive && chunk.length > TAR_THRESHOLD && canStreamRequestBody) {
            const result = await uploadViaTar(chunk, signal);
            if (result === `done` || signal.aborted) {
                return;
            }
            if (result === `failed`) {
                continue;
            }
            // "fallback" (HTTP/1.1, or a file the archive could not read): the per-file pool takes this chunk, and later
            // ones via the flag when the transport refused; the archive's streamed bytes are not the pool's progress.
            archive = false;
            recomputeBytesDone();
        }
        await uploadParallel(chunk, signal);
        if (signal.aborted || chunk.every((item) => item.status === `done`)) {
            return;
        }
    }
    // Retries exhausted: fail whatever never landed, keeping the last real error message where present.
    for (const item of chunk) {
        if (item.status !== `done`) {
            setStatus(item, `failed`);
            item.error ??= `Upload failed after ${RETRY_ATTEMPTS} attempts.`;
        }
    }
};

// Takes one batch into the queue and starts the worker. Placeholder rows go in before the first byte moves, so the
// explorer shows where the drop landed while the daemon's own listing (a walk of the whole workspace) is seconds away.
const queueBatch = (items: QueueFile[]): void => {
    for (const item of items) {
        noteArriving(item.path, { kind: `upload`, size: item.size });
    }
    files.value.push(...items);
    bytesTotal.value += items.reduce((sum, item) => sum + item.size, 0);
    pending.value.push(items);
    void run();
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
    // This run's own captured signal; a mid-run restart swaps the module controller, not this loop's copy.
    const { signal } = controller.value;
    try {
        while (pending.value.length > 0) {
            if (signal.aborted) {
                break;
            }
            const batch = pending.value.shift() as QueueFile[];
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
        if (!controller.value.signal.aborted && pending.value.length > 0) {
            void run();
        } else if (!signal.aborted) {
            finished.value = true;
            // Every scope's tree, not the focused one: a drop can land files outside that scope, so every variant is stale.
            await queryClient?.invalidateQueries({ queryKey: rpcPrefix(`workspace.tree`) });
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
            if (dropped.length > 0 && !running && pending.value.length === 0) {
                skippedNotice.value = dropped.length;
                finished.value = true;
            }
            return;
        }
        // A finished-and-untouched queue starts fresh on the next drop.
        if (finished.value && !running) {
            restartQueue();
        }
        // Captured before either round trip, so a cancel or a switch (which aborts it) during one aborts the enqueue too.
        const { signal } = controller.value;
        // Detected before the unchanged-file filter prunes the usually-unchanged manifests; dedupe by dir across drops.
        const detected = await detectSetup(targetDir, entries);
        const unchanged = await filterUnchanged(targetDir, entries);
        if (signal.aborted) {
            return;
        }
        const known = new Set(setupProjects.value.map((project) => project.dir));
        setupProjects.value = [...setupProjects.value, ...detected.filter((project) => !known.has(project.dir))];
        // Two entries can target the same destination; keep only the last, or parallel writes interleave into one file.
        const surviving = dedupeByPath(unchanged, (entry) => entry.path);
        // Sinks .git entries to the back (stable sort) so the daemon doesn't see a repo before its work tree lands.
        surviving.sort((left, right) => (isGitEntry(left.path) ? 1 : 0) - (isGitEntry(right.path) ? 1 : 0));
        skippedUnchanged.value += entries.length - surviving.length;
        if (surviving.length === 0) {
            // Drop already fully up to date; surface via skippedUnchanged rather than a silent no-op.
            if (!running && pending.value.length === 0) {
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
        queueBatch(items);
    };

    // Drop-target entry point: shows the panel immediately, walks the tree with streaming progress, then hands the
    // files to enqueue. Must call collectDroppedFiles synchronously, before the drag store tears down.
    const enqueueFromDataTransfer = (targetDir: string, dataTransfer: DataTransfer): void => {
        if (finished.value && !running && activeScans === 0) {
            restartQueue();
        }
        // Captures this session's signal so a cancel during the walk stops it and skips the enqueue.
        const { signal } = controller.value;
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
        dismiss: restartQueue,
    };
}
