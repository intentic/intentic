import { useQueryClient } from "@tanstack/vue-query";
import { computed, markRaw, reactive, ref } from "vue";
import { detectProjects, managerFromPackageJson, type ProjectSetup } from "@intentic/workspace-setup";
import { collectDroppedFiles, type DroppedFile, isRootGitPath } from "../../pages/workspace/dropEntries";
import { packTar } from "../../pages/workspace/tarStream";
import { sandboxJson, sandboxUpload } from "../sandbox/sandboxClient";
import { errorMessage } from "../useAsyncAction";
import { chunkItems, dedupeByPath } from "./uploadChunking";

// The workspace upload queue: drops (and file-input picks) funnel through here instead of a one-shot spinner, so a
// second drop while an upload runs just APPENDS to the queue rather than clobbering shared state (the old bug) —
// and every file gets a live per-file status the panel renders. Module-level so the drop targets, the button, and
// the progress panel all share one queue.
//
// Transport: per file, a bounded-concurrency pool of XHR POSTs with a plain File body (see sandboxUpload) — this
// streams from disk yet works on HTTP/1.1 AND HTTP/2, and gives real byte progress. As an OPTIMIZATION, a large
// tree (> TAR_THRESHOLD files) streams as ONE tar to /workspace/upload-archive — but that uses a fetch streaming
// request body, which the browser only allows over HTTP/2. So the tar is attempted while `canStreamRequestBody`
// holds; the first time it fails before sending a byte (HTTP/1.1), we flip the flag off and fall back to the XHR
// pool for that batch and every later one. Nothing is ever buffered, so a multi-GB file or tree stays flat in memory.

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

// Reliability knobs for large drops. A drop uploads as bounded CHUNKS (chunkItems), each its own request with its
// own stall watchdog and retry, so one hung file or stalled hop can't freeze (or fail) the whole tree — only its
// chunk. The size caps live in uploadChunking.ts (pure, unit-checked).
const RETRY_ATTEMPTS = 4;
const RETRY_BASE_MS = 1000;
// ponytail: abort a tar chunk that emits no bytes for this long (a hung file read or a stalled hop) so it retries
// instead of freezing forever. Mirrors the XHR path's UPLOAD_STALL_MS (sandboxClient.ts); independent knob.
const TAR_STALL_MS = 60_000;

// Optimistic: attempt the streaming tar until proven unavailable (HTTP/1.1). Session-scoped, not reset per drop.
let canStreamRequestBody = true;

const files = ref<QueueFile[]>([]);
const bytesTotal = ref(0);
const bytesDone = ref(0);
const currentName = ref("");
const finished = ref(false);
const startedAt = ref(0);

// The pre-upload phase: walking the dropped folder tree (which can take a while for a big repo). Surfaced so the
// panel narrates "Scanning… N files" the instant of the drop, before any upload can start. `activeScans` counts
// overlapping drops so `scanning` only clears once the last walk finishes.
const scanning = ref(false);
const scannedCount = ref(0);
const scanningName = ref("");
let activeScans = 0;

// A drop that produced no files (only symlinks/special items Chrome can't read, or an empty folder). Surfaced so
// the panel says "Nothing to upload — skipped N item(s)" instead of a frozen spinner or dead silence.
const skippedNotice = ref<number | undefined>(undefined);

// Files a re-drop skipped because they were already identical on the sandbox (same size + mtime, per upload-diff).
// Surfaced so a re-upload visibly re-sends only what changed instead of silently doing less than the file count.
const skippedUnchanged = ref(0);

const joinPath = (dir: string, rel: string): string => (dir === `` ? rel : `${dir}/${rel}`);

// ---- dependency install (see @intentic/workspace-setup) ----
// A drop omits node_modules/.venv on purpose, so what lands is a project that can't build, test or type-check
// yet. Rather than leave that for the user to hit later — or spring a dialog before the upload they already
// asked for — the manager is detected from the dropped FILE NAMES at scan time, and the offer rides the
// progress panel for the whole upload. By the time it could run, the user has had the entire upload to
// uncheck it. Dirs here are workspace-root-relative (targetDir already joined in), ready to POST.
const setupProjects = ref<readonly ProjectSetup[]>([]);

const INSTALL_PREF_KEY = `intentic.install-on-import`;
// Sticky default rather than a second "always" control: a 320px panel can't afford two checkboxes, and the last
// choice is a better predictor than any fixed default. Starts ON — dragging a project in almost always means
// "I want to work on this", and a wrong yes costs a cancellable install in a visible terminal, where a wrong no
// costs a workspace that silently lies to both the user and the agent.
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
        // Storage unavailable (private mode) — the choice still holds for this session.
    }
};

// What the daemon actually started. The client's list is only a pre-upload GUESS (the browser can't see what is
// already installed on the sandbox), so the daemon re-resolves it and installs only what genuinely needs it —
// which is what makes a re-drop of a ready project a silent no-op. `installSettled` gates the panel's dismiss
// so a clean finish can't disappear before saying what it kicked off.
const installStarted = ref<readonly string[]>([]);
const installError = ref<string | undefined>(undefined);
const installSettled = ref(false);

// Read each detected project's package.json for its `packageManager` declaration — the corepack field beats any
// lockfile, and we have the File in hand, so the guess costs one small read per project. A missing or unreadable
// manifest just leaves the lockfile answer standing.
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
    // Re-project onto the workspace root so `dir` is what the daemon will resolve, not what the drop was
    // relative to. A drop onto a subfolder lands its project there.
    return detectProjects(paths, fields).map((project) => ({ dir: joinPath(targetDir, project.dir), recipe: project.recipe }));
};

// Kick off the install once the bytes are down. Never blocks or fails the upload — a workspace that uploaded
// fine but couldn't start its install is still a successful import, so the error is reported, not thrown.
const runInstall = async (): Promise<void> => {
    const projects = setupProjects.value;
    if (!installAfterUpload.value || projects.length === 0) {
        installSettled.value = true;
        return;
    }
    try {
        const { started } = await sandboxJson<{ started: string[] }>(`/workspace/setup/install`, {
            method: `POST`,
            headers: { "content-type": `application/json` },
            body: JSON.stringify({ dirs: projects.map((project) => project.dir) }),
        });
        installStarted.value = started;
    } catch (error) {
        installError.value = errorMessage(error, `Couldn't start the install.`);
    } finally {
        installSettled.value = true;
    }
};

const pending: QueueFile[][] = [];
let running = false;
let queryClient: ReturnType<typeof useQueryClient> | undefined;

// One AbortController per upload session — its signal is threaded into the scan walk, the per-file XHRs, and the
// tar fetch. Aborting it (via resetUploadQueue, which cancel + dismiss both call) stops everything in flight; a
// still-unwinding run() keeps its OWN captured signal, so replacing the controller here can't corrupt it.
let controller = new AbortController();

// Clear the queue AND abort anything in flight (the scan, the XHR pool, the tar request), then mint a fresh
// controller for the next drop. Serves three roles: fresh-start reset, the panel's dismiss, and cancel. Does NOT
// touch `running`/`activeScans` — the in-flight run()/scan own those and settle themselves once their (now aborted)
// signal is observed.
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
    installStarted.value = [];
    installError.value = undefined;
    installSettled.value = false;
    pending.length = 0;
};

// A repo's own git metadata: the `.git` directory itself, anything under it, or the `.git` FILE a worktree or
// submodule checkout carries instead of a directory. Segment-wise, so a `src/.gitignore` or `notes/git` can't match.
const isGitEntry = (path: string): boolean => path.split(`/`).includes(`.git`);

// Aggregate progress = the bytes of every file that has actually landed. Recomputed when a chunk is reset for a
// retry so the failed attempt's partial bytes don't linger and double-count; the live onBytes deltas add on top.
const recomputeBytesDone = (): void => {
    bytesDone.value = files.value.reduce((sum, file) => sum + (file.status === `done` ? file.size : 0), 0);
};

// Ask the daemon which of these dropped files are already identical on the sandbox (same size + mtime) so we can
// SKIP re-uploading them — a re-drop then sends only what changed. Returns the entries that still need uploading.
// On ANY error, returns them ALL: the dedup is an optimization and must never block or silently drop an upload.
const filterUnchanged = async (targetDir: string, entries: readonly DroppedFile[]): Promise<readonly DroppedFile[]> => {
    try {
        const stats = entries.map((entry) => ({ path: joinPath(targetDir, entry.path), size: entry.file.size, mtime: entry.file.lastModified }));
        const { skip } = await sandboxJson<{ skip: string[] }>(`/workspace/upload-diff`, {
            method: `POST`,
            headers: { "content-type": `application/json` },
            body: JSON.stringify({ files: stats }),
        });
        if (skip.length === 0) {
            return entries;
        }
        const skipSet = new Set(skip);
        return entries.filter((entry) => !skipSet.has(joinPath(targetDir, entry.path)));
    } catch {
        return entries;
    }
};

// A cancelable delay (retry backoff). Resolves early if the signal aborts, so a cancel never waits out the backoff.
const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
        if (signal.aborted) {
            resolve();
            return;
        }
        const timer = setTimeout(resolve, ms);
        signal.addEventListener(
            `abort`,
            () => {
                clearTimeout(timer);
                resolve();
            },
            { once: true },
        );
    });

// Upload one file via XHR with a plain File body — works on HTTP/1.1 and HTTP/2, streams from disk, real progress.
// onProgress reports the file's CUMULATIVE bytes, so we add only the delta since the last event to the aggregate.
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

// Bounded-concurrency per-file upload — POOL_SIZE files in flight at once. A failed file is recorded and skipped;
// the rest of the batch still uploads. On cancel (signal aborted) the workers stop pulling and DON'T mark the
// aborted in-flight file as failed.
const uploadParallel = async (items: readonly QueueFile[], signal: AbortSignal): Promise<void> => {
    let next = 0;
    const worker = async (): Promise<void> => {
        for (let item = items[next++]; item !== undefined; item = items[next++]) {
            if (signal.aborted) {
                return;
            }
            // A retry pass re-runs the whole chunk; files that already landed on an earlier attempt are skipped.
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

// Stream one bounded chunk as a tar (fetch streaming body — HTTP/2 only). packTar walks items IN ORDER, so
// onFileStart's call count indexes the chunk for the live "currently landing" line. Returns:
//   "done"     — the chunk landed; every item marked done.
//   "fallback" — the browser refused a streaming body (HTTP/1.1, no h2): the caller uses the per-file XHR pool.
//   "failed"   — a stall (watchdog aborted) or a genuine mid-stream/daemon error: the caller retries the chunk.
// A private AbortController links the run's signal AND a stall watchdog: no byte progress for TAR_STALL_MS aborts
// the request, so a hung read or stalled hop retries instead of freezing the whole drop. Status is only ever set
// to "uploading" until the request fully succeeds — a failed attempt never leaves a file falsely marked landed.
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
        // A real user cancel (not the stall watchdog) → leave statuses; the queue is being torn down anyway.
        if (signal.aborted) {
            return `done`;
        }
        // Rejected before any byte streamed + a TypeError = the browser refused a streaming body (HTTP/1.1, no h2).
        // Reset the optimistic status and tell the caller to use the XHR pool (this chunk and, via the flag, later).
        if (streamed === 0 && error instanceof TypeError) {
            canStreamRequestBody = false;
            for (const item of items) {
                if (item.status === `uploading`) {
                    item.status = `queued`;
                }
            }
            return `fallback`;
        }
        // A stall-abort or a genuine mid-stream/daemon error. Record the reason for the retry wrapper's give-up
        // message but don't mark done or failed — a retry re-sends the whole chunk.
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

// Upload one bounded chunk with retry + exponential backoff. Each attempt re-sends the whole chunk (idempotent
// writes; already-landed files are skipped by the pool and re-sent harmlessly by the tar). A stall or transient
// failure retries; a real user cancel bails immediately; after RETRY_ATTEMPTS the still-unlanded files are failed
// — so a persistently-bad chunk costs only its own files, and the rest of the drop still completes.
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
            await sleep(RETRY_BASE_MS * 2 ** (attempt - 1), signal);
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
            // "fallback": HTTP/1.1 — fall through to the per-file pool (this chunk, and later ones via the flag).
        }
        await uploadParallel(chunk, signal);
        if (signal.aborted || chunk.every((item) => item.status === `done`)) {
            return;
        }
    }
    // Retries exhausted: fail whatever never landed, keeping the last real error message where we have one.
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
    // Capture THIS run's signal; a cancel/reset mid-run swaps the module controller, but our loop + workers keep
    // observing the one they started with.
    const signal = controller.signal;
    try {
        while (pending.length > 0) {
            if (signal.aborted) {
                break;
            }
            const batch = pending.shift() as QueueFile[];
            // Upload in bounded chunks, each retried independently, so a stall or reset costs one chunk — not the
            // whole drop. Within a chunk uploadChunk picks the transport (tar over h2, else the per-file XHR pool).
            for (const chunk of chunkItems(batch)) {
                if (signal.aborted) {
                    break;
                }
                await uploadChunk(chunk, signal);
            }
        }
    } finally {
        // ALWAYS clear running (even on an unexpected throw) so the queue can never wedge. If work was queued
        // during the unwind (a drop that arrived while finishing, or right after a cancel), keep going.
        running = false;
        if (!controller.signal.aborted && pending.length > 0) {
            void run();
        } else if (!signal.aborted) {
            finished.value = true;
            // Refresh the tree once the queue drains. The RAW prefix matches every ["workspace","tree", …, id]
            // query — sandboxKey would append the id and break the prefix match (see useSandbox).
            await queryClient?.invalidateQueries({ queryKey: [`workspace`, `tree`] });
            // Then make the tree usable: the imported project's dependencies. Last, so an install can never
            // delay the files appearing, and after the abort checks, so a cancelled drop installs nothing.
            await runInstall();
        }
    }
};

export function useUploadQueue() {
    queryClient = useQueryClient();

    // Add a drop/pick to the queue and (re)start the worker. targetDir is the root-relative folder the drop landed
    // on (root = ``); it's baked into each file's path here so the transports don't need to thread it through.
    const enqueue = async (targetDir: string, dropped: readonly DroppedFile[]): Promise<void> => {
        // Dropped before anything else, so the root's own .git never reaches project detection or the diff manifest.
        const entries = dropped.filter((entry) => !isRootGitPath(joinPath(targetDir, entry.path)));
        if (entries.length === 0) {
            // Dropping a bare `.git` on the root leaves nothing to send. Say so — the scan already narrated a file
            // count, and going quiet after it reads as a hang. A drop that kept something ignores what it left.
            if (dropped.length > 0 && !running && pending.length === 0) {
                skippedNotice.value = dropped.length;
                finished.value = true;
            }
            return;
        }
        // A brand-new run after the last one was left finished-and-untouched starts from a clean slate.
        if (finished.value && !running) {
            resetUploadQueue();
        }
        // Detect projects from the WHOLE drop, before the unchanged-file filter below prunes it: on a re-drop the
        // manifests are usually the files that DIDN'T change, so filtering first would hide the project entirely.
        // A second drop mid-upload contributes its own projects; dedupe by dir so one can't be installed twice.
        const detected = await detectSetup(targetDir, entries);
        const known = new Set(setupProjects.value.map((project) => project.dir));
        setupProjects.value = [...setupProjects.value, ...detected.filter((project) => !known.has(project.dir))];
        // Skip files already identical on the sandbox (size + mtime) so a re-upload only sends what changed. Capture
        // the signal first — a cancel during the round-trip must abort the enqueue.
        const signal = controller.signal;
        const unchanged = await filterUnchanged(targetDir, entries);
        if (signal.aborted) {
            return;
        }
        // Two entries in one drop can target the same destination; the parallel pool would interleave their offset
        // writes into one file. Keep only the last (dedupeByPath) and surface the drops so the panel never silently
        // does less than the file count.
        const surviving = dedupeByPath(unchanged, (entry) => entry.path);
        // A dropped repo deliberately keeps its .git (dropEntries), and the daemon calls a directory a repo the
        // moment .git merely EXISTS — so if refs/objects land before the work tree they describe, every Changes
        // poll runs `git status` against a half-written repo ("fatal: bad object HEAD"). The queue uploads in array
        // order, so sinking every .git entry to the back makes the repo discoverable only once its work tree is
        // already on disk. sort is stable, so everything else keeps the order dedupeByPath produced.
        surviving.sort((left, right) => (isGitEntry(left.path) ? 1 : 0) - (isGitEntry(right.path) ? 1 : 0));
        skippedUnchanged.value += entries.length - surviving.length;
        if (surviving.length === 0) {
            // The whole drop is already up to date — surface it (via skippedUnchanged) instead of a silent no-op.
            if (!running && pending.length === 0) {
                finished.value = true;
                // Still offer the install: re-dropping a project that's already on the sandbox is exactly what
                // someone does when it isn't working, and "already up to date" would otherwise be a dead end.
                // The daemon no-ops if it's genuinely ready, so this can't cause a redundant reinstall.
                await runInstall();
            }
            return;
        }
        // markRaw the File so Vue doesn't proxy it — calling .stream() on a reactive proxy of a File throws.
        const items = surviving.map((entry): QueueFile =>
            reactive({ path: joinPath(targetDir, entry.path), size: entry.file.size, status: `queued`, file: markRaw(entry.file) }),
        );
        files.value.push(...items);
        bytesTotal.value += items.reduce((sum, item) => sum + item.size, 0);
        pending.push(items);
        void run();
    };

    // Drop-target entry point: show the panel INSTANTLY (scanning), walk the dropped tree while streaming progress,
    // then hand the captured files to enqueue. collectDroppedFiles must be invoked here synchronously (in the drop
    // task) so webkitGetAsEntry captures the roots before the drag store is torn down.
    const enqueueFromDataTransfer = (targetDir: string, dataTransfer: DataTransfer): void => {
        if (finished.value && !running && activeScans === 0) {
            resetUploadQueue();
        }
        // Capture this session's signal so a cancel during the walk both stops it and skips the enqueue.
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
                // Nothing to upload: tell the user (symlink/special items skipped, or an empty folder) rather than
                // leaving the panel silent. A drop that DID yield files ignores stray skips — the upload speaks.
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
        installStarted,
        installError,
        installSettled,
        enqueue,
        enqueueFromDataTransfer,
        dismiss: resetUploadQueue,
    };
}
