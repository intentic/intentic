import { homedir } from "node:os";
import { join } from "node:path";
import { type ConfigDefinition, env, loadConfig as loadPuristicConfig } from "@puristic/env/index.js";
import { z } from "zod";

// Typed process-level config for the CLI; @puristic/env derives each env var name from the schema path
// (camelToScreamingSnake, joined with `_`). Only known config vars live here; secret values the graph references by a
// runtime key stay resolved directly via process.env, not this schema.
const configSchema = z.object({
    // Keep the JS stack on a thrown error instead of the one-line message (app.ts formatException).
    intenticDebug: z
        .string()
        .default("")
        .transform((value) => value !== ""),
    // How a command renders: prose (default), one JSON document, or a live NDJSON stream.
    intenticOutput: z.enum(["text", "json", "ndjson"]).catch("text"),
    // Where run logs land (pruned to newest 50); the sandbox daemon points this at /history/logs/intentic-runs.
    intenticLogDir: z.string().default(join(homedir(), ".intentic", "logs")),
    // Where resolve/plan/apply/adopt mirror ndjson events for the web to tail (daemon-set; empty for a human run).
    intenticEventsFile: z.string().default(""),
    // host-ssh-tunnel reads these from env connect.{sh,ps1} sets; the demo reads the token too.
    cloudflareApiToken: z.string().default(""),
    connectToken: z.string().default(""),
    zone: z.string().default(""),
    // Inventory name of the host being enrolled (connect-host.sh); salts its per-host SSH tunnel id.
    hostName: z.string().default(""),
    // demo dev-harness inputs: its zone, extra NODE_OPTIONS (the DoH hook), and local Forgejo/Komodo/SSH ports.
    cloudflareZone: z.string().default("intentic.dev"),
    nodeOptions: z.string().default(""),
    demo: z
        .object({
            sshPort: z.coerce.number().default(2222),
            forgejoPort: z.coerce.number().default(3000),
            komodoPort: z.coerce.number().default(9120),
        })
        .prefault({}),
});

// No cliArgs() source; stricli owns flags/args. The .env beside an artifact loads before this runs.
const definition = {
    schema: configSchema,
    sources: [env()],
} satisfies ConfigDefinition<typeof configSchema>;

export type Config = z.infer<typeof configSchema>;

export const loadConfig = (): Config => loadPuristicConfig(definition);
