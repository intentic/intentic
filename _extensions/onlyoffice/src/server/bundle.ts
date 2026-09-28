import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { once } from "node:events";
import { createGunzip } from "node:zlib";
import type { BundlePin } from "./bundle-pin.js";
import { readTar, type TarBody } from "./tar.js";

// The browser engine's editor bundle on this sandbox's disk. It is fetched once per pin, every kept file hashed on the
// way in, and the tree becomes the one the listener serves only once all of it matched the pin: an interrupted or
// altered download is never half-served. It lives in the workspace's rebuildable cache, which the watcher ignores.

export type BundleState =
    | { readonly state: "absent" }
    | { readonly state: "downloading"; readonly percent: number | undefined }
    | { readonly state: "ready"; readonly dir: string }
    | { readonly state: "failed"; readonly detail: string };

export interface BundleDeps {
    // The directory pins are kept in, one subdirectory each; anything else found there is a pin no longer in use.
    readonly root: string;
    readonly pin: BundlePin;
    readonly log: (line: string) => void;
    readonly fetch?: typeof fetch;
    // A download that receives nothing for this long has stalled, and fails rather than holding the ring forever.
    readonly stallMs?: number;
}

// Written last, inside the tree, naming the digest it was verified against.
const MARKER = ".verified";
const STALL_MS = 60_000;

// A relative, forward-slash path that cannot leave the directory it is joined to.
export const isSafeRelative = (path: string): boolean =>
    path !== "" &&
    !path.includes("\0") &&
    !path.includes("\\") &&
    !path.startsWith("/") &&
    path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");

// Where an archive entry is kept in the bundle, or undefined for one that is not kept or whose path cannot be trusted.
export const keptPath = (pin: BundlePin, entry: string): string | undefined => {
    if (!entry.startsWith(pin.stripPrefix)) {
        return undefined;
    }
    const inner = entry.slice(pin.stripPrefix.length);
    for (const [from, to] of pin.keep) {
        const kept = from.endsWith("/") ? inner.startsWith(from) && inner.length > from.length : inner === from;
        if (kept) {
            const path = `${to}${inner.slice(from.length)}`;
            return isSafeRelative(path) ? path : undefined;
        }
    }
    return undefined;
};

// The digest a pin names: each kept file's bundle path and sha256 (hex), one line each, in path order.
export const treeDigest = (files: ReadonlyMap<string, string>): string => {
    const hash = createHash("sha256");
    for (const path of [...files.keys()].sort()) {
        hash.update(`${path}\0${files.get(path) ?? ""}\n`);
    }
    return hash.digest("hex");
};

// Applies a pin's patches to the tree at `dir`; each must find its text exactly once.
const applyPatches = async (pin: BundlePin, dir: string): Promise<void> => {
    for (const patch of pin.patches) {
        const file = join(dir, patch.file);
        const source = await readFile(file, "utf8");
        const at = source.indexOf(patch.find);
        if (at === -1 || source.includes(patch.find, at + 1)) {
            throw new Error(`the editor bundle's ${patch.file} no longer reads as its patch expects (${patch.why})`);
        }
        await writeFile(file, `${source.slice(0, at)}${patch.replace}${source.slice(at + patch.find.length)}`);
    }
};

// Writes one entry's bytes to `target` and answers their sha256.
const writeHashed = async (body: TarBody, target: string): Promise<string> => {
    await mkdir(dirname(target), { recursive: true });
    const hash = createHash("sha256");
    const out = createWriteStream(target);
    try {
        for await (const chunk of body) {
            hash.update(chunk);
            if (!out.write(chunk)) {
                await once(out, "drain");
            }
        }
        out.end();
        await finished(out);
    } catch (error) {
        out.destroy();
        throw error;
    }
    return hash.digest("hex");
};

export class BundleStore {
    private current: BundleState = { state: "absent" };
    private inspected: Promise<void> | undefined;
    private download: Promise<void> | undefined;

    constructor(private readonly deps: BundleDeps) {}

    // The segment the tree is served under, /bundle/<id>/.
    get pinId(): string {
        return this.deps.pin.id;
    }

    private get dir(): string {
        return join(this.deps.root, this.deps.pin.id);
    }

    private get partial(): string {
        return `${this.dir}.partial`;
    }

    // Where things stand, as last known; `load` first for the answer the disk gives.
    state(): BundleState {
        return this.current;
    }

    // Reads the disk once: this pin's verified tree is ready at once. An interrupted download and every other pin's tree
    // are removed, since nothing will serve them again.
    async load(): Promise<BundleState> {
        this.inspected ??= this.inspect();
        await this.inspected;
        return this.current;
    }

    // Starts the download unless the tree is here or already on its way, and answers where things stand right after.
    async ensure(): Promise<BundleState> {
        await this.load();
        if (this.download === undefined && (this.current.state === "absent" || this.current.state === "failed")) {
            this.current = { state: "downloading", percent: 0 };
            this.download = this.fetchTree().finally(() => {
                this.download = undefined;
            });
        }
        return this.current;
    }

    // Settles when the download in flight, if any, has ended.
    async settled(): Promise<BundleState> {
        await this.download;
        return this.current;
    }

    private async inspect(): Promise<void> {
        const { root, pin, log } = this.deps;
        await mkdir(root, { recursive: true });
        for (const entry of await readdir(root)) {
            if (entry !== pin.id) {
                log(`removing ${entry} from the editor bundle cache: not the pinned bundle`);
                await rm(join(root, entry), { recursive: true, force: true });
            }
        }
        let marker: string | undefined;
        try {
            marker = (await readFile(join(this.dir, MARKER), "utf8")).trim();
        } catch (error) {
            // SAFETY: fs rejects with a NodeJS.ErrnoException; only its code is read.
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw error;
            }
        }
        if (marker === pin.digest) {
            this.current = { state: "ready", dir: this.dir };
            return;
        }
        // A tree without its marker (or with another digest's) was never finished here; it goes.
        await rm(this.dir, { recursive: true, force: true });
    }

    private async fetchTree(): Promise<void> {
        const { pin, log } = this.deps;
        const controller = new AbortController();
        // The body being read, once there is one: a stall ends it directly, since aborting the request does not reach a
        // body that is already streaming everywhere fetch is implemented.
        let compressed: Readable | undefined;
        let stall: ReturnType<typeof setTimeout> | undefined;
        let stalled = false;
        const armStall = (): void => {
            clearTimeout(stall);
            stall = setTimeout(() => {
                stalled = true;
                controller.abort();
                compressed?.destroy(new Error(`the download stalled`));
            }, this.deps.stallMs ?? STALL_MS);
        };
        log(`downloading the editor bundle ${pin.id}`);
        try {
            await rm(this.partial, { recursive: true, force: true });
            await mkdir(this.partial, { recursive: true });
            armStall();
            const response = await (this.deps.fetch ?? fetch)(pin.url, { signal: controller.signal });
            if (!response.ok || response.body === null) {
                throw new Error(`the download answered ${response.status}`);
            }
            let received = 0;
            // SAFETY: fetch's body is a web ReadableStream of bytes; the DOM and node typings of it only disagree in name.
            compressed = Readable.fromWeb(response.body as never);
            compressed.on("data", (chunk: Buffer) => {
                received += chunk.length;
                armStall();
                const percent = pin.approximateBytes > 0 ? Math.min(99, Math.floor((received / pin.approximateBytes) * 100)) : undefined;
                this.current = { state: "downloading", percent };
            });
            const files = new Map<string, string>();
            const gunzip = createGunzip();
            compressed.on("error", (error) => gunzip.destroy(error));
            await readTar(compressed.pipe(gunzip), async (entry, body) => {
                const path = entry.type === "file" ? keptPath(pin, entry.name) : undefined;
                if (path !== undefined) {
                    files.set(path, await writeHashed(body, join(this.partial, path)));
                }
            });
            if (files.size !== pin.files || treeDigest(files) !== pin.digest) {
                throw new Error(`the downloaded files do not match the pinned bundle (${files.size} of ${pin.files} files)`);
            }
            await applyPatches(pin, this.partial);
            await writeFile(join(this.partial, MARKER), `${pin.digest}\n`);
            await rename(this.partial, this.dir);
            this.current = { state: "ready", dir: this.dir };
            log(`editor bundle ${pin.id} ready: ${files.size} files`);
        } catch (error) {
            // Stops the transfer when what failed was the tar or the disk, not the network.
            controller.abort();
            const detail = stalled ? `the download stalled` : error instanceof Error ? error.message : String(error);
            this.current = { state: "failed", detail: `The editor could not be downloaded: ${detail}.` };
            log(`editor bundle download failed: ${detail}`);
            await rm(this.partial, { recursive: true, force: true }).catch((cleanup: Error) => {
                log(`could not remove the partial editor bundle: ${cleanup.message}`);
            });
        } finally {
            clearTimeout(stall);
        }
    }
}
