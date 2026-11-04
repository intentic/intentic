import { join } from "node:path";
import { readTextIfExistsSync } from "@intentic/base/fs";
import type { Profile, SandboxMode } from "@intentic/constants";

// The sandbox half of how a new sandbox runs: a definition the platform hands a new machine as SANDBOX_DEFINITION_SEED,
// which the daemon applies once on an empty workspace. One file per mode that needs one (`<mode>.sandbox.toml`):
// hands-off has its file, hands-on has none, since a sandbox with nothing applied to it IS hands-on. The mode is its
// maker's answer to "Who handles the code here?", asked where the sandbox is made; anything that is a fact about the
// sandbox (its settings, which extensions are on) is here, because a sandbox outlives the browser that asked for it.
// The directory keeps its old name: the daemon's profile-definitions.test.ts reads every seed in it with the real parser.

const DIR = import.meta.dirname;

// Read once per mode and kept: these are checked-in files, and the value is handed to every provision.
const seeds = new Map<SandboxMode, string>();

/**
 * How a new sandbox runs, from what a caller sent: `mode` when it names one, otherwise the older spelling of the same
 * answer, which desktop apps from before the question still send when they re-mint a setup code (`profile=desk` meant
 * hands-off). Undefined is hands-on, a sandbox with nothing applied to it.
 */
export const arrivalMode = (ask: { readonly mode?: SandboxMode | undefined; readonly profile?: Profile | undefined }): SandboxMode | undefined =>
    ask.mode ?? (ask.profile === "desk" ? "hands-off" : undefined);

/**
 * The base64 TOML for `mode`, ready to be an env value, or undefined when that mode declares no sandbox of its own,
 * which hands-on does not.
 */
export const definitionSeedFor = (mode: SandboxMode | undefined): string | undefined => {
    if (mode === undefined || mode === "hands-on") {
        return undefined;
    }
    const held = seeds.get(mode);
    if (held !== undefined) {
        return held;
    }
    // A mode whose file is missing provisions a plain sandbox rather than failing the provision: the machine is what
    // the reader asked for, and its owner can still switch it to hands-off in its settings.
    const toml = readTextIfExistsSync(join(DIR, `${mode}.sandbox.toml`));
    if (toml === undefined) {
        return undefined;
    }
    const seed = Buffer.from(toml, "utf8").toString("base64");
    seeds.set(mode, seed);
    return seed;
};

/** The env var the daemon reads its seed from (sandbox env.config.ts `definitionSeed`). */
export const ENV_DEFINITION_SEED = "SANDBOX_DEFINITION_SEED";
