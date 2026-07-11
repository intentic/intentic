import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";
import type { DesiredStateGraph } from "@intentic/graph";
import {
    ACCESS_FILE,
    APP_DIR,
    ARTIFACT_FILE,
    CONFIG_FILE,
    ENV_FILE,
    INTENT_DIR,
    KNOWN_HOSTS_FILE,
    LAST_APPLIED_FILE,
    SECRETS_FILE,
    STATUS_FILE,
    TARGET_DIR,
} from "@intentic/scaffold";

// Re-export the canonical workspace-layout constants so existing CLI-internal consumers keep working.
export {
    ACCESS_FILE,
    APP_DIR,
    ARTIFACT_FILE,
    CONFIG_FILE,
    ENV_FILE,
    INTENT_DIR,
    KNOWN_HOSTS_FILE,
    LAST_APPLIED_FILE,
    SECRETS_FILE,
    STATUS_FILE,
    TARGET_DIR,
};

// The defaults every command resolves against cwd: the config in the intent repo, the artifact in the
// desired-state repo. `init` scaffolds both repos at these same paths.
export const CONFIG_PATH = join(INTENT_DIR, CONFIG_FILE);
export const ARTIFACT_PATH = join(TARGET_DIR, ARTIFACT_FILE);

export const readArtifact = async (path: string): Promise<DesiredStateGraph> => {
    const graph = JSON.parse(await readFile(path, "utf8")) as DesiredStateGraph;
    if (graph.version !== 1) {
        throw new Error(`${path} is not a desired-state artifact (expected version 1)`);
    }
    return graph;
};

export const writeArtifact = async (path: string, graph: DesiredStateGraph): Promise<void> =>
    writeFile(path, `${JSON.stringify(graph, undefined, 4)}\n`);

export const writeStatus = async (path: string, status: unknown): Promise<void> => writeFile(path, `${JSON.stringify(status, undefined, 4)}\n`);

// `apply`/`plan` resolve secrets from process.env; load them from the `.env` beside the artifact being
// executed. Optional: a missing file is fine — CI or the shell may set the vars directly. A var that is
// already set but EMPTY is filled from the file: launchers pass secrets as `-e KEY="$MAYBE_EMPTY"`, and an
// empty inherited var must not shadow the real value written to .env later.
export const loadEnvFile = (dir: string): void => {
    const path = join(dir, ENV_FILE);
    if (!existsSync(path)) {
        return;
    }
    for (const [key, value] of Object.entries(parseEnv(readFileSync(path, "utf8")))) {
        if (process.env[key] === undefined || process.env[key] === "") {
            process.env[key] = value;
        }
    }
};
