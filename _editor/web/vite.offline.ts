import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { Plugin } from "vite";

// THE EDITOR'S OFFLINE COPY, as the build lists it (2026-10-26). public/sw.js keeps the last good shell and serves it when
// app.intentic.dev cannot answer; this writes into the built sw.js which chunks it fetches when it installs: the entry's
// and those of the few views an outage has to draw. Everything else is kept the first time it is used, so a view the
// reader has opened before opens offline too, and one they never opened does not cost every visitor a download.

/** The marker public/sw.js carries where the list goes. */
export const PRECACHE_MARKER = `/* intentic:precache */ null`;

// The runtime config, filled per deploy (entrypoint.sh). A deployed index.html carries it inline, but a page that still
// loads it by its tag (a build served without the entrypoint, a self-hosted one) cannot start without it.
const RUNTIME_CONFIG = `/assets/js/env.js`;

/**
 * The views an outage has to draw, by source path under this package: the outage screen and the direct mode it opens
 * (the sandboxes this device remembers), a sandbox's own address and the recovery behind it, and the workspace shell a
 * remembered sandbox opens in, with the screen it lands on (the sandbox's agent board). The entry (main.ts) is in by
 * being the entry. Home is left to be kept on use: it is the first screen of nearly every visit, so a reader who has
 * one has it, and it would be the largest thing on this list (about 240 KiB gzipped on 2026-10-26).
 */
export const OFFLINE_VIEWS: readonly string[] = [
    `src/features/setup/PlatformUnavailable.vue`,
    `src/features/sandbox/recovery/Recover.vue`,
    `src/shell/WorkspaceShell.vue`,
    `src/shell/ShellDesktop.vue`,
    `src/shell/ShellMobile.vue`,
    `src/features/agents/fleet/Agents.vue`,
];

/** What the list is made from: each chunk of the bundle as rolldown describes it, and each other file it wrote. */
export interface BundleChunk {
    readonly fileName: string;
    readonly isEntry: boolean;
    readonly imports: readonly string[];
    readonly moduleIds: readonly string[];
}

export interface PrecacheManifest {
    readonly build: string;
    readonly urls: readonly string[];
}

const sourcePath = (id: string): string => (id.split(`?`)[0] ?? id).replaceAll(`\\`, `/`);

/**
 * The files an offline start needs, as root-relative URLs: the shell itself (`/`), the runtime config, every stylesheet
 * (one, since the build does not split CSS), and each chunk that is an entry or holds one of `views`, with every chunk
 * those import statically. A view's own lazy imports stay out: they are kept on use. Pure.
 */
export const offlineFiles = (chunks: readonly BundleChunk[], styles: readonly string[], views: readonly string[]): string[] => {
    const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
    const wanted = (chunk: BundleChunk): boolean => chunk.isEntry || chunk.moduleIds.some((id) => views.some((view) => sourcePath(id).endsWith(`/${view}`)));
    const files = new Set<string>();
    const take = (name: string): void => {
        const chunk = byName.get(name);
        if (chunk === undefined || files.has(name)) {
            return;
        }
        files.add(name);
        chunk.imports.forEach(take);
    };
    chunks.filter(wanted).forEach((chunk) => take(chunk.fileName));
    return [`/`, RUNTIME_CONFIG, ...[...styles].sort().map((name) => `/${name}`), ...[...files].sort().map((name) => `/${name}`)];
};

/** sw.js with its list written in where the marker stands; a worker without exactly one marker is refused. Pure. */
export const withPrecache = (source: string, manifest: PrecacheManifest): string => {
    const parts = source.split(PRECACHE_MARKER);
    if (parts.length !== 2) {
        throw new Error(`sw.js must carry the precache marker exactly once (found ${parts.length - 1})`);
    }
    return parts.join(JSON.stringify(manifest));
};

/** Writes this build's list into the copied public/sw.js, and says how much an install fetches. */
export const offlinePrecache = (build: string, views: readonly string[] = OFFLINE_VIEWS): Plugin => {
    let urls: string[] = [];
    // What an install fetches, and how much of it is the boot graph every load fetches anyway (from the HTTP cache).
    const weight = { bytes: 0, gzipped: 0, bootBytes: 0, bootGzipped: 0 };
    return {
        name: `intentic-offline-precache`,
        apply: `build`,
        generateBundle(_options, bundle) {
            const outputs = Object.values(bundle);
            const chunks = outputs.flatMap((output) =>
                output.type === `chunk` ? [{ fileName: output.fileName, isEntry: output.isEntry, imports: output.imports, moduleIds: output.moduleIds }] : [],
            );
            const styles = outputs.flatMap((output) => (output.type === `asset` && output.fileName.endsWith(`.css`) ? [output.fileName] : []));
            urls = offlineFiles(chunks, styles, views);
            const boot = new Set(offlineFiles(chunks, styles, []));
            const sizes = new Map(outputs.map((output) => [`/${output.fileName}`, output.type === `chunk` ? output.code : output.source]));
            for (const url of urls) {
                const body = sizes.get(url);
                if (body !== undefined) {
                    const [raw, packed] = [Buffer.byteLength(body), gzipSync(body).byteLength];
                    weight.bytes += raw;
                    weight.gzipped += packed;
                    weight.bootBytes += boot.has(url) ? raw : 0;
                    weight.bootGzipped += boot.has(url) ? packed : 0;
                }
            }
        },
        writeBundle(options) {
            // The public directory is copied before the bundle is written, so the worker is already in place here.
            const worker = join(options.dir ?? `dist`, `sw.js`);
            writeFileSync(worker, withPrecache(readFileSync(worker, `utf8`), { build, urls }));
            const kib = (count: number): number => Math.round(count / 1024);
            this.info(
                `offline precache: ${urls.length} files, ${kib(weight.bytes)} KiB (${kib(weight.gzipped)} KiB gzipped), ` +
                    `of which the boot graph every load fetches is ${kib(weight.bootBytes)} KiB (${kib(weight.bootGzipped)} KiB gzipped)`,
            );
        },
    };
};
