import { type ConfigDefinition, env, loadConfig as loadPuristicConfig } from "@puristic/env/index.js";
import { z } from "zod";

// Env-derived config; var names follow @puristic/env's camelToScreamingSnake (WORKSPACE_ROOT, IQ_MODEL_DIR, …). Flags
// beat env, see lib/flags.ts.
const configSchema = z.object({
    // Workspace to search; empty means the current directory. Pinned to /work in the sandbox image.
    workspaceRoot: z.string().default(""),
    // Output mode when no --json/--ndjson flag given: text, one JSON document, or one JSON line per group.
    intenticOutput: z.enum(["text", "json", "ndjson"]).catch("text"),
    // Baked embedding model dir; unset degrades natural-language queries to keyword lexical search.
    iqModelDir: z.string().default(""),
    // Override the ripgrep binary resolved from PATH.
    iqRgPath: z.string().default(""),
    // Override ~/.claude for session recall (tests point this at a fixture dir).
    iqClaudeDir: z.string().default(""),
    // Override the daemon's history volume holding the fleet registry; empty is the sandbox's own.
    iqHistoryRoot: z.string().default(""),
    // Retrieval-stage toggles for benchmarking: "bm25" alone, or "-x,-y" to exclude; empty runs the full pipeline.
    iqFeatures: z.string().default(""),
    // Keep the JS stack on a thrown error instead of the one-line message.
    iqDebug: z
        .string()
        .default("")
        .transform((value) => value !== ""),
});

const definition = {
    schema: configSchema,
    sources: [env()],
} satisfies ConfigDefinition<typeof configSchema>;

export type Config = z.infer<typeof configSchema>;

export const loadConfig = (): Config => loadPuristicConfig(definition);
