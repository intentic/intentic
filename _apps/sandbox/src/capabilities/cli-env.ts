import type { Capability } from "@intentic/sandbox-contract";
import { cliProviders } from "./cli/providers.js";

// A capability id (a validated slug) → the suffix its env vars carry, so N instances of the same provider don't
// collide on one flat env. `analytics` → `POSTGRES_URL_ANALYTICS`; the default-named `github` → `GITHUB_TOKEN_GITHUB`.
// ponytail: ids differing only by case or `-`/`_` (my-db vs my_db) map to the same suffix — last wins, as before.
export const envSuffix = (id: string): string => id.toUpperCase().replaceAll("-", "_");

// The env vars the agent's shell needs for its connected CLI tools, derived from cli-kind capabilities each
// turn — the parallel to mcpToolsOf for the CLI path. Merged into the agent SDK's `env` (see agent.ts). Each
// var is suffixed with the instance id so two of the same provider coexist; the per-instance SKILL.md (written
// by cliHandler.apply) names the exact vars, so the agent never has to guess them.
export const cliEnvOf = (capabilities: readonly Capability[]): Record<string, string> => {
    const env: Record<string, string> = {};
    for (const capability of capabilities) {
        if (capability.kind === "cli") {
            const suffix = envSuffix(capability.id);
            for (const [key, value] of Object.entries(cliProviders[capability.config.provider].env(capability.config))) {
                env[`${key}_${suffix}`] = value;
            }
        }
    }
    return env;
};
