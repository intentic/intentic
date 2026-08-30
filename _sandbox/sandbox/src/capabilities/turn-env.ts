import type { Services } from "../composition.js";
import { extensionEnvOf } from "../extensions/extension-env.js";
import { extensionBinDirsOf } from "../extensions/installed-extensions.js";
import { cliEnvOf } from "./cli-env.js";

/* THE ENVIRONMENT A TURN'S SHELL RUNS WITH, before any persona has narrowed it: connected cli-kind
 * capabilities (cli-env.ts), the settings installed extensions contribute (extension-env.ts), and the PATH
 * that makes an extension's shipped CLI resolve by name.
 *
 * Extracted from streamAgent, where it was three inline awaits, once a SECOND caller appeared that has to
 * produce the same environment: restoring an armed condition watch at boot (agent/watchers.ts) re-derives the
 * check's env rather than reading a snapshot of it off disk, and a re-derivation that drifted from what a turn
 * actually gets would be the worst kind of difference, one that only shows up hours after a restart. One
 * function, both callers, so the drift cannot happen.
 *
 * DERIVED, NEVER STORED. Every value here is read live from the capability store and the extension settings,
 * which is what makes it safe for a restored watch to ask for it again: a credential rotated while the daemon
 * was down comes back current, and one revoked while it was down does not come back at all. */
export const turnCliEnv = async (services: Services): Promise<Record<string, string>> => {
    // cli-kind capabilities contribute their stored credentials so the shell can run their CLI tools;
    // extension `contributes.settings` with an `env` name inject theirs the same way.
    const env = { ...(await cliEnvOf(services)), ...(await extensionEnvOf(services)) };
    // Extensions that ship an agent CLI (contributes.bin, e.g. ext-discord's `discord-voice`) get their bin
    // dir prepended, so the tool resolves by name in the agent's shell across every runtime.
    const binDirs = await extensionBinDirsOf(services);
    if (binDirs.length > 0) {
        env["PATH"] = [...binDirs, process.env["PATH"] ?? ""].filter((entry) => entry !== "").join(":");
    }
    return env;
};
