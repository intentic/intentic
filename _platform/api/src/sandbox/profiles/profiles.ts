import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isProfile, type Profile } from "@intentic/constants";

// The sandbox half of a profile: a definition the platform hands a new machine as SANDBOX_DEFINITION_SEED, which the
// daemon applies once on an empty workspace. Only the browser halves (scheme, skin, audience) are decided in the
// browser; anything that is a fact about the sandbox — its rules, its settings, which extensions are on — is here,
// because a sandbox outlives the browser that asked for it.

const DIR = import.meta.dirname;

// Read once per profile and kept: these are checked-in files, and the value is handed to every provision.
const seeds = new Map<Profile, string>();

/**
 * The base64 TOML for `profile`, ready to be an env value, or undefined when that profile declares no sandbox of its
 * own — which `default` does not, since a sandbox with nothing applied to it IS the default.
 */
export const definitionSeedFor = (profile: string | undefined): string | undefined => {
    if (profile === undefined || !isProfile(profile) || profile === "default") {
        return undefined;
    }
    const held = seeds.get(profile);
    if (held !== undefined) {
        return held;
    }
    // A profile whose file is missing provisions a plain sandbox rather than failing the provision: the machine is what
    // the reader asked for, the decoration is not.
    let toml: string;
    try {
        toml = readFileSync(join(DIR, `${profile}.sandbox.toml`), "utf8");
    } catch {
        return undefined;
    }
    const seed = Buffer.from(toml, "utf8").toString("base64");
    seeds.set(profile, seed);
    return seed;
};

/** The env var the daemon reads its seed from (sandbox env.config.ts `definitionSeed`). */
export const ENV_DEFINITION_SEED = "SANDBOX_DEFINITION_SEED";
