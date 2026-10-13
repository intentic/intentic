import { engineMissing } from "../../agent/providers/provider-module.js";
import { engineDescriptor } from "../../engines/engine-descriptors.js";
import { type EngineInstallOutcome, installEngine } from "../../engines/engine-install.js";
import { engineBinary, forgetEngineResolution } from "../../engines/engine-resolve.js";

// Muse Code is closed source with no redistribution grant, so no published image carries it: a turn on the Muse loop
// installs the pack's pin into the engine store the first time it needs one, and the owner's own overlay bakes it once a
// Meta account is on disk (minted-provider.ts `packs`). Resolved through the engine store first, then the image's PATH,
// where the pack puts it.

export const MUSE_CLI_MISSING = engineMissing("Muse Code", "Muse Code");

// The binary a Muse host runs, or undefined when neither the store nor the image has one.
export const museCli = (): Promise<string | undefined> => engineBinary("muse");

// Defaults to the engine store's install; parameterized so a suite can exercise miss/install/retry without a download.
export type MuseCliInstall = (id: "muse", version: string) => Promise<EngineInstallOutcome>;

// Process-wide, so two turns (or a turn and the boot warm-up) share one ~350 MB download; cleared on failure so the next
// turn tries again.
let installing: Promise<string> | undefined;

export const ensureMuseCli = async (install: MuseCliInstall = installEngine): Promise<string> => {
    const present = await museCli();
    if (present !== undefined) {
        return present;
    }
    installing ??= (async () => {
        const version = await engineDescriptor("muse").baked();
        if (version === undefined) {
            throw new Error("The Muse Code feature pack does not name exactly one CLI version.");
        }
        const outcome = await install("muse", version);
        if (!outcome.ok) {
            throw new Error(`Muse Code could not be installed: ${outcome.reason}`);
        }
        forgetEngineResolution("muse");
        const installed = await museCli();
        if (installed === undefined) {
            throw new Error("Muse Code installed, but its binary could not be found.");
        }
        return installed;
    })().finally(() => {
        installing = undefined;
    });
    return installing;
};
