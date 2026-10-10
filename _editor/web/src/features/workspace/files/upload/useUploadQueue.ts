import { useQueryClient } from "@tanstack/vue-query";
import { sleep } from "@intentic/base/async";
import { isBrowsableArchive } from "@intentic/sandbox-contract";
import { messageOr } from "@intentic/ui/async";
import { t } from "@intentic/ui/i18n";
import { basename, joinPath } from "@intentic/ui/path";
import { sandboxRef, sandboxScopeGuard, sandboxShallowRef, sandboxValue } from "@intentic/extension-api";
import { computed, ref } from "vue";
import { detectProjects, managerFromPackageJson, type ProjectSetup } from "@intentic/workspace-setup";
import { captureDrop, type DroppedFile, isRootGitPath, walkDrop } from "../../explorer/transfer/dropEntries";
import { packTar } from "../../explorer/transfer/tarArchive";
import { useEndpoint } from "../../../../client/endpoint/useEndpoint";
import { sandboxJson, sandboxUpload } from "../../../../client/sandbox/sandboxClient";
import { jsonBody } from "../../../../client/sandbox/jsonBody";
import { sandboxRpc } from "../../../../client/sandbox/sandboxRpc";
import { supportsRoute } from "../../../../client/sandbox/useDaemonRoutes";
import { rpcPrefix } from "../../../../lib/queryKeys";
import { measuredProtocol, streamCapacity } from "../../../../lib/streamBudget";
import { workspaceAgent } from "../../../../app/workspaceScope";
import { chunkItems, dedupeByPath } from "../../../../lib/files/uploadChunking";
import { clearUnsettledUploads, markFailed, markSettled, noteArriving } from "../provisionalEntries";
import { captureNativeDrop, copyNatively, type NativeDrop, type NativeEvent, type NativeProgress } from "./nativeCopy";

// Workspace upload queue: drops and picks append to a shared queue rather than clobbering an in-flight upload.
// Per-file transport is a bounded XHR pool; a chunk of many small files goes as one tar archive instead, falling back to
// the pool for that chunk when the archive fails. Both are XMLHttpRequests, which work on HTTP/1.1 and HTTP/2 alike.
//
// Nothing per file is reactive. A drop can be 66,000 files, and one render per file (scanned, started, landed) is what
// froze the page; the queue keeps its counts in plain objects and publishes them to the card at most every PUBLISH_MS.

type FileStatus = "queued" | "uploading" | "done" | "failed";
export interface QueueFile {
    readonly path: string; // root-relative destination (targetDir already joined in)
    readonly size: number;
    // Its row in the card's breakdown, root-relative: see groupOf.
    readonly group: string;
    status: FileStatus;
    error?: string;
    readonly file: File;
}

// One row of the card's per-folder breakdown.
export interface UploadGroup {
    readonly name: string;
    readonly total: number;
    readonly done: number;
    readonly failed: number;
}

export interface UploadFailure {
    readonly path: string;
    readonly error: string | undefined;
}

const TAR_THRESHOLD = 20;
// Per-file requests at once. Over HTTP/1.1 the browser gives an origin six connections for everything the page does,
// and five of them uploading left the explorer, chat and menus waiting behind the drop; two leaves them room.
const POOL_SIZE = 5;
const POOL_SIZE_HTTP1 = 2;
// How often the card hears about progress, at most.
const PUBLISH_MS = 100;
// Failures the card lists by name; the count covers the rest.
const MAX_FAILURES_SHOWN = 50;

// The three helpers around the one write every backend serves (`POST /workspace/upload`). A folder on this computer (the
// desktop app's sidecar) serves none of them, and says so in its hello: its drops skip the diff and the archive and are
// never offered an install, rather than paying a 404 for each, or reporting an install that never could have started.
const DIFF_ROUTE = `POST /workspace/upload-diff`;
const ARCHIVE_ROUTE = `POST /workspace/upload-archive`;
const INSTALL_ROUTE = `workspace.install`;

// Each chunk gets its own retry, so one bad chunk can't fail the whole drop; a stalled request is cut off by
// sandboxUpload's own stall timer.
const RETRY_ATTEMPTS = 4;
const RETRY_BASE_MS = 1000;

// Everything a drop changes file by file, where nothing observes it. One upload session per sandbox: the bytes go into
// that sandbox's /work, so a switch starts the card over.
interface Tally {
    count: number;
    done: number;
    failed: number;
    bytesTotal: number;
    // Bytes of the files marked done: where bytesDone returns to when an attempt's partial progress is thrown away.
    doneBytes: number;
    bytesDone: number;
    current: string;
    scanned: number;
    scannedBytes: number;
    scanningName: string;
    unreadable: number;
    readonly groups: Map<string, { name: string; total: number; done: number; failed: number }>;
    readonly failures: Set<QueueFile>;
    // Failures with no queued file behind them: what the desktop app reports of a drop it copied itself.
    readonly reported: UploadFailure[];
}

const freshTally = (): Tally => ({
    count: 0,
    done: 0,
    failed: 0,
    bytesTotal: 0,
    doneBytes: 0,
    bytesDone: 0,
    current: ``,
    scanned: 0,
    scannedBytes: 0,
    scanningName: ``,
    unreadable: 0,
    groups: new Map(),
    failures: new Set(),
    reported: [],
});
const tally = sandboxValue(freshTally);

// What the card reads: the tally as of its last publish.
const fileCount = sandboxRef(() => 0);
const doneCount = sandboxRef(() => 0);
const failedCount = sandboxRef(() => 0);
const bytesTotal = sandboxRef(() => 0);
const bytesDone = sandboxRef(() => 0);
const currentName = sandboxRef(() => ``);
const scannedCount = sandboxRef(() => 0);
const scannedBytes = sandboxRef(() => 0);
const scanningName = sandboxRef(() => ``);
const unreadableCount = sandboxRef(() => 0);
const groups = sandboxShallowRef<readonly UploadGroup[]>(() => []);
const failures = sandboxShallowRef<readonly UploadFailure[]>(() => []);

let publishTimer: ReturnType<typeof setTimeout> | undefined;

// Copies the tally into the refs now. Called directly wherever the card's phase turns (a scan ending, a batch queued,
// the import settling), so a phase never shows with the counts of the one before it.
const publish = (): void => {
    clearTimeout(publishTimer);
    publishTimer = undefined;
    const now = tally.value;
    fileCount.value = now.count;
    doneCount.value = now.done;
    failedCount.value = now.failed;
    bytesTotal.value = now.bytesTotal;
    bytesDone.value = now.bytesDone;
    currentName.value = now.current;
    scannedCount.value = now.scanned;
    scannedBytes.value = now.scannedBytes;
    scanningName.value = now.scanningName;
    unreadableCount.value = now.unreadable;
    groups.value = Array.from(now.groups.values(), (group) => ({ ...group }));
    const shown: UploadFailure[] = [];
    for (const item of now.failures) {
        if (shown.length === MAX_FAILURES_SHOWN) {
            break;
        }
        shown.push({ path: item.path, error: item.error });
    }
    failures.value = [...shown, ...now.reported.slice(0, MAX_FAILURES_SHOWN - shown.length)];
};

const schedulePublish = (): void => {
    publishTimer ??= setTimeout(publish, PUBLISH_MS);
};

const finished = sandboxRef(() => false);
const startedAt = sandboxRef(() => 0);

// Pre-upload tree walk; scanning narrates progress until every overlapping scan (activeScans) finishes.
const scanning = sandboxRef(() => false);
let activeScans = 0;
// Drops the desktop app is copying itself (nativeCopy.ts), from the moment it starts writing until it says it is done.
let nativeCopies = 0;

// Files handed to enqueue and not yet in the queue: the time between a scan ending and the first byte moving, spent
// asking the sandbox what it already has. Counted so the card says so rather than vanishing for it. A restart zeroes
// it, and the enqueues it cut short see their signal aborted and leave it alone.
const preparing = sandboxRef(() => 0);

// Why a drop never got as far as the queue; the card keeps it until dismissed.
const startError = sandboxRef<string | undefined>(() => undefined);

// Set when a drop produced no files (unreadable items or an empty folder), so the panel can say so.
const skippedNotice = sandboxRef<number | undefined>(() => undefined);

// Files skipped as identical on the sandbox (size + mtime); shown so nothing looks silently dropped.
const skippedUnchanged = sandboxRef(() => 0);

// Unpacks a just-landed zip or tar ahead of the first click on it. The listing request IS the unpack, so this is the
// same call the home would make, made early and thrown away; a failure here costs nothing, since the home's own call
// will report it when someone actually opens the archive. A big drop's archives wait for that click instead: warming
// hundreds at once would have the daemon unpack them all while it is still taking the upload.
const warmArchive = (path: string): void => {
    if (tally.value.count > TAR_THRESHOLD || !isBrowsableArchive(basename(path))) {
        return;
    }
    void sandboxRpc.workspace.children({ path, agent: workspaceAgent.value }).catch(() => undefined);
};

// The one place a file's status moves, so neither the explorer's placeholder row for it nor the card's counts can
// drift from it. `queued` covers a retry resetting a file that a previous attempt already reported on.
const setStatus = (item: QueueFile, status: FileStatus): void => {
    const was = item.status;
    item.status = status;
    if (was !== status) {
        const now = tally.value;
        // Only an item left over from a sandbox switched away from lacks its row; it counts into nothing shown.
        const group = now.groups.get(item.group) ?? { name: item.group, total: 0, done: 0, failed: 0 };
        if (was === `done`) {
            now.done -= 1;
            now.doneBytes -= item.size;
            group.done -= 1;
        } else if (was === `failed`) {
            now.failed -= 1;
            now.failures.delete(item);
            group.failed -= 1;
        }
        if (status === `done`) {
            now.done += 1;
            now.doneBytes += item.size;
            group.done += 1;
        } else if (status === `failed`) {
            now.failed += 1;
            now.failures.add(item);
            group.failed += 1;
        }
        schedulePublish();
    }
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
            installError.value = messageOr(error, t(`workspace.uploadQueue.installFailed`));
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
    tally.value = freshTally();
    publish();
    finished.value = false;
    startedAt.value = 0;
    scanning.value = false;
    startError.value = undefined;
    preparing.value = 0;
    nativeCopies = 0;
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

// Back to the bytes of files marked done, so a failed attempt's partial bytes don't linger; live progress deltas add on
// top between calls.
const recomputeBytesDone = (): void => {
    tally.value.bytesDone = tally.value.doneBytes;
    schedulePublish();
};

// Asks the daemon which dropped files are already identical (size + mtime) so a re-drop only sends what changed.
// Any error returns everything unfiltered; dedup must never block or drop an upload.
const filterUnchanged = async (targetDir: string, entries: readonly DroppedFile[], signal: AbortSignal): Promise<readonly DroppedFile[]> => {
    if (!supportsRoute(DIFF_ROUTE)) {
        return entries;
    }
    try {
        const stats = entries.map((entry) => ({ path: joinPath(targetDir, entry.path), size: entry.file.size, mtime: entry.file.lastModified }));
        const { skip } = await sandboxJson<{ skip: string[] }>(`/workspace/upload-diff`, { ...jsonBody(`POST`, { files: stats }), signal });
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
const uploadOneXhr = async (item: QueueFile, signal: AbortSignal): Promise<void> => {
    const now = tally.value;
    let last = 0;
    const counted = (loaded: number): void => {
        now.bytesDone += loaded - last;
        last = loaded;
        schedulePublish();
    };
    await sandboxUpload(`/workspace/upload?path=${encodeURIComponent(item.path)}&mtime=${item.file.lastModified}`, item.file, {
        signal,
        onProgress: counted,
    });
    // A landed file counts whole, whether or not the last progress event said so.
    counted(item.size);
};

// Whether the address in use multiplexes requests; by what the browser negotiated where known (lib/streamBudget.ts).
const multiplexed = (): boolean => {
    const { daemonBase, usingLocal, degradedTransport } = useEndpoint();
    const kind = degradedTransport.value ? `local-insecure` : usingLocal.value ? `local` : `public`;
    return streamCapacity(kind, measuredProtocol(daemonBase.value)) === Number.POSITIVE_INFINITY;
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
            tally.value.current = item.path;
            try {
                await uploadOneXhr(item, signal);
                setStatus(item, `done`);
            } catch (error) {
                if (signal.aborted) {
                    return;
                }
                item.error = messageOr(error, t(`workspace.uploadQueue.uploadFailed`));
                setStatus(item, `failed`);
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(multiplexed() ? POOL_SIZE : POOL_SIZE_HTTP1, items.length) }, worker));
};

// Sends one bounded chunk as a single tar archive. The request's byte progress is mapped back onto the files through
// where each one's bytes start in the archive, so the bar and the "now sending" line move as they do for the pool.
// Returns:
// - done: the chunk landed (or the user cancelled, which leaves statuses alone).
// - fallback: the archive failed, for whatever reason (a file that changed on disk under the read, a daemon refusing a
//   whole-tree write, a dropped connection); the caller sends this chunk file by file, where one bad file fails alone.
const uploadViaTar = async (items: readonly QueueFile[], signal: AbortSignal): Promise<"done" | "fallback"> => {
    const now = tally.value;
    const { blob, starts } = packTar(items.map((item) => ({ file: item.file, path: item.path })));
    // The file whose bytes are being counted, and how many of them already are.
    let index = 0;
    let counted = 0;
    const progress = (loaded: number): void => {
        for (let item = items[index], start = starts[index]; item !== undefined && start !== undefined; item = items[index], start = starts[index]) {
            if (loaded <= start) {
                break;
            }
            now.current = item.path;
            const reached = Math.min(loaded - start, item.size);
            now.bytesDone += reached - counted;
            counted = reached;
            if (reached < item.size) {
                break;
            }
            index += 1;
            counted = 0;
        }
        schedulePublish();
    };
    try {
        await sandboxUpload(`/workspace/upload-archive`, blob, { signal, whole: true, onProgress: progress });
        progress(blob.size);
        for (const item of items) {
            setStatus(item, `done`);
        }
        return `done`;
    } catch (error) {
        if (signal.aborted) {
            return `done`;
        }
        console.warn(`upload: an archive of ${items.length} files failed; sending them one at a time`, error);
        return `fallback`;
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
        if (archive && chunk.length > TAR_THRESHOLD && supportsRoute(ARCHIVE_ROUTE)) {
            if ((await uploadViaTar(chunk, signal)) === `done` || signal.aborted) {
                return;
            }
            // The per-file pool takes this chunk, and the archive's partial bytes are not the pool's progress.
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
            item.error ??= t(`workspace.uploadQueue.uploadFailedAfter`, { attempts: RETRY_ATTEMPTS }, RETRY_ATTEMPTS);
            setStatus(item, `failed`);
        }
    }
};

// Takes one batch into the queue and starts the worker. Placeholder rows go in before the first byte moves, so the
// explorer shows where the drop landed while the daemon's own listing (a walk of the whole workspace) is seconds away,
// but only once the queue holds the batch: a row put in for a file the queue never took spins with nothing to settle
// it. Never `push(...items)`: spreading a 66,000-file drop into one call overflows the stack.
const queueBatch = (items: QueueFile[]): void => {
    const now = tally.value;
    for (const item of items) {
        now.count += 1;
        now.bytesTotal += item.size;
        const group = now.groups.get(item.group) ?? { name: item.group, total: 0, done: 0, failed: 0 };
        group.total += 1;
        now.groups.set(item.group, group);
    }
    pending.value.push(items);
    for (const item of items) {
        noteArriving(item.path, { kind: `upload`, size: item.size });
    }
    publish();
    void run();
};

// Adds projects to the install offer, each folder once across drops.
const offerSetup = (detected: readonly ProjectSetup[]): void => {
    const known = new Set(setupProjects.value.map((project) => project.dir));
    setupProjects.value = [...setupProjects.value, ...detected.filter((project) => !known.has(project.dir))];
};

// A drop the desktop app copies itself (nativeCopy.ts), its reports fed into the tally the card reads, so the card is
// the same one an upload draws. Each report carries the copy's running totals; what this copy has already added is
// kept, so each adds only what changed. "declined" hands the drop back to the browser, taking the app's scan back out
// of the counts first, since the browser's walk counts it again.
const copyViaApp = async (drop: NativeDrop, targetDir: string, signal: AbortSignal, endScan: () => void): Promise<"declined" | "handled"> => {
    const now = tally.value;
    const added = { scanned: 0, scannedBytes: 0, done: 0, doneBytes: 0, sentBytes: 0, failed: 0 };
    // Per dropped item: its row in the card, and what this copy has added to it.
    let rows: { key: string; files: number; done: number; failed: number }[] = [];
    let copying = false;
    let total = 0;
    const scanned = (files: number, bytes: number): void => {
        now.scanned += files - added.scanned;
        now.scannedBytes += bytes - added.scannedBytes;
        added.scanned = files;
        added.scannedBytes = bytes;
    };
    const advance = (progress: NativeProgress): void => {
        now.done += progress.done - added.done;
        now.doneBytes += progress.doneBytes - added.doneBytes;
        now.bytesDone += progress.sentBytes - added.sentBytes;
        now.failed += progress.failed - added.failed;
        Object.assign(added, { done: progress.done, doneBytes: progress.doneBytes, sentBytes: progress.sentBytes, failed: progress.failed });
        progress.roots?.forEach((root, index) => {
            const row = rows[index];
            const group = row === undefined ? undefined : now.groups.get(row.key);
            if (row !== undefined && group !== undefined) {
                group.done += root.done - row.done;
                group.failed += root.failed - row.failed;
                row.done = root.done;
                row.failed = root.failed;
            }
        });
        if (progress.current !== undefined && progress.current !== ``) {
            now.current = progress.current;
        }
        schedulePublish();
    };
    const report = (event: NativeEvent): void => {
        if (signal.aborted) {
            return;
        }
        if (event.kind === `scanning`) {
            scanned(event.files, event.bytes);
            now.scanningName = event.current;
            schedulePublish();
        } else if (event.kind === `copying`) {
            scanned(event.files, event.bytes);
            total = event.files;
            now.count += event.files;
            now.bytesTotal += event.bytes;
            now.unreadable += event.unreadable;
            rows = event.roots.map((root) => {
                // As groupOf names an upload's rows: the dropped folder, or the folder loose files went into.
                const key = root.dir ? joinPath(targetDir, root.name) : targetDir;
                const group = now.groups.get(key) ?? { name: key, total: 0, done: 0, failed: 0 };
                group.total += root.files;
                now.groups.set(key, group);
                if (root.dir) {
                    noteArriving(key, { kind: `upload`, type: `dir` });
                }
                return { key, files: root.files, done: 0, failed: 0 };
            });
            if (supportsRoute(INSTALL_ROUTE)) {
                offerSetup(detectProjects(event.manifests).map((project) => ({ dir: joinPath(targetDir, project.dir), recipe: project.recipe })));
            }
            copying = true;
            nativeCopies += 1;
            if (startedAt.value === 0) {
                startedAt.value = performance.now();
            }
            publish();
            // The walk is over and the card is on the copy now.
            endScan();
        } else if (event.kind === `progress`) {
            advance(event);
        } else if (event.kind === `finished`) {
            advance(event);
            now.reported.push(...(event.failures ?? []).slice(0, Math.max(0, MAX_FAILURES_SHOWN - now.reported.length)));
            // A copy that stopped short: what it never reached did not land, and is counted with the failures. One that
            // ends in an error with no file counted failed is itself the failure, counted once, or the card read it as a
            // clean import, left the error unshown and retired itself.
            if (event.error !== undefined && !event.cancelled) {
                const unreached = Math.max(0, total - added.done - added.failed);
                now.failed += unreached === 0 && added.failed === 0 ? 1 : unreached;
                for (const row of rows) {
                    const group = now.groups.get(row.key);
                    if (group !== undefined) {
                        group.failed += Math.max(0, row.files - row.done - row.failed);
                    }
                }
                now.reported.unshift({ path: targetDir === `` ? `/` : targetDir, error: event.error });
            }
            for (const row of rows) {
                markSettled(row.key);
            }
            if (copying) {
                copying = false;
                nativeCopies -= 1;
            }
            publish();
        }
    };
    const outcome = await copyNatively(drop, targetDir, signal, report);
    if (outcome === `declined` && !signal.aborted) {
        scanned(0, 0);
        now.scanningName = ``;
        schedulePublish();
    }
    // A cancel ends the wait before the app's last word: the restart already zeroed the count this copy was part of.
    if (copying && !signal.aborted) {
        nativeCopies -= 1;
    }
    return outcome;
};

// The import is over once nothing is being scanned, prepared, queued or sent. Each of those calls this as it ends, and
// the last one to end finds the queue idle: marks it finished, refreshes the tree and starts the install.
const settleIfIdle = async (): Promise<void> => {
    if (finished.value || running || activeScans > 0 || nativeCopies > 0 || preparing.value > 0 || pending.value.length > 0) {
        return;
    }
    publish();
    finished.value = true;
    // Every scope's tree, not the focused one: a drop can land files outside that scope, so every variant is stale.
    await queryClient?.invalidateQueries({ queryKey: rpcPrefix(`workspace.tree`) });
    // After the tree refresh, so the install's projects are already listed; a cancelled drop never gets here.
    await runInstall();
};

// The card's row for a file: the folder that was dropped, or for loose files the folder they were dropped into ("" for
// the workspace root).
const groupOf = (targetDir: string, path: string): string => {
    const slash = path.indexOf(`/`);
    return slash === -1 ? targetDir : joinPath(targetDir, path.slice(0, slash));
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
            await settleIfIdle();
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
                await settleIfIdle();
            }
            return;
        }
        // A finished-and-untouched queue starts fresh on the next drop.
        if (finished.value && !running) {
            restartQueue();
        }
        // Captured before either round trip, so a cancel or a switch (which aborts it) during one aborts the enqueue too.
        const { signal } = controller.value;
        preparing.value += entries.length;
        try {
            // Detected before the unchanged-file filter prunes the usually-unchanged manifests; dedupe by dir across drops.
            const detected = supportsRoute(INSTALL_ROUTE) ? await detectSetup(targetDir, entries) : [];
            const unchanged = await filterUnchanged(targetDir, entries, signal);
            if (signal.aborted) {
                return;
            }
            offerSetup(detected);
            // Two entries can target the same destination; keep only the last, or parallel writes interleave into one file.
            const surviving = dedupeByPath(unchanged, (entry) => entry.path);
            // Sinks .git entries to the back (stable sort) so the daemon doesn't see a repo before its work tree lands.
            surviving.sort((left, right) => (isGitEntry(left.path) ? 1 : 0) - (isGitEntry(right.path) ? 1 : 0));
            skippedUnchanged.value += entries.length - surviving.length;
            // An up-to-date drop queues nothing, and settling still offers the install: re-dropping an up-to-date
            // project is exactly what someone does when it isn't working.
            if (surviving.length > 0) {
                queueBatch(
                    surviving.map((entry): QueueFile => ({
                        path: joinPath(targetDir, entry.path),
                        size: entry.file.size,
                        group: groupOf(targetDir, entry.path),
                        status: `queued`,
                        file: entry.file,
                    })),
                );
            }
        } catch (error) {
            // Nothing of this batch is queued, so nothing of it is drawn either; the card says why it never started.
            if (!signal.aborted) {
                console.error(`Failed to queue the dropped files`, error);
                startError.value = messageOr(error, t(`workspace.uploadQueue.startFailed`));
            }
        } finally {
            // An abort (a cancel, or a switch) already zeroed the count this batch was part of.
            if (!signal.aborted) {
                preparing.value -= entries.length;
                await settleIfIdle();
            }
        }
    };

    // Drop-target entry point: shows the panel immediately, then either hands a big drop to the desktop app (which
    // copies it into a sandbox on this computer itself) or walks the tree with streaming progress and hands the files to
    // enqueue. Both captures happen here, synchronously, before the drag store tears down: the app may decline the
    // drop, and the browser's walk then needs entries that are only handed out while the drop event lasts.
    const enqueueFromDataTransfer = (targetDir: string, dataTransfer: DataTransfer): void => {
        if (finished.value && !running && activeScans === 0 && nativeCopies === 0) {
            restartQueue();
        }
        // Captures this session's signal so a cancel during the walk stops it and skips the enqueue.
        const { signal } = controller.value;
        const native = captureNativeDrop(dataTransfer);
        const drop = captureDrop(dataTransfer);
        const now = tally.value;
        activeScans += 1;
        scanning.value = true;
        finished.value = false;
        skippedNotice.value = undefined;
        // This drop's hold on the scanning phase, given back once: when a copy by the app gets going, or at the end.
        let scanHeld = true;
        const endScan = (): void => {
            if (!scanHeld) {
                return;
            }
            scanHeld = false;
            activeScans -= 1;
            if (activeScans === 0) {
                publish();
                scanning.value = false;
            }
        };
        const viaBrowser = async (): Promise<void> => {
            const result = await walkDrop(
                drop,
                (path, size) => {
                    now.scanned += 1;
                    now.scannedBytes += size;
                    now.scanningName = path;
                    schedulePublish();
                },
                signal,
            );
            if (signal.aborted) {
                return;
            }
            now.unreadable += result.unreadable;
            // Only set when nothing was uploaded; a drop that did yield files ignores stray skips.
            if (result.files.length === 0) {
                skippedNotice.value = result.skipped;
            }
            // Starts preparing before this scan's slot is given back below, so the card goes straight from one to the
            // other.
            void enqueue(targetDir, result.files);
        };
        const work = async (): Promise<void> => {
            if (native !== undefined && (await copyViaApp(native, targetDir, signal, endScan)) === `handled`) {
                return;
            }
            if (!signal.aborted) {
                await viaBrowser();
            }
        };
        work()
            .catch((error: unknown) => {
                if (!signal.aborted) {
                    console.error(`Failed to read the dropped items`, error);
                    startError.value = messageOr(error, t(`workspace.uploadQueue.startFailed`));
                }
            })
            .finally(() => {
                endScan();
                if (!signal.aborted) {
                    void settleIfIdle();
                }
            });
    };

    const throughput = computed(() => {
        const elapsed = (performance.now() - startedAt.value) / 1000;
        return elapsed > 0 ? bytesDone.value / elapsed : 0;
    });
    // Seconds to go at the pace so far; undefined until a few seconds of pace are worth extrapolating from.
    const secondsLeft = computed(() => {
        const elapsed = (performance.now() - startedAt.value) / 1000;
        const rate = throughput.value;
        return startedAt.value === 0 || elapsed < 3 || rate <= 0 ? undefined : (bytesTotal.value - bytesDone.value) / rate;
    });

    return {
        fileCount,
        bytesTotal,
        bytesDone,
        currentName,
        finished,
        scanning,
        scannedCount,
        scannedBytes,
        scanningName,
        preparing,
        startError,
        unreadableCount,
        skippedNotice,
        skippedUnchanged,
        failedCount,
        doneCount,
        groups,
        failures,
        throughput,
        secondsLeft,
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
