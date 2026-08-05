import { type ConfigDefinition, env, loadConfig as loadPuristicConfig } from "@puristic/env/index.js";
import { z } from "zod";

// Env-derived config (var names follow @puristic/env's camelToScreamingSnake): WORKSPACE_ROOT, INTENTIC_OUTPUT,
// IQ_MODEL_DIR, IQ_RG_PATH, IQ_DEBUG. Flags always beat env (lib/flags.ts).
const configSchema = z.object({
    // The workspace to search; empty = current directory. The sandbox image pins this to /work.
    workspaceRoot: z.string().default(""),
    // Output rendering when no --json/--ndjson flag is given: agent-facing text (default), one JSON document, or
    // one JSON line per result group.
    intenticOutput: z.enum(["text", "json", "ndjson"]).catch("text"),
    // Baked embedding model dir; unset → natural-language queries degrade to keyword-expanded lexical search.
    iqModelDir: z.string().default(""),
    // Override the ripgrep binary resolved from PATH.
    iqRgPath: z.string().default(""),
    // Override ~/.claude for session recall (tests point this at a fixture dir).
    iqClaudeDir: z.string().default(""),
    // Retrieval-stage toggles for benchmarking (see parseFeatures): "bm25" = only BM25; "-rerank,-prf" = all
    // stages except those. Empty = full pipeline. The --features flag overrides this.
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
