import { writeFile } from "node:fs/promises";
import { collectSecretUsage, type DesiredStateGraph } from "@intentic/graph";
import { renderTemplate } from "../lib/templates.js";

// Every secret the resolved graph requires, split by who provides it: `env` — the user supplies it in the
// environment; `generated` — intentic creates and persists it. Each bucket is de-duplicated and sorted.
export const collectSecrets = (graph: DesiredStateGraph): { readonly env: string[]; readonly generated: string[] } => {
    const usage = collectSecretUsage(graph);
    return {
        env: usage.filter((u) => u.source === "env").map((u) => u.key),
        generated: usage.filter((u) => u.source === "generated").map((u) => u.key),
    };
};

// The `.env.example` beside the artifact: one `KEY=` line per user-supplied secret, with a header so a user
// knows to copy it to `.env` and fill each value in. Valid for `process.loadEnvFile` (# comments ok).
export const writeEnvExample = async (path: string, keys: readonly string[]): Promise<void> => {
    await writeFile(path, renderTemplate("env-example", { keys }));
};
