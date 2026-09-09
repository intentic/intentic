import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { errorMessage } from "@intentic/base/errors";
import type { BundleExport } from "@intentic/sandbox-contract";
import { sandboxSlugOf } from "@intentic/sandbox-run";
import type { Services } from "../composition.js";
import { packBundle } from "./bundle.js";

// An export's state is the directory: `<name>.tar.gz.part` mid-pack, `<name>.tar.gz` finished, `<name>.tar.gz.failed`
// with the reason; no registry to disagree with the files. Progress is the `.part` file's own size. Lives under
// /history, not /work, so it is never swept into the next export, watched, or indexed.

export const exportsDir = (historyRoot: string): string => join(historyRoot, "exports");

const READY = ".tar.gz";
const PACKING = ".tar.gz.part";
const FAILED = ".tar.gz.failed";

// Only one export packs at a time; a concurrent second would double disk churn for two near-identical files.
export class ExportBusyError extends Error {}

// The file stem, also the owner's downloaded filename: the timestamp keeps bundles sorted and collision-free, and
// `-with-secrets` says what the file is on any machine.
const exportName = (sandbox: string, secrets: boolean, now: number): string => {
    const slug = sandboxSlugOf(sandbox) ?? (sandbox === "" ? "sandbox" : sandbox);
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

// Directory contents, newest first. createdAt is mtime: pack-end time for a finished bundle, last-progress time for a
// `.part` (a stalled pack stops moving).
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

// Whether `name` is a finished bundle. Resolved through the listing, not a path join, so a query string cannot walk the
// download route onto another file.
export const isReadyExport = async (historyRoot: string, name: string): Promise<boolean> =>
    (await listExports(historyRoot)).some((entry) => entry.name === name && entry.status === "ready");

// Body plus real length for the download route: a known Content-Length lets the browser's own download manager show
// progress.
export const openExport = async (historyRoot: string, name: string): Promise<{ body: ReadableStream<Uint8Array>; size: number } | undefined> => {
    if (!(await isReadyExport(historyRoot, name))) {
        return undefined;
    }
    const path = join(exportsDir(historyRoot), name);
    const size = await stat(path).then((stats) => stats.size);
    return { body: Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>, size };
};

// Removes an export in any state (failed marker or finished bundle). Returns whether something was there, so the route
// can 404 on false.
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

// At boot, a `.part` surviving a restart means the daemon died mid-pack; sweeping it to `.failed` keeps
// status-is-the-filename true across a crash.
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

// Returns the name immediately; the pack runs detached so the caller can navigate away. A failure is written to
// `.failed` since nothing is awaiting this to throw to.
export const startExport = async (services: Services, options: { readonly secrets: boolean; readonly now: number }): Promise<string> => {
    const historyRoot = services.config.historyRoot;
    if ((await listExports(historyRoot)).some((entry) => entry.status === "packing")) {
        throw new ExportBusyError("an export is already being packed");
    }
    const dir = exportsDir(historyRoot);
    await mkdir(dir, { recursive: true });
    const stem = exportName(services.config.sandbox.name, options.secrets, options.now);
    const part = join(dir, `${stem}${PACKING}`);

    // Written before returning, so the listing shows the export at once, not after the first bytes arrive.
    await writeFile(part, "");

    void (async () => {
        try {
            await pipeline(Readable.fromWeb(packBundle(services, options) as never), createWriteStream(part));
            await rename(part, join(dir, `${stem}${READY}`));
        } catch (error) {
            await writeFile(join(dir, `${stem}${FAILED}`), `${errorMessage(error)}\n`).catch(() => {});
            await rm(part, { force: true }).catch(() => {});
            services.logger.warn({ err: error, export: stem }, "environment export failed");
        }
    })();

    return `${stem}${READY}`;
};
