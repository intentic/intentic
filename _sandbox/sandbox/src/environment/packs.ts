import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { packageRoot } from "@intentic/constants/node";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";

/* Feature packs, the single unit of image growth. A pack is a checked-in Dockerfile fragment
 * (packs/<name>.Dockerfile in this package): the SAME file is spliced into a published image by
 * _tools/scripts/image/compose-image-dockerfile.mjs when a profile bakes it (packs/profiles.json), and composed into
 * the environment overlay by a capability/provider that needs it on demand, one source, so the baked and
 * on-demand paths cannot drift.
 *
 * Whether the BASE image already carries a pack is a publish-time fact stamped INTO the image: the splice
 * appends a RUN writing the pack file's content hash to /opt/packs/<name>. packFragment() reads the stamp and
 * returns undefined for a base-baked pack, which is what keeps the composed overlay STABLE across rebuilds.
 * An overlay-applied pack deliberately never stamps: if it did, the post-rebuild recompose would drop the
 * fragment, change the overlay content and hash, and ask the owner to rebuild again forever. A stamp whose
 * hash no longer matches the shipped pack file reads as "not baked": the overlay then carries the newer pack
 * on top of the older base, which is the upgrade path, the same fragment-drift convergence boot already does.
 *
 * Two properties are inferred from content, not declared, so they cannot rot:
 *   - a pack with a COPY instruction is BAKE-ONLY (an overlay build has no `trees` build context), profiles
 *     can include it, packFragment() never returns it;
 *   - a pack referencing the daemon tree (/opt/sandbox) or a trees COPY splices AFTER the image's tree COPYs
 *     (the Dockerfile's post-trees marker); everything else splices before them, where pinned-install layers
 *     stay cache-stable across source changes. */

// packs/ ships inside the deployed package (package.json has no `files` allowlist). Anchored to the package's
// OWN root rather than counted back from this file, so it resolves from dist/environment in the image
// (/opt/sandbox/packs) and from src/environment in a dev run alike, and keeps doing so if this file moves.
const packsDir = join(packageRoot(import.meta.url), "packs");

/* Where the image-compose splice stamps what the BASE image bakes (content hash per pack). An absent stamp,
 * core image, dev run, or a pack newer than this base, reads as "not baked".
 *
 * THE ONE FACT IN THIS MODULE THAT COMES FROM THE MACHINE, so it is read per call and can be pointed
 * elsewhere. `bakedPackHash` and `packFragment` take the directory as an argument for the same reason and
 * suites that call them directly pass their own; a suite that reaches this code through `composeEnvironment`
 * cannot, and read the HOST's stamps instead — which made it assert one thing on CI, where /opt/packs does not
 * exist, and the opposite inside an agent sandbox, where it exists and matches the very packs the composed
 * capabilities name. That is the ambient-machine reading AGENTS.md names: state the mode a test means. */
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

// The hash the base image was stamped with for this pack, or undefined when the base doesn't bake it.
// `stampsDir` is parameterized for tests only, every runtime caller reads the image's own stamps.
export const bakedPackHash = async (name: string, stampsDir: string = packStampsDir()): Promise<string | undefined> =>
    (await readFile(join(stampsDir, name), "utf8").catch(() => undefined))?.trim();

// The pack's overlay fragment: its content when the running BASE image doesn't already bake this exact
// version, undefined when it does (or the pack is bake-only/unknown). One code path is what makes enabling a
// feature instant on an image that bakes the pack and an ordinary owner-approved rebuild on one that doesn't.
export const packFragment = async (name: string, stampsDir: string = packStampsDir()): Promise<string | undefined> => {
    const pack = await readPack(name);
    if (pack === undefined || !pack.overlayable) {
        return undefined;
    }
    return (await bakedPackHash(name, stampsDir)) === pack.hash ? undefined : pack.content;
};
