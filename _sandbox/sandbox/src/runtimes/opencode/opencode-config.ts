import type { ConfigEntry, PermissionRule } from "@opencode/client";
import { type InputModality, OPENCODE_GEMINI_PROVIDER } from "../gemini/gemini-models.js";
import { opt } from "../../opt.js";
import { xaiEffortsOf } from "./xai-models.js";

// One config document as OpenCode 2 reads it; the client names it only as the body of a config entry.
export type OpenCodeConfig = Extract<ConfigEntry, { type: "document" }>["info"];

// The configuration the daemon's `opencode serve` runs with, in OpenCode 2's shape. All of it is handed over inline at
// spawn (OPENCODE_CONFIG_CONTENT), which OpenCode loads last, so it outranks every file a person or a repo could write.

// OpenCode's own off switches, pinned on the spawn so they hold in a bare dev run as well as in the image. Without
// DISABLE_PROJECT_CONFIG, a cloned repo's opencode.json or .opencode/ would configure this runtime: plugins that run
// inside the server, custom tools that replace a built-in by name (and so slip past the shell asks below), MCP servers, and
// permission rules. Checked against 2.0.26, a planted .opencode/plugins/*.js and .opencode/tools/*.ts stay unloaded.
// Skipping project config also skips OpenCode's own read of the repo's AGENTS.md, which the daemon already composes
// into every turn (agent/prompt/workspace-memory.ts). The daemon's own MCP servers go on per turn through the server's
// API (`mount`), which no file in a repo reaches. Auto-update is off because the binary is pinned and installed by the
// engine store, never by OpenCode itself.
export const OPENCODE_LOCKDOWN_ENV = { OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_AUTOUPDATE: "1" } as const;

// OpenCode 2's rules are an ordered list where the last match wins and an unmatched call is asked about. Every agent
// starts from OpenCode's own base (allow everything, but ask before leaving the workspace and before reading a .env
// file), then these, then its own (`intentic-plan` denies edits), then the session's own (opencode-mcp.ts, and the
// per-tool asks of a turn in `default` mode, opencode-agent.ts). So these take back only what nothing on this runtime
// could answer but the daemon, and never re-allow everything, which would undo the plan agent's read-only rule:
// - leaving the workspace and reading .env files, allowed as OpenCode 1 allowed them here; a shell command that reads
//   one still reaches the rulebook below.
// - `execute`, the code-mode runner over MCP catalogs: every server the daemon mounts exposes its tools directly
//   (opencode-mcp.ts), so it would run nothing, and is one more tool for the model to misuse.
// - every shell command, asked about, so each one reaches the owner's rulebook (vendor-ask.ts answerVendorAsk) rather
//   than only those a pattern list here guessed at; one with no rule watching is answered at once.
// `question`, OpenCode's form to the person, is left to OpenCode's own rules (allowed on its primary agents, denied to
// its subagents): the daemon renders the form as a question card (opencode-forms.ts). A denied action's tool is not
// offered to the model at all.
export const SERVER_PERMISSIONS: readonly PermissionRule[] = [
    { action: "external_directory", resource: "*", effect: "allow" },
    { action: "read", resource: "*", effect: "allow" },
    { action: "execute", resource: "*", effect: "deny" },
    { action: "shell", resource: "*", effect: "ask" },
];

// The daemon's twins of OpenCode's `build` and `plan`, for a turn whose system text replaces OpenCode's base prompt (the
// owner's own under `custom`, a small window's one paragraph, a sealed request's): an agent's `system` takes the base
// prompt's place (2.0.26 sends it instead), so with it blank the system text a model reads is the daemon's whole, set
// per message through the session's instruction entry (opencode-agent.ts). Every other turn runs on OpenCode's own
// agents, its base prompt with the daemon's additions after it. Their rules mirror the two built-ins: `build` keeps
// OpenCode's base rules, and `plan` denies every edit (OpenCode's own plan agent allows edits to its plan files, which
// the daemon's plan never uses: its plan is the reply's text).
export const OPENCODE_AGENTS = { build: "intentic-build", plan: "intentic-plan" } as const;

// What stands in the agent's `system`. Blank, so nothing of anyone's sits ahead of the instruction entry; a single space
// rather than empty, since OpenCode reads an empty `system` as unset and falls back to its own base prompt.
const NO_BASE = " ";

export const AGENT_CONFIG: NonNullable<OpenCodeConfig["agents"]> = {
    [OPENCODE_AGENTS.build]: { mode: "primary", system: NO_BASE, description: "Intentic's build agent." },
    [OPENCODE_AGENTS.plan]: {
        mode: "primary",
        system: NO_BASE,
        description: "Intentic's read-only planning agent.",
        // Only the denial: an `allow` of anything here would come after the server's rules and win over their asks.
        permissions: [{ action: "edit", resource: "*", effect: "deny" }],
    },
};

// What a Gemini turn needs declared at server spawn; absent means no Gemini provider registered. `models` is a thunk
// since the Gemini catalog is built after this service in the composition order, read lazily at boot and acquisition.
export interface OpenCodeGeminiConfig {
    // The translator's base URL; its OpenAI-compatible surface is at ${baseUrl}/v1.
    readonly baseUrl: string;
    readonly token: string;
    // Each model's id, what it accepts as input, and the reasoning tiers it takes, as the translator publishes them
    // (gemini-models.ts).
    readonly models: () => Promise<readonly GeminiModelRow[]>;
}

// One Google model as the server is told about it.
export interface GeminiModelRow {
    readonly id: string;
    readonly inputModalities: readonly InputModality[];
    // The shared tiers (EFFORT_TIERS) the translator takes as this model's `reasoning_effort`; absent or empty, none.
    readonly efforts?: readonly string[];
}

type ProviderConfigs = NonNullable<OpenCodeConfig["providers"]>;
type ModelVariants = NonNullable<NonNullable<ProviderConfigs[string]["models"]>[string]["variants"]>;

// How long a Google request may go without its response's headers, and its stream without a chunk, before OpenCode
// gives up on it and retries. Both under the turn's two-minute silence limit (turn-watchdog.ts), so a request the
// translator left hanging is OpenCode's to retry in-turn, not the watchdog's to end the turn over; both well over a
// thinking model's own pause before its first token.
export const GEMINI_HEADER_TIMEOUT_MS = 100_000;
export const GEMINI_CHUNK_TIMEOUT_MS = 100_000;

// One variant per reasoning tier, each sending that tier as the request's `reasoning_effort`, which the translator maps
// onto the Google model's own thinking level. A turn names the tier as the session's variant (opencode-agent.ts).
const effortVariants = (efforts: readonly string[] | undefined): ModelVariants | undefined =>
    efforts === undefined || efforts.length === 0 ? undefined : efforts.map((tier) => ({ id: tier, body: { reasoning_effort: tier } }));

// Declares Gemini as an OpenAI-compatible endpoint. OpenCode has no catalog row for it, so a capability left out reads
// as absent: no tools, and an image stripped from the request. Modalities come off the translator's own published list;
// output is always text since image generators are filtered upstream (isChatModel). No models means no provider.
export const geminiProviderConfig = (gemini: OpenCodeGeminiConfig | undefined, models: readonly GeminiModelRow[]): ProviderConfigs =>
    gemini === undefined || models.length === 0
        ? {}
        : {
              [OPENCODE_GEMINI_PROVIDER]: {
                  name: "Gemini",
                  package: "aisdk:@ai-sdk/openai-compatible",
                  settings: {
                      baseURL: `${gemini.baseUrl.replace(/\/$/, "")}/v1`,
                      apiKey: gemini.token,
                      headerTimeout: GEMINI_HEADER_TIMEOUT_MS,
                      chunkTimeout: GEMINI_CHUNK_TIMEOUT_MS,
                  },
                  models: Object.fromEntries(
                      models.map((model) => [
                          model.id,
                          {
                              name: model.id,
                              capabilities: { tools: true, input: [...model.inputModalities], output: ["text"] },
                              ...opt("variants", effortVariants(model.efforts)),
                          },
                      ]),
                  ),
              },
          };

// xAI as OpenCode knows it, plus what the daemon adds. xAI stores request and response server-side by default; every
// known model opts out with `store: false` in its request body, the one seam OpenCode forwards (checked against 2.0.26 on
// the Responses API it uses for xAI). Declaring a model also makes one OpenCode's catalog lacks routable, which is why
// each says it takes tools: a model xAI shipped after the catalog was cut would otherwise run without any. A model xAI
// takes a reasoning effort for (xai-models.ts) declares one variant per tier, set the way OpenCode's own xAI variants
// set it, so the tier a turn names is there whatever OpenCode's catalog snapshot holds. Behind the privacy shield,
// `baseURL` is the gateway, which forwards where xAI's requests would have gone.
export const xaiProviderConfig = (models: readonly string[], gateway: string | undefined): ProviderConfigs => ({
    xai: {
        ...(gateway === undefined ? {} : { settings: { baseURL: gateway } }),
        models: Object.fromEntries(
            models.map((id) => {
                const efforts = xaiEffortsOf(id);
                return [
                    id,
                    {
                        body: { store: false },
                        capabilities: { tools: true },
                        ...opt("variants", efforts.length === 0 ? undefined : efforts.map((tier) => ({ id: tier, settings: { reasoningEffort: tier } }))),
                    },
                ];
            }),
        ),
    },
});

// The variant a turn's effort names on one model, as the server was configured: the tier itself where that model
// declares it, else none, since OpenCode refuses a variant a model lacks as an unroutable model.
export const variantOf = (providers: ProviderConfigs, providerID: string, modelID: string, effort: string | undefined): string | undefined =>
    effort === undefined ? undefined : providers[providerID]?.models?.[modelID]?.variants?.find((variant) => variant.id === effort)?.id;

// The whole inline config: no self-update, no sharing (OpenCode 2 has none yet, and this keeps it off when it does),
// every permission answered by a rule, the daemon's two agents, both providers, and, where the daemon routes the shell
// (shell/opencode-shell.ts), the script OpenCode runs every shell command through.
export const serverConfig = (providers: ProviderConfigs, shell?: string): OpenCodeConfig => ({
    update: "disable",
    share: "disabled",
    permissions: [...SERVER_PERMISSIONS],
    agents: AGENT_CONFIG,
    providers,
    ...opt("shell", shell),
});
