import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { packageRoot } from "@intentic/constants/node";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";

// A pack is one checked-in Dockerfile fragment (packs/<name>.Dockerfile), spliced into published images by
// compose-image-dockerfile.mjs and composed into the overlay on demand from the same file. The base image stamps its
// content hash; packFragment returns undefined once it matches, so a rebuild converges instead of re-proposing it.

// Anchored to the package's own root, not this file's location, so it resolves in both dist and src layouts.
const packsDir = join(packageRoot(import.meta.url), "image-packs");

// Base image's stamp directory (content hash per baked pack); absent reads as not-baked. Read per call via env var, so
// tests can point it elsewhere.
const packStampsDir = (): string => process.env["INTENTIC_PACK_STAMPS_DIR"] ?? "/opt/packs";

export interface Pack {
    readonly name: string;
    readonly content: string;
    readonly hash: string;
    // No COPY instruction, composable into a rebuild overlay, not only a published profile.
    readonly overlayable: boolean;
    // Needs the daemon tree, so it splices after the image's tree COPYs.
    readonly postTrees: boolean;
}

const packOf = (name: string, raw: string): Pack => {
    const content = raw.trim();
    return {
        name,
        content,
        hash: sha256Hex(content),
        overlayable: !/^\s*copy\s/im.test(content),
        postTrees: content.includes("/opt/sandbox") || content.includes("--from=trees"),
    };
};

export const readPack = async (name: string): Promise<Pack | undefined> => {
    const raw = await readFile(join(packsDir, `${name}.Dockerfile`), "utf8").catch(() => undefined);
    return raw === undefined ? undefined : packOf(name, raw);
};

export const listPacks = async (): Promise<Pack[]> => {
    const entries = (await readdir(packsDir)).filter((entry) => entry.endsWith(".Dockerfile")).toSorted();
    const raws = await Promise.all(entries.map((entry) => readFile(join(packsDir, entry), "utf8")));
    return entries.map((entry, index) => packOf(entry.slice(0, -".Dockerfile".length), raws[index] ?? ""));
};

// The base image's stamped hash for this pack, or undefined when the base doesn't bake it. `stampsDir` is a param for
// tests only; runtime callers read the image's own stamps.
export const bakedPackHash = async (name: string, stampsDir: string = packStampsDir()): Promise<string | undefined> =>
    (await readFile(join(stampsDir, name), "utf8").catch(() => undefined))?.trim();

// The pack's overlay fragment: its content when the running base image doesn't already bake this version, else
// undefined (also when bake-only or unknown). One path makes a baked feature instant, an unbaked one an ordinary
// rebuild.
export const packFragment = async (name: string, stampsDir: string = packStampsDir()): Promise<string | undefined> => {
    const pack = await readPack(name);
    if (pack === undefined || !pack.overlayable) {
        return undefined;
    }
    return (await bakedPackHash(name, stampsDir)) === pack.hash ? undefined : pack.content;
};
