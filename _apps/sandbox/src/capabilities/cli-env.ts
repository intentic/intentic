import type { ExtensionHost } from "../extensions/installed-extensions.js";
import { contributionEnv, contributionFor, contributionRegistry } from "./contributions.js";

// A capability id (a validated slug) → the suffix its env vars carry, so N instances of the same provider don't
// collide on one flat env. `analytics` → `POSTGRES_URL_ANALYTICS`; the default-named `github` → `GITHUB_TOKEN_GITHUB`.
// ponytail: ids differing only by case or `-`/`_` (my-db vs my_db) map to the same suffix — last wins, as before.
export const envSuffix = (id: string): string => id.toUpperCase().replaceAll("-", "_");

// The env vars the agent's shell needs for its connected CLI tools, derived from cli-kind capabilities each
// turn — the parallel to mcpToolsOf for the CLI path. Merged into the agent SDK's `env` (see agent.ts). Each
// connector's env template is expanded (contributionEnv) and every var suffixed with the instance id so two of the
// same provider coexist; the per-instance SKILL.md (written by cliHandler.apply) names the exact vars, so the
// agent never has to guess them. Provider data lives in an installed extension's connector (contributionRegistry).
export const cliEnvOf = async (host: ExtensionHost): Promise<Record<string, string>> => {
    const registry = await contributionRegistry(host);
    const env: Record<string, string> = {};
    for (const capability of await host.capabilities.list()) {
        if (capability.kind !== "cli") {
            continue;
        }
        const connector = contributionFor(registry, "cli", capability.config);
        if (connector === undefined) {
            continue;
        }
        const suffix = envSuffix(capability.id);
        for (const [key, value] of Object.entries(contributionEnv(connector.spec, capability.config))) {
            env[`${key}_${suffix}`] = value;
        }
    }
    return env;
};
