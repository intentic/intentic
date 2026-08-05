import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { BundleExport } from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";
import { packBundle } from "./bundle.js";

/* AN EXPORT IS A FILE, NOT A BUTTON PRESS.
 *
 * The first cut streamed the bundle straight down the response of the click that asked for it. That made the
 * export a property of one browser tab: navigate away or refresh and the fetch is abandoned mid-pack, the work
 * is thrown away, and — because nothing was ever written down — there is no artifact to come back to. The user
 * is left with a button that has forgotten what it was doing and no way to find what it produced.
 *
 * So packing moves into the daemon and its result becomes a file on the daemon's own volume. Everything the UI
 * shows is then DERIVED from that directory, which is the same rule the rest of this workspace runs on: the
 * browser renders what is on disk instead of what it happens to remember.
 *
 * STATUS IS THE FILENAME. `<name>.tar.gz.part` is being written, `<name>.tar.gz` is finished, and
 * `<name>.tar.gz.failed` holds the reason it stopped. No job registry, nothing to keep in sync with the bytes,
 * and no way for the two to disagree — a packer that dies leaves exactly the state its file already describes.
 * Progress is the `.part` file's own size, so "240 MB so far" costs a stat rather than a progress channel.
 *
 * WHY /history AND NOT /work: an export written into the workspace would be swept into the NEXT export (and
 * that one into the one after it), watched by the file watcher, indexed by iq, and snapshotted into the history
 * scopes. On the daemon volume it is inert. See HISTORY_STATE_FILES' `exports/` entry.
 */

export const exportsDir = (historyRoot: string): string => join(historyRoot, "exports");

const READY = ".tar.gz";
const PACKING = ".tar.gz.part";
const FAILED = ".tar.gz.failed";

// One export in flight at a time. A second concurrent pack would double the disk churn and halve both their
// speeds to produce two near-identical files; the route answers 409 and the card points at the running one.
export class ExportBusyError extends Error {}

/* The file's stem, which is also what the owner ends up with in their downloads folder. Two things are
 * deliberately IN the name rather than in metadata beside it: the timestamp, so bundles sort and never collide,
 * and whether it carries secrets — a file called `…-with-secrets.tar.gz` says what it is months later, on a
 * machine that has no idea what intentic is. */
const exportName = (sandbox: string, secrets: boolean, now: number): string => {
    const slug = sandbox === "" ? "sandbox" : sandbox.replace(/^intentic-sandbox-/, "");
    const stamp = new Date(now).toISOString().replace(/[:T]/g, "-").slice(0, 19);
    return `intentic-${slug}-${stamp}${secrets ? "-with-secrets" : ""}`;
};

const statusOf = (file: string): { readonly name: string; readonly status: BundleExport["status"] } | undefined => {
    for (const [suffix, status] of [
        [PACKING, "packing"],
        [FAILED, "failed"],
        [READY, "ready"],
    ] as const) {
        if (file.endsWith(suffix)) {
            return { name: `${file.slice(0, -suffix.length)}${READY}`, status };
        }
    }
    return undefined;
};

/* What is in the export directory, newest first.
 *
 * `createdAt` is the file's mtime, which means different things per status and each is the one worth showing:
 * for a finished bundle it is when packing ENDED (what the owner thinks of as "when I exported"), and for a
 * `.part` it is when it last made progress — a stalled pack is visible as a timestamp that stops moving.
 */
export const listExports = async (historyRoot: string): Promise<BundleExport[]> => {
    const dir = exportsDir(historyRoot);
    const files = await readdir(dir).catch(() => []);
    const entries = await Promise.all(
        files.map(async (file): Promise<BundleExport[]> => {
            const parsed = statusOf(file);
            if (parsed === undefined) {
                return [];
            }
            const stats = await stat(join(dir, file)).catch(() => undefined);
            if (stats === undefined) {
                return [];
            }
            const error = parsed.status === "failed" ? await readFile(join(dir, file), "utf8").catch(() => undefined) : undefined;
            return [
                {
                    name: parsed.name,
                    status: parsed.status,
                    bytes: stats.size,
                    createdAt: stats.mtimeMs,
                    secrets: parsed.name.includes("-with-secrets"),
                    ...(error === undefined || error === "" ? {} : { error }),
                },
            ];
        }),
    );
    return entries.flat().toSorted((left, right) => right.createdAt - left.createdAt);
};

// Whether `name` is a FINISHED bundle this daemon produced. Resolved through the listing rather than by
// joining the name onto a path, so a query string can never walk the download route onto another file.
export const isReadyExport = async (historyRoot: string, name: string): Promise<boolean> =>
    (await listExports(historyRoot)).some((entry) => entry.name === name && entry.status === "ready");

/* A finished bundle as a body plus its real length — the shape the download route hands back.
 *
 * The length matters: the first cut packed as it responded, so the size was unknowable until the stream ended
 * and the browser could show neither a progress bar nor a time estimate for a download that might run for
 * minutes. A file that already exists in full has a Content-Length, and the browser's own download manager
 * takes it from there.
 */
export const openExport = async (historyRoot: string, name: string): Promise<{ body: ReadableStream<Uint8Array>; size: number } | undefined> => {
    if (!(await isReadyExport(historyRoot, name))) {
        return undefined;
    }
    const path = join(exportsDir(historyRoot), name);
    const size = await stat(path).then((stats) => stats.size);
    return { body: Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>, size };
};

// Drop one export whatever state it is in (a failed marker is as deletable as a finished bundle). True when
// something was there — the route turns a false into a 404 rather than pretending.
export const removeExport = async (historyRoot: string, name: string): Promise<boolean> => {
    const found = (await listExports(historyRoot)).find((entry) => entry.name === name);
    if (found === undefined) {
        return false;
    }
    const stem = name.slice(0, -READY.length);
    for (const suffix of [READY, PACKING, FAILED]) {
        await rm(join(exportsDir(historyRoot), `${stem}${suffix}`), { force: true });
    }
    return true;
};

/* Boot convergence: a `.part` can only be live while the process writing it is, so any that survives a restart
 * is an export the daemon died in the middle of. Turning it into a `.failed` at boot is what keeps "status is
 * the filename" true across a crash — otherwise the card would show a pack that is making no progress and
 * never will, with nothing to distinguish it from one that is.
 */
export const sweepStaleExports = async (historyRoot: string): Promise<void> => {
    const dir = exportsDir(historyRoot);
    for (const file of await readdir(dir).catch(() => [])) {
        if (!file.endsWith(PACKING)) {
            continue;
        }
        const stem = file.slice(0, -PACKING.length);
        await writeFile(join(dir, `${stem}${FAILED}`), "The sandbox restarted while this export was being packed. Start a new one.\n");
        await rm(join(dir, file), { force: true });
    }
};

/* Start an export and return its name IMMEDIATELY — the pack runs detached, so the request that started it is
 * free to end and the browser that sent it is free to navigate away.
 *
 * Failure is written down rather than thrown into a void: nobody is awaiting this, so a `.failed` file carrying
 * the message is the only way the owner ever learns why their export stopped.
 */
export const startExport = async (services: Services, options: { readonly secrets: boolean; readonly now: number }): Promise<string> => {
    const historyRoot = services.config.historyRoot;
    if ((await listExports(historyRoot)).some((entry) => entry.status === "packing")) {
        throw new ExportBusyError("an export is already being packed");
    }
    const dir = exportsDir(historyRoot);
    await mkdir(dir, { recursive: true });
    const stem = exportName(services.config.sandbox.name, options.secrets, options.now);
    const part = join(dir, `${stem}${PACKING}`);

    /* The marker is created BEFORE this returns, so the export exists in the listing the instant the route
     * answers. Leaving it to the write stream opened below meant the file appeared only once the first bytes
     * arrived — and building the manifest and walking a large workspace happens first, so the owner clicked
     * Export and watched an empty list for the one moment they were most likely to click again. Zero bytes is
     * a truthful "packing, nothing yet"; the size the card shows starts moving on its own. */
    await writeFile(part, "");

    void (async () => {
        try {
            await pipeline(Readable.fromWeb(packBundle(services, options) as never), createWriteStream(part));
            await rename(part, join(dir, `${stem}${READY}`));
        } catch (error) {
            await writeFile(join(dir, `${stem}${FAILED}`), `${error instanceof Error ? error.message : String(error)}\n`).catch(() => {});
            await rm(part, { force: true }).catch(() => {});
            services.logger.warn({ err: error, export: stem }, "environment export failed");
        }
    })();

    return `${stem}${READY}`;
};
