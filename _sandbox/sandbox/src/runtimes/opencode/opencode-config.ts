import type { ConfigEntry, PermissionRule } from "@opencode/client";
import { type InputModality, OPENCODE_GEMINI_PROVIDER } from "../gemini/gemini-models.js";

// One config document as OpenCode 2 reads it; the client names it only as the body of a config entry.
export type OpenCodeConfig = Extract<ConfigEntry, { type: "document" }>["info"];

// The configuration the daemon's `opencode serve` runs with, in OpenCode 2's shape. All of it is handed over inline at
// spawn (OPENCODE_CONFIG_CONTENT), which OpenCode loads last, so it outranks every file a person or a repo could write.

// OpenCode's own off switches, pinned on the spawn so they hold in a bare dev run as well as in the image. Without
// DISABLE_PROJECT_CONFIG, a cloned repo's opencode.json or .opencode/ would configure this runtime: plugins that run
// inside the server, custom tools that replace a built-in by name (and so slip past ASK_ABOUT), MCP servers, and
// permission rules. Checked against 2.0.26, a planted .opencode/plugins/*.js and .opencode/tools/*.ts stay unloaded.
// Skipping project config also skips OpenCode's own read of the repo's AGENTS.md, which the daemon already composes
// into every turn (agent/prompt/workspace-memory.ts). The daemon's own MCP servers go on per turn through the server's
// API (`mount`), which no file in a repo reaches. Auto-update is off because the binary is pinned and installed by the
// engine store, never by OpenCode itself.
export const OPENCODE_LOCKDOWN_ENV = { OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_AUTOUPDATE: "1" } as const;

// Shell commands the owner's rulebook gets to see before they run. Everything else is allowed outright, so most calls
// cost no round trip; a match is asked about, and the daemon answers it (opencode-permissions.ts). A resource is the
// command line itself, matched as a whole with `*` spanning anything.
export const ASK_ABOUT: readonly string[] = [
    "*git push*",
    "*git reset*",
    "*git clean*",
    "*git branch*",
    "*git filter-branch*",
    "*rm *",
    "*.env*",
    "*.ssh/*",
    "*id_rsa*",
    "*id_ed25519*",
    "*.npmrc*",
    "*credentials*",
    "*publish*",
    "*release create*",
    "*docker push*",
    "*twine upload*",
    "*curl *",
    "*wget *",
];

// OpenCode 2's rules are an ordered list where the last match wins and an unmatched call is asked about. Every agent
// starts from OpenCode's own base (allow everything, but ask before leaving the workspace and before reading a .env
// file), then its own (`plan` denies edits outside its plan files), then these, then the session's own (opencode-mcp.ts).
// So these take back only what nothing on this runtime could answer but the daemon, and never re-allow everything,
// which would undo the plan agent's read-only rule:
// - leaving the workspace and reading .env files, allowed as OpenCode 1 allowed them here; a shell command that reads
//   one is still asked about below.
// - `question`, OpenCode's form to the person: the capability row says `questions: false`, and a form nobody renders
//   would park the turn until its watchdog.
// - `execute`, the code-mode runner over MCP catalogs: every server the daemon mounts exposes its tools directly
//   (opencode-mcp.ts), so it would run nothing, and is one more tool for the model to misuse.
// - the shell commands above, asked about.
// A denied action's tool is not offered to the model at all.
export const SERVER_PERMISSIONS: readonly PermissionRule[] = [
    { action: "external_directory", resource: "*", effect: "allow" },
    { action: "read", resource: "*", effect: "allow" },
    { action: "question", resource: "*", effect: "deny" },
    { action: "execute", resource: "*", effect: "deny" },
    ...ASK_ABOUT.map((resource): PermissionRule => ({ action: "shell", resource, effect: "ask" })),
];

// What a Gemini turn needs declared at server spawn; absent means no Gemini provider registered. `models` is a thunk
// since the Gemini catalog is built after this service in the composition order, read lazily at boot and acquisition.
export interface OpenCodeGeminiConfig {
    // The translator's base URL; its OpenAI-compatible surface is at ${baseUrl}/v1.
    readonly baseUrl: string;
    readonly token: string;
    // Each model's id and what it accepts as input, both as the translator publishes them (gemini-models.ts).
    readonly models: () => Promise<readonly { id: string; inputModalities: readonly InputModality[] }[]>;
}

type ProviderConfigs = NonNullable<OpenCodeConfig["providers"]>;

// Declares Gemini as an OpenAI-compatible endpoint. OpenCode has no catalog row for it, so a capability left out reads
// as absent: no tools, and an image stripped from the request. Modalities come off the translator's own published list;
// output is always text since image generators are filtered upstream (isChatModel). No models means no provider.
export const geminiProviderConfig = (
    gemini: OpenCodeGeminiConfig | undefined,
    models: readonly { id: string; inputModalities: readonly InputModality[] }[],
): ProviderConfigs =>
    gemini === undefined || models.length === 0
        ? {}
        : {
              [OPENCODE_GEMINI_PROVIDER]: {
                  name: "Gemini",
                  package: "aisdk:@ai-sdk/openai-compatible",
                  settings: { baseURL: `${gemini.baseUrl.replace(/\/$/, "")}/v1`, apiKey: gemini.token },
                  models: Object.fromEntries(
                      models.map((model) => [
                          model.id,
                          { name: model.id, capabilities: { tools: true, input: [...model.inputModalities], output: ["text"] } },
                      ]),
                  ),
              },
          };

// xAI as OpenCode knows it, plus what the daemon adds. xAI stores request and response server-side by default; every
// known model opts out with `store: false` in its request body, the one seam OpenCode forwards (checked against 2.0.26 on
// the Responses API it uses for xAI). Declaring a model also makes one OpenCode's catalog lacks routable, which is why
// each says it takes tools: a model xAI shipped after the catalog was cut would otherwise run without any. Behind the
// privacy shield, `baseURL` is the gateway, which forwards where xAI's requests would have gone.
export const xaiProviderConfig = (models: readonly string[], gateway: string | undefined): ProviderConfigs => ({
    xai: {
        ...(gateway === undefined ? {} : { settings: { baseURL: gateway } }),
        models: Object.fromEntries(models.map((id) => [id, { body: { store: false }, capabilities: { tools: true } }])),
    },
});

// The whole inline config: no self-update, no sharing (OpenCode 2 has none yet, and this keeps it off when it does),
// every permission answered by a rule, and both providers.
export const serverConfig = (providers: ProviderConfigs): OpenCodeConfig => ({
    update: "disable",
    share: "disabled",
    permissions: [...SERVER_PERMISSIONS],
    providers,
});
