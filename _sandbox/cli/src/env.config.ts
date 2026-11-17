import { type ConfigDefinition, env, loadConfig as loadPuristicConfig } from "@puristic/env/index.js";
import { z } from "zod";

// Typed process-level config for the CLI; @puristic/env derives each env var name from the schema path
// (camelToScreamingSnake, joined with `_`).
const configSchema = z.object({
    // Keep the JS stack on a thrown error instead of the one-line message (app.ts formatException).
    intenticDebug: z
        .string()
        .default("")
        .transform((value) => value !== ""),
    // How a command renders: prose (default), one JSON document, or a NDJSON stream.
    intenticOutput: z.enum(["text", "json", "ndjson"]).catch("text"),
});

// No cliArgs() source; stricli owns flags/args.
const definition = {
    schema: configSchema,
    sources: [env()],
} satisfies ConfigDefinition<typeof configSchema>;

export type Config = z.infer<typeof configSchema>;

export const loadConfig = (): Config => loadPuristicConfig(definition);
