import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

// The overlay layers an isolated turn's mirrors are mounted from (isolation.ts): how their options are spelled, and how
// a layer is made ready to mount again, volatile where the kernel allows it.

// A bind kept one st_dev, letting pnpm hardlink installs into tracked files; an overlay copies-up on first write
// instead, and a cross-device hardlink throws EXDEV.
// Shown by `mount`/`df`; named for what it is rather than another anonymous `overlay` row.
export const OVERLAY_FS_NAME = "intentic-modules";

// Overlay options are one comma-separated word; the kernel splits on `,`/`:` with no escaping. Refuses a path
// containing either, so a collision fails loudly (`set -e`) instead of silently mounting the wrong thing.
export const overlayOptions = (lower: string, upper: string, work: string): string => {
    for (const path of [lower, upper, work]) {
        if (path.includes(",") || path.includes(":")) {
            throw new Error(`turn isolation: overlay path cannot contain "," or ":", ${path}`);
        }
    }
    return `lowerdir=${lower},upperdir=${upper},workdir=${work}`;
};

// The kernel's id for this boot. A layer mounted volatile is trusted again only within the boot that wrote it.
const BOOT_ID = "/proc/sys/kernel/random/boot_id";
// Beside a layer's upper and work: the boot it was last mounted volatile in.
const LAYER_BOOT = "volatile-boot";

const readTrimmed = (path: string): Promise<string | undefined> =>
    readFile(path, "utf8").then(
        (text) => text.trim(),
        // allow(silent-catch): an absent file is the answer here (no boot recorded, or a kernel that names none).
        () => undefined,
    );

// This boot, as the kernel names it (BOOT_ID), or undefined where it names none.
export const currentBoot = (): Promise<string | undefined> => readTrimmed(BOOT_ID);

// Volatile overlays skip every sync to the upper filesystem, the one on unmount included, which otherwise costs a full
// syncfs of /history per overlay: a turn's 157 of them took 21 s to tear down on a busy disk (2026-10-13, measured),
// against 30 to 50 ms volatile. The price is that writes still in memory when the machine goes down are lost, so the
// kernel leaves a marker in the work dir and refuses the layer until it is cleared. Cleared here within the boot that
// wrote it, which nothing interrupted; a layer last mounted volatile in an earlier boot is thrown away and starts
// empty, since what it holds (installs and build output over the main checkout's) is rebuilt, and half-written it would
// be wrong without saying so.
export const prepareLayer = async (layer: string, boot: string | undefined): Promise<"kept" | "discarded"> => {
    const recorded = await readTrimmed(join(layer, LAYER_BOOT));
    const stale = recorded !== undefined && recorded !== boot;
    if (stale) {
        await rm(join(layer, "upper"), { recursive: true, force: true });
        await rm(join(layer, "work"), { recursive: true, force: true });
        await rm(join(layer, LAYER_BOOT), { force: true });
    } else {
        await rm(join(layer, "work", "work", "incompat"), { recursive: true, force: true });
    }
    await mkdir(join(layer, "upper"), { recursive: true });
    await mkdir(join(layer, "work"), { recursive: true });
    if (boot !== undefined && (stale || recorded !== boot)) {
        await writeFile(join(layer, LAYER_BOOT), `${boot}\n`);
    }
    return stale ? "discarded" : "kept";
};
