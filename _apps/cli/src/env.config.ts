import { homedir } from "node:os";
import { join } from "node:path";
import { type ConfigDefinition, env, loadConfig as loadPuristicConfig } from "@puristic/env/index.js";
import { z } from "zod";

// Typed process-level config for the CLI. @puristic/env derives each env var name from the schema path
// (camelToScreamingSnake per segment, joined with "_"): intenticOutput → INTENTIC_OUTPUT, cloudflareApiToken →
// CLOUDFLARE_API_TOKEN, demo.sshPort → DEMO_SSH_PORT — so the schema shape reproduces the fixed names the
// connect scripts / CI / demo set. Only the KNOWN config vars live here. Secret VALUES the graph references by
// a runtime key (env() secrets, generated passwords) are NOT config — they stay resolved by direct
// process.env[key] lookups (resolve/adopt/deployments) and by `resolveInputs(..., process.env, ...)`, because
// their keys come from the user's graph, not this schema.
const configSchema = z.object({
    // Keep the JS stack on a thrown error instead of the one-line message (app.ts formatException).
    intenticDebug: z
        .string()
        .default("")
        .transform((value) => value !== ""),
    // How a command renders: human prose (default), one JSON document, or a live NDJSON event stream. A backend
    // driving the CLI as a subprocess sets it once; humans get `text`.
    intenticOutput: z.enum(["text", "json", "ndjson"]).catch("text"),
    // Where deploy-lifecycle run logs land (one file per run, pruned to the newest 50 — lib/run-log.ts). The
    // sandbox daemon points this at /history/logs/intentic-runs; operator shells default to ~/.intentic/logs.
    intenticLogDir: z.string().default(join(homedir(), ".intentic", "logs")),
    // Where resolve/plan/apply/adopt mirror their structured ndjson event stream for the web to tail
    // (daemon-set, per-run; empty for a human run, which only renders to the pane). The daemon truncates it and
    // writes the {kind:"start"} marker before each run, then tails it (the apply job's durable file at
    // /intentic/apply/events; a per-run file for the check flow's resolve/plan).
    intenticEventsFile: z.string().default(""),
    // sandbox-tunnel reads these straight from the env connect.{sh,ps1} sets; the demo reads the token too.
    cloudflareApiToken: z.string().default(""),
    connectToken: z.string().default(""),
    zone: z.string().default(""),
    // The inventory name of the host being enrolled (connect-host.sh) — salts its per-host SSH tunnel id.
    hostName: z.string().default(""),
    // demo dev-harness (dist/demo.js) inputs: the Cloudflare zone it provisions under, an extra NODE_OPTIONS to
    // prepend (the DoH import hook), and the host ports it publishes Forgejo/Komodo/SSH on for local browsing.
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

// Real env only — stricli owns the CLI's flags/args, so there is no cliArgs() source here. The `.env` beside an
// artifact is loaded into process.env (loadEnvFile) before loadConfig() runs, so env() picks those up too.
const definition = {
    schema: configSchema,
    sources: [env()],
} satisfies ConfigDefinition<typeof configSchema>;

export type Config = z.infer<typeof configSchema>;

export const loadConfig = (): Config => loadPuristicConfig(definition);
