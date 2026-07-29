import { type AgentEvent, type AgentTurn, type Capability, NATIVE_PROVIDERS } from "@intentic/sandbox-contract";
import { browserOutputDir } from "../browser/browser-artifacts.js";
import { browserServersOf } from "../browser/browser-tools.js";
import { mcpToolsOf } from "../capabilities/mcp-tools.js";
import { pluginDirsOf } from "../capabilities/plugin-dirs.js";
import type { Services } from "../composition.js";
import { extensionAgentDirsOf } from "../extensions/installed-extensions.js";
import { createHashlineServer } from "../hashline/hashline-tools.js";
import type { AgentRequest } from "./agent.js";
import { isUnknownSlashCommand } from "./agent-commands.js";
import type { SteeringQueue } from "./agent-steering.js";
import { withAttachmentNote } from "./attachment-note.js";
import { delegationNote } from "./delegation.js";
import { resolveHarnessCredentials } from "./harness-credentials.js";
import { turnPromptPlacement } from "./system-prompt.js";
import { LITERAL_SLASH_NOTE, withTurnPreamble } from "./turn-preamble.js";
import { setupNoticeFor, workspaceSetup } from "../workspace/workspace-setup.js";

/* WHICH RUNTIME SERVES A TURN, AND WHAT IT IS HANDED — the one question every turn has to answer before it can
 * stream anything, and the one the turn route used to answer inline as a four-arm if/else chain wrapped around
 * its own lifecycle bookkeeping.
 *
 * Each provider answers it the same four ways and differs only in the details: gate the credential, name the
 * runner, name the account the usage frames are attributed to, and assemble the request. Writing that out per
 * arm is what let the arms drift — the Codex gate resolved a concrete model so the SDK's built-in default could
 * never leak through, and the Grok gate learned the same lesson separately, months later.
 *
 * A REFUSAL IS A VALUE, exactly as in harness-credentials.ts (which this calls, and whose header explains why).
 * Every one of these is an ordinary state of a sandbox — a session id that outlived its transcript, a
 * subscription nobody connected, an Agent capability that was uninstalled — not an exception. The route turns
 * one into the single error frame the composer's connect gate reads; the previous shape spelled that frame out
 * five times, and each copy was also a `return` that skipped the caller's cleanup (see the anchor it leaked). */

export type TurnRefusal = {
    readonly ok: false;
    // The machine-readable discriminator the UI keys off (AgentEvent's `error`); absent on plain failures.
    readonly code?: Extract<AgentEvent, { kind: "error" }>["code"];
    readonly message: string;
};

export type TurnPlan =
    | TurnRefusal
    | {
          readonly ok: true;
          readonly run: (request: AgentRequest) => AsyncGenerator<AgentEvent>;
          // The provider account serving this turn — the attribution key stamped onto the usage/rate-limit
          // frames and the activity log. Undefined when the credential came from the container env, or from a
          // translator subscription rather than an account this sandbox stores.
          readonly account?: string;
          readonly request: AgentRequest;
      };

// What the route has already resolved by the time a provider can be picked: the request every arm builds on,
// the turn's two cwds (see runTurn on why there are two), and the seams only some arms use.
export interface TurnContext {
    readonly base: AgentRequest;
    // Workspace-relative attachments, already resolved to absolute paths and escape-checked by the route.
    readonly attachmentPaths: readonly string[];
    // The tree as the DAEMON reaches it — what the daemon itself runs against the files (hashline edits, the
    // dependency probe) must use, because the daemon is not in the turn's namespace.
    readonly localCwd: string;
    // The workspace root as the AGENT sees it — what a session id is looked up against.
    readonly effectiveCwd: string;
    readonly cliEnv: Record<string, string>;
    // Mid-turn steering, present only where the Claude Code loop runs the turn.
    readonly steering: SteeringQueue | undefined;
}

export const planTurn = async (services: Services, input: AgentTurn, context: TurnContext): Promise<TurnPlan> => {
    // Harness (agentic loop) is orthogonal to provider: "native" runs each provider on its own runtime;
    // "claude-code" forces the Claude Code Agent SDK loop for ANY provider — codex/grok then fall through to the
    // harness plan below, which serves them by pointing the harness at the sandbox's translator.
    const harness = input.harness ?? "native";
    // cli/mcp/plugin/browser/agent-kind capabilities, read once and shared by the arms that need them.
    const capabilities = await services.capabilities.list();
    if (input.agent === "codex" && harness === "native") {
        return planCodexTurn(services, input, context);
    }
    if (input.agent === "grok" && harness === "native") {
        return planGrokTurn(services, input, context);
    }
    if (input.agent !== undefined && !(NATIVE_PROVIDERS as readonly string[]).includes(input.agent)) {
        return planAcpTurn(services, input, context, capabilities, input.agent);
    }
    return planHarnessTurn(services, input, context, capabilities);
};

// Codex has no sandbox-owned OAuth: it authenticates through the translator on the user's ChatGPT SUBSCRIPTION
// (the same connection the claude-code harness rides), or the container OPENAI_API_KEY on a bare dev run with no
// translator. There's a single sandbox-wide CODEX_HOME (the adapter's default), so a resume is a plain existence
// check against it; a missing thread self-heals like the harness path below. Claude-only fields (plugins, MCP,
// thinking) don't apply here.
const planCodexTurn = async (services: Services, input: AgentTurn, context: TurnContext): Promise<TurnPlan> => {
    if (input.sessionId !== undefined && !(await services.codexThreadExists(input.sessionId))) {
        return {
            ok: false,
            code: "session-not-found",
            message:
                "This chat's Codex thread no longer exists on the sandbox — it was deleted or lost in a rebuild. The next message starts a fresh session.",
        };
    }
    // The subscription (via the translator) is the credential; the container OPENAI_API_KEY is the only fallback
    // (a bare dev run with no translator baked).
    const translatorReady = services.config.translator.url !== "" && (await services.cliProxy.accounts()).codex.length > 0;
    if (!translatorReady && services.config.openaiApiKey === "") {
        return {
            ok: false,
            code: "subscription-required",
            message:
                services.config.translator.url === ""
                    ? "This sandbox has no model translator, so Codex can't run here. Run a sandbox built from the published image."
                    : "Connect your ChatGPT subscription in Sandbox ▸ Agent to run Codex.",
        };
    }
    // Resolve a concrete model so the turn never falls back to @openai/codex-sdk's built-in default
    // (gpt-5-codex), which the subscription can reject. An explicit selection rides through (a stale one
    // self-heals via codex-model-invalid); an empty one resolves the catalog default (discovery → persisted →
    // seed floor, never empty — see codex-catalog).
    const model = input.model !== undefined && input.model !== "" ? input.model : (await services.codexModels.models()).default;
    const withModel = { ...context.base, model };
    // A subscription-served turn rides the translator's OpenAI-compatible endpoint on the fixed local bearer (the
    // adapter builds the provider block); the dev api-key path uses Codex's own OPENAI_API_KEY default. The
    // default CODEX_HOME (createCodexAgent) serves every turn — no per-turn home. Codex takes attachments
    // structurally: images ride as native local_image inputs, the rest as a file list in the prompt.
    const withAuth = translatorReady
        ? { ...withModel, codexEndpoint: { baseUrl: services.config.translator.url, authToken: services.config.translator.token } }
        : withModel;
    return {
        ok: true,
        run: services.codexAgent,
        // Attribution key: the shared subscription serving all Codex turns, else undefined for the api-key fallback.
        ...(translatorReady ? { account: "codex-subscription" } : {}),
        request: withAttachments(withAuth, context.attachmentPaths),
    };
};

// Grok rides OpenCode with xAI subscription OAuth (OpenCode owns the credential). Gate on OpenCode's own
// connection view. Claude-only fields (plugins, MCP tools, thinking) don't apply.
const planGrokTurn = async (services: Services, input: AgentTurn, context: TurnContext): Promise<TurnPlan> => {
    if (!(await services.openCode.connected("xai"))) {
        return {
            ok: false,
            message: "No Grok account connected — sign in with your xAI (SuperGrok/X Premium) account in Setup before chatting.",
        };
    }
    // Grok MUST ride an explicit, live-valid xAI model id: OpenCode's own default is a retired models.dev id
    // (grok-code-fast-1) xAI rejects, and its catalog is empty for xai — so an omitted model makes the turn fall
    // back to that same retired default. Resolve from the daemon's catalog (never empty — live discovery with a
    // persisted/seed floor): keep the pinned model when it's offered, else the default. If the resolved id turns
    // out stale, the runner self-heals it mid-turn from xAI's "Did you mean" rejection (grok-agent).
    const catalog = await services.openCode.xaiModels();
    const valid = new Set(catalog.models.map((entry) => entry.id));
    const model = input.model !== undefined && valid.has(input.model) ? input.model : catalog.default;
    return {
        ok: true,
        run: services.grokAgent,
        // OpenCode holds one xAI auth, so the single Grok account is "xai" (see grok.routes.ts).
        account: "xai",
        // Override base's input.model with the validated id; the adapter folds attachment paths into the prompt
        // (OpenCode's tools read them from disk).
        request: withAttachments({ ...context.base, model }, context.attachmentPaths),
    };
};

// An ACP provider: the id of an installed `agent`-kind capability, spawned and driven over the Agent Client
// Protocol. Harness doesn't apply (the agent IS its own loop) and neither do the Claude-only request fields; the
// adapter passes http MCP tools through when the agent advertises support.
const planAcpTurn = async (
    services: Services,
    input: AgentTurn,
    context: TurnContext,
    capabilities: readonly Capability[],
    provider: string,
): Promise<TurnPlan> => {
    const capability = capabilities.find((entry) => entry.kind === "agent" && entry.id === provider);
    if (capability === undefined || capability.kind !== "agent") {
        return { ok: false, message: `Unknown agent provider "${provider}" — add it as an Agent capability first.` };
    }
    const acpConfig = capability.config;
    const tools = [...services.tools, ...mcpToolsOf(capabilities)];
    return {
        ok: true,
        run: (turnRequest) => services.acpAgent(provider, acpConfig, turnRequest),
        request: withAttachments(tools.length > 0 ? { ...context.base, tools } : context.base, context.attachmentPaths),
    };
};

/* The Claude Code harness — a native Claude turn's subscription OAuth (with its mid-turn refresh callback), or
 * the translator/Moonshot endpoint a routed provider rides. Credentials are resolved by harness-credentials.ts,
 * which the quick-model one-shot behind the commit box's autofill reads too, so both authenticate identically;
 * its refusals are values, and this is where they become the refusal the composer's connect gate reads. */
const planHarnessTurn = async (
    services: Services,
    input: AgentTurn,
    context: TurnContext,
    capabilities: readonly Capability[],
): Promise<TurnPlan> => {
    const resolved = await resolveHarnessCredentials(services, {
        agent: input.agent,
        ...(input.account !== undefined ? { account: input.account } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
    });
    if (!resolved.ok) {
        return { ok: false, ...(resolved.code !== undefined ? { code: resolved.code } : {}), message: resolved.message };
    }
    const { oauthToken, refreshOauthToken, endpoint } = resolved.credentials;
    // Pre-flight the resume target: a session id that outlived its transcript (deleted, or minted before the
    // store persisted across rebuilds) would otherwise spawn the CLI just to fail opaquely — on every retry. The
    // coded refusal lets the UI drop the dead id so the next send starts fresh.
    if (input.sessionId !== undefined && !(await services.sessions.exists(context.effectiveCwd, input.sessionId))) {
        return {
            ok: false,
            code: "session-not-found",
            message:
                "This chat's session no longer exists on the sandbox — it was deleted or lost in a rebuild. The next message starts a fresh session.",
        };
    }
    // Internal (intent-declared, from env) tools first, then external mcp-kind capabilities — a same-named
    // external tool overrides, matching mcpServersOf's last-wins merge.
    const tools = [...services.tools, ...mcpToolsOf(capabilities)];
    // Per-sandbox agent toggles. stableSystemPrompt keeps the preset system prompt byte-stable so the provider
    // prompt cache survives the turn — the cross-provider delegation note then rides the user message instead of
    // the system prompt.
    const {
        stableSystemPrompt,
        hashlineEdits,
        iqSearch,
        outputCleaners,
        outputHoldout,
        filterBackend,
        terseOutput,
        systemPromptMode,
        systemPrompt: customPrompt,
    } = await services.sandboxSettings.get();
    // The image-baked iq plugin (skill + SessionStart nudge) loads ahead of any user-added plugin-kind
    // capabilities so the agent prefers iq for code search — gated by the per-sandbox iqSearch toggle (opt-in,
    // default off). Empty dir outside the container ⇒ skipped regardless. Extension checkouts with a
    // contributes.agent manifest entry ride the same SDK plugin loader.
    const plugins = [
        ...(services.config.iqPluginDir !== "" && iqSearch ? [services.config.iqPluginDir] : []),
        ...pluginDirsOf(capabilities, services.workspace.root),
        ...(await extensionAgentDirsOf(services)),
    ];
    // Each logged-in browser capability grants the @playwright/mcp browser tools, bound to that platform's
    // persisted profile so the agent acts as the signed-in owner (read/reply/comment/post/join).
    const browserServers = await browserServersOf(capabilities, services.workspace.root);
    // Turn-scoped roots follow the effective cwd: hashline edits must anchor in the worktree an isolated turn
    // edits. Browser profiles, plugin checkouts, and attachments stay on /work — absolute-path inputs, not edit
    // targets.
    const sdkServers = {
        ...browserServers,
        // hashlineEdits: swap the native Edit/Write (disabled below) for hash-anchored file tools.
        ...(hashlineEdits ? { hashline: createHashlineServer(context.localCwd) } : {}),
    };
    const delegation = await delegationEnv(services, stableSystemPrompt);
    const shellEnv = { ...context.cliEnv, ...delegation.env };
    // The turn's user message: attachment note folded in as before. With stableSystemPrompt on, the delegation
    // note is prepended HERE (a user-message preamble) instead of appended to the preset system prompt, so the
    // cached system+tools prefix stays byte-stable and the provider prompt cache is reused across the session.
    const promptWithAttachments =
        context.attachmentPaths.length > 0 ? withAttachmentNote(context.base.prompt, [...context.attachmentPaths]) : context.base.prompt;
    // Dependency readiness for the tree this turn actually works in (an isolated turn's worktree, not /work).
    // Told up front because the alternative is the model paying to rediscover it the expensive way — a package
    // script exiting `vue-tsc: not found`, an `npx` reaching the registry for a binary that was never a package
    // name, and a post-edit type-check whose every error is false. Rides the USER message, never systemAppend: it
    // changes the moment an install finishes, and the system prefix is kept byte-stable for the prompt cache.
    const setupNotice = setupNoticeFor(await workspaceSetup(context.localCwd, services.processes));
    // Where this turn's instructions go — the owner's own system prompt (or the preset), what may be appended to
    // it, and whether the delegation note has to travel in the user message instead (system-prompt.ts owns all
    // three, because they are one decision).
    const placement = turnPromptPlacement({
        mode: systemPromptMode,
        systemPrompt: customPrompt,
        ...(delegation.note !== undefined ? { note: delegation.note } : {}),
        stableSystemPrompt,
        terseOutput,
    });
    // A prompt whose leading `/` names no command this session has, which the CLI would otherwise answer with
    // "Unknown command" and discard — the note keeps the user's words in front of the model (agent-commands.ts
    // decides, turn-preamble.ts explains). Last of the notes, so it sits against the message it describes.
    const literalSlash = isUnknownSlashCommand(input.agent ?? "claude", promptWithAttachments);
    // withTurnPreamble so session restore can strip these notes back out of the stored message — they are
    // protocol, not something the user said (turn-preamble.ts).
    const prompt = withTurnPreamble(
        [
            ...(placement.userNote !== undefined ? [placement.userNote] : []),
            ...(setupNotice !== undefined ? [setupNotice] : []),
            ...(literalSlash ? [LITERAL_SLASH_NOTE] : []),
        ],
        promptWithAttachments,
    );
    return {
        ok: true,
        run: services.agent,
        ...(resolved.credentials.account !== undefined ? { account: resolved.credentials.account } : {}),
        request: {
            ...context.base,
            prompt,
            // A routed turn (codex/grok under the Claude Code harness) pins the translator endpoint + bearer +
            // mapped model and withholds the Anthropic OAuth token (baseUrl in agent.ts drops
            // CLAUDE_CODE_OAUTH_TOKEN). A native Claude turn keeps its OAuth token and falls back to the
            // daemon-wide default model when the turn didn't pin one (a per-automation `model` already rode into
            // `base` above and wins; empty ⇒ subscription default).
            ...(endpoint !== undefined
                ? { baseUrl: endpoint.baseUrl, authToken: endpoint.authToken, model: endpoint.model }
                : {
                      ...(input.model === undefined && services.config.intenticAgentModel !== ""
                          ? { model: services.config.intenticAgentModel }
                          : {}),
                      ...(oauthToken !== undefined ? { oauthToken } : {}),
                      ...(refreshOauthToken !== undefined ? { refreshOauthToken } : {}),
                  }),
            ...(plugins.length > 0 ? { plugins } : {}),
            ...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
            ...(tools.length > 0 ? { tools } : {}),
            ...(Object.keys(sdkServers).length > 0 ? { sdkServers } : {}),
            // The same directory the browser servers got as `--output-dir` — the hook that redirects model-named
            // screenshots into it needs the value too, and one source keeps them from drifting.
            browserOutputDir: browserOutputDir(services.workspace.root),
            // hashlineEdits owns file mutation via the hashline MCP server above, so drop the native Edit/Write
            // from the model's context (native Read stays for viewing images/PDFs).
            ...(hashlineEdits ? { disallowedTools: ["Edit", "Write"] } : {}),
            // Forward the Bash output-cleaner spec (default "off" ⇒ forwarded ⇒ filter disabled; "" ⇒ omit ⇒
            // filter's all-on default), the holdout control fraction, and the cleaner backend (default "native" ⇒ omit).
            ...(outputCleaners !== "" ? { outputCleaners } : {}),
            ...(outputHoldout > 0 ? { outputHoldout } : {}),
            ...(filterBackend !== "native" ? { filterBackend } : {}),
            ...(Object.keys(shellEnv).length > 0 ? { cliEnv: shellEnv } : {}),
            // Which base the prompt is built on, plus either the owner's own text (under "custom") or what to
            // append to a built-in base — never both, which is what turnPromptPlacement decided above.
            systemPromptMode,
            ...(placement.systemPrompt !== undefined ? { systemPrompt: placement.systemPrompt } : {}),
            ...(placement.systemAppend !== undefined ? { systemAppend: placement.systemAppend } : {}),
            // Mid-turn steering (the /agent/steer queue streamAgent registered) — Claude Code harness only.
            ...(context.steering !== undefined ? { steering: context.steering } : {}),
        },
    };
};

/* CROSS-PROVIDER DELEGATION VIA THE SHELL. When Codex is reachable, the agent's Bash gets the shared CODEX_HOME
 * (whose config.toml selects the translator subscription) plus the local bearer, and the system prompt a short
 * how-to note. Codex is reachable when the translator holds the ChatGPT subscription, or a dev OPENAI_API_KEY is
 * set; nothing ⇒ no env, no note — delegation isn't offered. The env and the note are one decision (an agent
 * told it may delegate but handed no credential is worse than one never told), so they are resolved together. */
const delegationEnv = async (
    services: Services,
    stableSystemPrompt: boolean,
): Promise<{ readonly env: Record<string, string>; readonly note?: string }> => {
    const translatorReady = services.config.translator.url !== "" && (await services.cliProxy.accounts()).codex.length > 0;
    const codexHome = translatorReady || services.config.openaiApiKey !== "" ? services.codexHome : undefined;
    const grokConnected = await services.openCode.connected("xai");
    // Resolve the xAI model the note names from xAI's live catalog (default, else first), so it never hardcodes a
    // since-renamed id. Tolerate a transient xAI blip — a Claude turn must not fail on this lookup; the note then
    // omits the model and tells the agent to list xAI's models itself. Skipped in stable mode, where the note
    // stays model-agnostic (it points the agent at `opencode models`) so no volatile id enters the turn at all.
    const grokModel =
        grokConnected && !stableSystemPrompt
            ? await services.openCode
                  .xaiModels()
                  .then((catalog) => catalog.default ?? catalog.models[0]?.id)
                  .catch(() => undefined)
            : undefined;
    const note = delegationNote({
        ...(codexHome !== undefined ? { codexHome } : {}),
        ...(grokConnected ? { openCodeXdg: services.authRoot } : {}),
        ...(grokModel !== undefined ? { grokModel } : {}),
    });
    return {
        env: {
            ...(codexHome !== undefined ? { CODEX_HOME: codexHome } : {}),
            // The translator provider (config.toml) reads the bearer from CODEX_API_KEY; the dev api-key path
            // uses the container's own OPENAI_API_KEY, already in the shell env.
            ...(translatorReady ? { CODEX_API_KEY: services.config.translator.token } : {}),
        },
        ...(note !== undefined ? { note } : {}),
    };
};

// Attachments ride as absolute paths on the request; every adapter takes them the same way and decides for
// itself whether they become native image inputs or a file list in the prompt.
const withAttachments = (request: AgentRequest, paths: readonly string[]): AgentRequest =>
    paths.length > 0 ? { ...request, attachments: [...paths] } : request;
