import {
    type ActivityEvent,
    type AgentEvent,
    type AgentTurn,
    agentContract,
    type EditorContext,
    NATIVE_PROVIDERS,
    runsClaudeCode,
    type WorkspaceEvent,
} from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import { createOutboundSniffer } from "../activity/outbound.js";
import { emitWorkspaceEvent } from "../automations/workspace-events.js";
import { browserServersOf } from "../browser/browser-tools.js";
import { cliEnvOf } from "../capabilities/cli-env.js";
import { mcpToolsOf } from "../capabilities/mcp-tools.js";
import { pluginDirsOf } from "../capabilities/plugin-dirs.js";
import { extensionEnvOf } from "../extensions/extension-env.js";
import { extensionAgentDirsOf, extensionBinDirsOf } from "../extensions/installed-extensions.js";
import { ensureFreshToken, replaceRejectedToken } from "../claude/claude-credentials.js";
import { resolveKimiKey } from "../kimi/kimi-credentials.js";
import { MOONSHOT_ANTHROPIC_BASE } from "../kimi/kimi-models.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { createHashlineServer } from "../hashline/hashline-tools.js";
import { syncAdvisory, syncWorkspaceRepos } from "../workspace/sync-repos.js";
import { resolveWithin } from "../workspace/workspace-files.js";
import { setupNoticeFor, workspaceSetup } from "../workspace/workspace-setup.js";
import { landAgent } from "../agents/land.js";
import type { AgentRequest } from "./agent.js";
import { resolveRequest } from "./agent-requests.js";
import { commandsOf } from "./agent-commands.js";
import { registerTurn, SteeringQueue, steerTurn, stopTurn } from "./agent-steering.js";
import { startTurnRun, turnRunOf } from "./turn-runs.js";
import { sumUsage, type UsageFrame } from "./turn-usage.js";
import { turnAwaiting, turnFinished } from "../push/notifications.js";
import { delegationNote } from "./delegation.js";

// The upstream model id a routed turn (codex/grok under the Claude Code harness) hands the translator, which maps
// it to its provider. Unlike native Codex (which uses the ChatGPT account default and omits the model), the router
// requires an explicit id, and the only source that stays correct is the provider's own live catalog (discovery →
// persisted → seed floor, never empty): keep the pinned pick while the catalog still offers it, else take the
// catalog's default. Validating membership rather than naming a fallback id is what survives a retirement — a pick
// the provider has dropped simply fails the test and falls to the live default. That covers Codex's own
// `gpt-5-codex`, which the translator's ChatGPT subscription does not serve (it re-serves the account's real ids)
// and rejects with a non-SSE error body that breaks the harness stream; it needs no special case now, and neither
// does Grok, whose routed turns previously pinned a hardcoded `grok-4` that consulted no catalog at all.
const routedModel = (catalog: { models: readonly { id: string }[]; default: string }, model: string | undefined): string =>
    model !== undefined && model !== "" && catalog.models.some((entry) => entry.id === model) ? model : catalog.default;

// Fold attached-file paths into the prompt — Claude Code's canonical attachment mechanism (its Read tool
// handles images and PDFs from disk natively, same as dragging a file into the CLI). An empty prompt is the
// attachment-only message (a screenshot with nothing typed), where the note IS the message.
const withAttachmentNote = (prompt: string, paths: readonly string[]): string => {
    const note = `The user attached these files — read them with the Read tool as needed:\n${paths.map((path) => `- ${path}`).join("\n")}`;
    return prompt === "" ? note : `${prompt}\n\n${note}`;
};

// Fold the opt-in editor context (the composer chip, off by default) into the prompt: the file the user is
// looking at and, when they selected text, the lines themselves — so deictic prompts ("fix this") ground
// without an @-mention. Four-backtick fence so a selection containing ``` doesn't break out.
const editorContextNote = (context: EditorContext): string => {
    if (context.selection === undefined) {
        return `The user has \`${context.file}\` open in the editor — "this file" likely refers to it.`;
    }
    const range = context.startLine !== undefined && context.endLine !== undefined ? ` (lines ${context.startLine}-${context.endLine})` : "";
    return `The user has \`${context.file}\` open in the editor with this text selected${range} — "this" likely refers to it:\n\`\`\`\`\n${context.selection}\n\`\`\`\``;
};

// Appended to the system prompt when terseOutput is on (verbosity steering): a stable suffix that trims the
// model's OWN output tokens without dropping substance. Kept short so it barely costs tokens itself each turn.
const TERSE_NOTE =
    "Response style: be concise — don't restate the request, re-quote files you just read, or echo tool output the user can already see. Lead with the answer or the action; expand only where detail changes a decision.";

// Fold a switched conversation's prior transcript into the turn as a role-attributed preamble — ONE format
// for all three runtimes (native per-adapter injection can come later). Newest messages win the budget so
// long conversations keep their tail; an oversized single message is head-truncated.
const HISTORY_MESSAGE_CHAR_CAP = 4_000;
const HISTORY_CHAR_CAP = 24_000;
const withHistory = (prompt: string, history: NonNullable<AgentTurn["history"]>): string => {
    const lines: string[] = [];
    let used = 0;
    for (const message of history.toReversed()) {
        const text =
            message.text.length > HISTORY_MESSAGE_CHAR_CAP ? `${message.text.slice(0, HISTORY_MESSAGE_CHAR_CAP)}\n… (truncated)` : message.text;
        const line = `${message.role === "user" ? "User" : "Assistant"}: ${text}`;
        if (used + line.length > HISTORY_CHAR_CAP) {
            break;
        }
        lines.unshift(line);
        used += line.length;
    }
    return `This conversation continues from another AI runtime. Prior transcript (oldest first) — treat it as your own conversation history:\n\n${lines.join("\n\n")}\n\n---\n\n${prompt}`;
};

// Run one agent turn, streaming typed AgentEvents. `input.agent` picks the provider adapter (absent =
// claude); each provider's token is the sandbox's own credential, never held by the platform, with the
// container env as fallback. A turn with no stored account and no env fallback surfaces an actionable error
// rather than an opaque CLI failure.
// Exported because it IS "wake the agent" — the automations scheduler drives the same composition headlessly.
// Owns the turn's control surface: the AbortController /agent/stop hard-cancels (closing the /agent fetch
// sends no cancel frame, so the browser alone can't) and, on the Claude Code harness, the SteeringQueue
// /agent/steer injects mid-turn user messages into. Both are registered under the conversationId for the
// life of the turn; a headless wake without one runs unregistered (nothing to steer or stop it by).
export async function* streamAgent(services: Services, input: AgentTurn, signal: AbortSignal | undefined): AsyncGenerator<AgentEvent> {
    const controller = new AbortController();
    if (signal?.aborted === true) {
        controller.abort();
    } else {
        signal?.addEventListener("abort", () => controller.abort(), { once: true });
    }
    // Steering needs the SDK's streaming-input mode, so it exists only where the Claude Code loop runs the turn
    // (see runsClaudeCode — which is NOT the same as the harness the client sent). A native codex/grok or an ACP
    // turn registers abort alone — steering it reports NOT_FOUND and the client falls back.
    const steering = runsClaudeCode(input.agent ?? "claude", input.harness ?? "native") ? new SteeringQueue() : undefined;
    const unregister =
        input.conversationId !== undefined
            ? registerTurn(input.conversationId, { abort: () => controller.abort(), ...(steering !== undefined ? { steering } : {}) })
            : undefined;
    try {
        yield* runConversationTurn(services, input, controller.signal, steering);
    } finally {
        unregister?.();
        steering?.close();
    }
}

// The fleet-registry lifecycle around a turn. An ISOLATED turn (isolated + conversationId) is wrapped here —
// mutex acquire + worktree ensure before the turn, finish (usage flush + mutex release) in a finally — so
// EVERY exit of the turn body (provider gates, stream errors, aborts) releases the conversation. A wake
// carrying an OUTSIDE message comes through here too — automations/scheduler.ts mints its conversation, which
// is what puts a Discord mention on the fleet board as an ordinary agent. Schedule and chore wakes have no
// conversation and run the main-tree body unchanged.
async function* runConversationTurn(
    services: Services,
    input: AgentTurn,
    signal: AbortSignal | undefined,
    steering: SteeringQueue | undefined,
): AsyncGenerator<AgentEvent> {
    if (input.isolated !== true || input.conversationId === undefined) {
        yield* runTurn(services, input, signal, undefined, steering);
        return;
    }
    const conversationId = input.conversationId;
    const began = await services.agents.begin(
        {
            conversationId,
            prompt: input.prompt,
            provider: input.agent ?? "claude",
            harness: input.harness ?? "native",
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.model !== undefined ? { model: input.model } : {}),
            ...(input.account !== undefined ? { account: input.account } : {}),
            ...(input.origin !== undefined ? { origin: input.origin } : {}),
        },
        Date.now(),
    );
    if (!began) {
        yield { kind: "error", code: "agent-busy", message: "This agent is already running a turn — wait for it to finish." };
        yield { kind: "done" };
        return;
    }
    let outcome: "landed" | "conflict" | undefined;
    // Hoisted out of the try because the chore emit in the finally reads them: the span this turn's workspace
    // event names, the branch it ran on, and whether it ended on an error frame.
    let span: WorkspaceEvent["repos"] = [];
    let branch = "";
    let failed = false;
    try {
        // Lazily create (first turn) or repair the conversation's worktree composition, then announce it.
        const entry = services.agents.entry(conversationId);
        const worktree = await services.agentWorktrees.ensure(conversationId, entry?.repos ?? []);
        if ((entry?.repos.length ?? 0) === 0) {
            await services.agents.recordWorktree(conversationId, worktree.repos);
        }
        branch = worktree.branch;
        // Where each repo stood BEFORE this turn — the open span a chore diffs from. Captured up front because
        // the auto-land below advances landedTip; read afterwards, every repo would report as unchanged.
        span = worktree.repos.map(({ repo, base }) => ({
            repo,
            from: entry?.repos.find((recorded) => recorded.repo === repo)?.landedTip ?? base,
            dir: services.agentWorktrees.worktreeDir(conversationId, repo),
        }));
        const base = (worktree.repos.find((repo) => repo.repo === "root") ?? worktree.repos[0])?.base.slice(0, 7) ?? "";
        yield { kind: "worktree", branch: worktree.branch, base };
        // Relay the turn while watching for error frames — a failed turn must not auto-land half-done work.
        for await (const event of runTurn(services, input, signal, { id: conversationId, cwd: worktree.cwd }, steering)) {
            if (event.kind === "error") {
                failed = true;
            }
            yield event;
        }
        // Auto-land at clean turn completion — the Claude Code review model: the delta arrives in the main
        // tree as UNCOMMITTED changes and the user's ordinary Changes-panel commit is the review. Aborted or
        // errored turns accumulate in the worktree; the next clean turn lands the cumulative delta.
        const finished = services.agents.entry(conversationId);
        if (!failed && signal?.aborted !== true && finished !== undefined) {
            const landed = await landAgent(services.agentWorktrees, finished);
            if (landed.changed) {
                await services.agents.recordLanded(conversationId, landed);
                outcome = landed.landed ? "landed" : "conflict";
                yield { kind: "landed", landed: landed.landed, ...(landed.conflicts !== undefined ? { conflicts: landed.conflicts } : {}) };
                if (landed.landed) {
                    // The main tree just changed — give the History timeline its turn checkpoint, labeled with
                    // the prompt, exactly like a non-isolated turn's snapshot.
                    services.history
                        .snapshot("turn", input.prompt)
                        .catch((error: unknown) => services.logger.warn({ err: error }, "history: landed snapshot failed"));
                    emitWorkspaceEvent(
                        services,
                        {
                            event: "agent.landed",
                            agentId: conversationId,
                            ...(finished.title !== undefined ? { title: finished.title } : {}),
                            branch,
                            outcome: "landed",
                            repos: span,
                        },
                        streamAgent,
                    );
                }
            }
        }
    } finally {
        await services.agents.finish(conversationId, Date.now(), outcome);
        // Once per turn, whatever the outcome — the errored and conflicted ones are the ones most worth a
        // second pair of eyes. An empty span means the worktree never came up, so there is nothing to review.
        if (span.length > 0) {
            const settled = services.agents.entry(conversationId);
            emitWorkspaceEvent(
                services,
                {
                    event: "turn.settled",
                    agentId: conversationId,
                    ...(settled?.title !== undefined ? { title: settled.title } : {}),
                    branch,
                    outcome: failed ? "error" : (outcome ?? "idle"),
                    repos: span,
                },
                streamAgent,
            );
        }
    }
}

// One agent turn's body, on the main tree (`conversation` undefined) or inside an isolated conversation's
// worktree — the cwd override is the single binding point every provider adapter, the tmux Bash path, and the
// SDK session store follow.
async function* runTurn(
    services: Services,
    input: AgentTurn,
    signal: AbortSignal | undefined,
    conversation: { readonly id: string; readonly cwd: string } | undefined,
    steering: SteeringQueue | undefined,
): AsyncGenerator<AgentEvent> {
    // cli-kind capabilities contribute env vars (their stored credentials) so either agent's shell can run
    // their CLI tools; extension `contributes.settings` with an `env` name inject theirs the same way.
    const capabilities = await services.capabilities.list();
    const cliEnv = { ...(await cliEnvOf(services)), ...(await extensionEnvOf(services)) };
    // Extensions that ship an agent CLI (contributes.bin — e.g. ext-discord's `discord-voice`) get their bin dir
    // prepended to the turn's PATH, so the tool resolves by name in the agent's shell across every runtime.
    const binDirs = await extensionBinDirsOf(services);
    if (binDirs.length > 0) {
        cliEnv["PATH"] = [...binDirs, process.env["PATH"] ?? ""].filter((entry) => entry !== "").join(":");
    }
    // Attachments arrive workspace-relative; resolve to absolute paths for the provider and reject escapes.
    const attachmentPaths: string[] = [];
    for (const rel of input.attachments ?? []) {
        const abs = resolveWithin(services.workspace.root, rel);
        if (abs === undefined) {
            yield { kind: "error", message: `invalid attachment path: ${rel}` };
            yield { kind: "done" };
            return;
        }
        attachmentPaths.push(abs);
    }
    // The editor-context chip's file rides workspace-relative too — same escape guard as attachments.
    if (input.editorContext !== undefined && resolveWithin(services.workspace.root, input.editorContext.file) === undefined) {
        yield { kind: "error", message: `invalid editor context path: ${input.editorContext.file}` };
        yield { kind: "done" };
        return;
    }
    const effectiveCwd = conversation?.cwd ?? services.workspace.root;
    // Kick the repo sync off now so its network git-fetch overlaps the token refresh, browser-server setup,
    // and config reads below instead of running strictly after them. Throttled to 60s, so it's a no-op on most
    // turns; awaited just before the snapshot, which must see the pulled files (the attribution fence below).
    // A top-level failure degrades to no advisory — per-repo errors already ride inside the outcomes.
    // Isolated turns skip it entirely: the worktree pins a stable base by design, and fast-forwarding the main
    // checkout mid-conversation would only manufacture land conflicts.
    const syncPromise =
        conversation !== undefined
            ? undefined
            : syncWorkspaceRepos(services, 60_000).catch((error: unknown) => {
                  services.logger.warn({ err: error }, "repo sync failed");
                  return [];
              });
    // Editor context attaches to THIS message, so it folds in before the (older) history preamble wraps it.
    const promptWithEditor = input.editorContext !== undefined ? `${input.prompt}\n\n${editorContextNote(input.editorContext)}` : input.prompt;
    const base: AgentRequest = {
        prompt: input.history !== undefined && input.history.length > 0 ? withHistory(promptWithEditor, input.history) : promptWithEditor,
        cwd: effectiveCwd,
        signal: signal ?? new AbortController().signal,
        ...(Object.keys(cliEnv).length > 0 ? { cliEnv } : {}),
        ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.permissionMode !== undefined ? { permissionMode: input.permissionMode } : {}),
        ...(input.effort !== undefined ? { effort: input.effort } : {}),
    };
    let run: (request: AgentRequest) => AsyncGenerator<AgentEvent>;
    let request: AgentRequest;
    // The provider account that serves this turn (the selected one, else the provider's first) — the
    // attribution key stamped onto the usage/rate-limit frames and the activity log below.
    let resolvedAccount: string | undefined;
    // Harness (agentic loop) is orthogonal to provider: "native" runs each provider on its own runtime;
    // "claude-code" forces the Claude Code Agent SDK loop for ANY provider — codex/grok then fall through to the
    // claude branch below, which serves them by pointing the harness at the sandbox's translator.
    const harness = input.harness ?? "native";
    if (input.agent === "codex" && harness === "native") {
        // Codex has no sandbox-owned OAuth: it authenticates through the translator on the user's ChatGPT
        // SUBSCRIPTION (the same connection the claude-code harness rides), or the container OPENAI_API_KEY on a
        // bare dev run with no translator. There's a single sandbox-wide CODEX_HOME (the adapter's default), so a
        // resume is a plain existence check against it; a missing thread self-heals like the Claude path below.
        // Claude-only fields (plugins, MCP, thinking) don't apply here.
        if (input.sessionId !== undefined && !(await services.codexThreadExists(input.sessionId))) {
            yield {
                kind: "error",
                code: "session-not-found",
                message:
                    "This chat's Codex thread no longer exists on the sandbox — it was deleted or lost in a rebuild. The next message starts a fresh session.",
            };
            yield { kind: "done" };
            return;
        }
        // The subscription (via the translator) is the credential; the container OPENAI_API_KEY is the only
        // fallback (a bare dev run with no translator baked).
        const translatorReady = services.config.translator.url !== "" && (await services.cliProxy.accounts()).codex;
        if (!translatorReady && services.config.openaiApiKey === "") {
            yield {
                kind: "error",
                code: "subscription-required",
                message:
                    services.config.translator.url === ""
                        ? "This sandbox has no model translator, so Codex can't run here. Run a sandbox built from the published image."
                        : "Connect your ChatGPT subscription in Sandbox ▸ Agent to run Codex.",
            };
            yield { kind: "done" };
            return;
        }
        run = services.codexAgent;
        // Attribution key: the shared subscription serving all Codex turns, else undefined for the api-key fallback.
        resolvedAccount = translatorReady ? "codex-subscription" : undefined;
        // Resolve a concrete model so the turn never falls back to @openai/codex-sdk's built-in default
        // (gpt-5-codex), which the subscription can reject. An explicit selection rides through (a stale one
        // self-heals via codex-model-invalid); an empty one resolves the catalog default (discovery → persisted →
        // seed floor, never empty — see codex-catalog).
        const model = input.model !== undefined && input.model !== "" ? input.model : (await services.codexModels.models()).default;
        const withModel = { ...base, model };
        // A subscription-served turn rides the translator's OpenAI-compatible endpoint on the fixed local bearer
        // (the adapter builds the provider block); the dev api-key path uses Codex's own OPENAI_API_KEY default.
        // The default CODEX_HOME (createCodexAgent) serves every turn — no per-turn home. Codex takes attachments
        // structurally: images ride as native local_image inputs, the rest as a file list in the prompt.
        const withAuth = translatorReady
            ? { ...withModel, codexEndpoint: { baseUrl: services.config.translator.url, authToken: services.config.translator.token } }
            : withModel;
        request = attachmentPaths.length > 0 ? { ...withAuth, attachments: attachmentPaths } : withAuth;
    } else if (input.agent === "grok" && harness === "native") {
        // Grok rides OpenCode with xAI subscription OAuth (OpenCode owns the credential). Gate on OpenCode's own
        // connection view. Claude-only fields (plugins, MCP tools, thinking) don't apply.
        if (!(await services.openCode.connected("xai"))) {
            yield {
                kind: "error",
                message: "No Grok account connected — sign in with your xAI (SuperGrok/X Premium) account in Setup before chatting.",
            };
            yield { kind: "done" };
            return;
        }
        // Grok MUST ride an explicit, live-valid xAI model id: OpenCode's own default is a retired models.dev id
        // (grok-code-fast-1) xAI rejects, and its catalog is empty for xai — so an omitted model makes the turn
        // fall back to that same retired default. Resolve from the daemon's catalog (never empty — live discovery
        // with a persisted/seed floor): keep the pinned model when it's offered, else the default. If the resolved
        // id turns out stale, the runner self-heals it mid-turn from xAI's "Did you mean" rejection (grok-agent).
        const catalog = await services.openCode.xaiModels();
        const valid = new Set(catalog.models.map((entry) => entry.id));
        const model = input.model !== undefined && valid.has(input.model) ? input.model : catalog.default;
        run = services.grokAgent;
        // OpenCode holds one xAI auth, so the single Grok account is "xai" (see grok.routes.ts).
        resolvedAccount = "xai";
        // Override base's input.model with the validated id; the adapter folds attachment paths into the prompt
        // (OpenCode's tools read them from disk).
        const withModel = { ...base, model };
        request = attachmentPaths.length > 0 ? { ...withModel, attachments: attachmentPaths } : withModel;
    } else if (input.agent !== undefined && !(NATIVE_PROVIDERS as readonly string[]).includes(input.agent)) {
        // An ACP provider: the id of an installed `agent`-kind capability, spawned and driven over the Agent
        // Client Protocol. Harness doesn't apply (the agent IS its own loop) and neither do the Claude-only
        // request fields; the adapter passes http MCP tools through when the agent advertises support.
        const provider = input.agent;
        const capability = capabilities.find((entry) => entry.kind === "agent" && entry.id === provider);
        if (capability === undefined || capability.kind !== "agent") {
            yield { kind: "error", message: `Unknown agent provider "${provider}" — add it as an Agent capability first.` };
            yield { kind: "done" };
            return;
        }
        const acpConfig = capability.config;
        run = (turnRequest) => services.acpAgent(provider, acpConfig, turnRequest);
        const tools = [...services.tools, ...mcpToolsOf(capabilities)];
        const withTools = tools.length > 0 ? { ...base, tools } : base;
        request = attachmentPaths.length > 0 ? { ...withTools, attachments: attachmentPaths } : withTools;
    } else {
        // Endpoint + credentials for the Claude Code harness. A native Claude turn authenticates with the user's
        // Anthropic subscription OAuth. A codex/grok/gemini provider running UNDER this harness instead points the
        // harness at the sandbox's translator (CLIProxyAPI), which serves that provider on its connected
        // SUBSCRIPTION OAuth — so the turn only needs the provider's subscription connected in the translator.
        // Codex and Grok reach this only under harness "claude-code" (their native runtimes are handled above);
        // Gemini has no native runtime, so every Gemini turn is routed.
        let oauthToken: string | undefined;
        let refreshOauthToken: ((context: { readonly signal: AbortSignal }) => Promise<string | undefined>) | undefined;
        let endpoint: { baseUrl: string; authToken: string; model: string } | undefined;
        if (input.agent === "codex" || input.agent === "grok" || input.agent === "gemini") {
            if (services.config.translator.url === "") {
                // Codex/Grok can fall back to their own runtime; Gemini has none, so it can only be an image problem.
                const fallback =
                    input.agent === "gemini"
                        ? "Run a sandbox built from the published image."
                        : "Use the provider's native harness, or run a sandbox built from the published image.";
                yield {
                    kind: "error",
                    message: `This sandbox has no model translator, so a non-Claude model can't run under the Claude Code harness here. ${fallback}`,
                };
                yield { kind: "done" };
                return;
            }
            if (!(await services.cliProxy.accounts())[input.agent]) {
                const label = input.agent === "codex" ? "ChatGPT subscription" : input.agent === "grok" ? "SuperGrok subscription" : "Google account";
                yield {
                    kind: "error",
                    code: "subscription-required",
                    message: `Connect your ${label} in Sandbox ▸ Agent to run ${input.agent} under the Claude Code harness.`,
                };
                yield { kind: "done" };
                return;
            }
            // Every routed provider resolves against its own live catalog — the same catalogs the native paths
            // use, so a pick is validated identically whichever harness runs it.
            const catalog =
                input.agent === "codex"
                    ? await services.codexModels.models()
                    : input.agent === "grok"
                      ? await services.openCode.xaiModels()
                      : await services.geminiModels.models();
            const model = routedModel(catalog, input.model);
            endpoint = { baseUrl: services.config.translator.url, authToken: services.config.translator.token, model };
        } else if (input.agent === "kimi") {
            // Kimi (Moonshot) speaks the Anthropic Messages protocol, so it runs on THIS harness with the endpoint
            // pointed at Moonshot's Anthropic-compatible base and authenticated with the sandbox-owned API key (the
            // selected account's, else the first stored one, else the container MOONSHOT_API_KEY). Withholding the
            // Claude OAuth token happens automatically once `endpoint` is set (baseUrl in agent.ts drops it).
            const resolved = await resolveKimiKey(services.kimiStore, services.config, input.account);
            if (resolved === undefined) {
                yield {
                    kind: "error",
                    code: "subscription-required",
                    message: "No Kimi account connected — add your Kimi (Moonshot) API key in Sandbox ▸ Agent before chatting.",
                };
                yield { kind: "done" };
                return;
            }
            resolvedAccount = resolved.accountId;
            // Resolve a concrete model so the turn never sends an empty id to Moonshot: the pinned pick, else the
            // live catalog default (discovery → persisted → seed floor, never empty).
            const model = input.model !== undefined && input.model !== "" ? input.model : (await services.kimiModels.models()).default;
            endpoint = { baseUrl: MOONSHOT_ANTHROPIC_BASE, authToken: resolved.apiKey, model };
        } else {
            const accountId = input.account ?? (await services.claudeStore.list())[0]?.id;
            if (accountId !== undefined) {
                try {
                    oauthToken = await ensureFreshToken(services.claudeStore, accountId);
                } catch (error) {
                    yield { kind: "error", message: error instanceof Error ? error.message : "claude credentials unavailable" };
                    yield { kind: "done" };
                    return;
                }
                // Hand the CLI a way to re-mint the token it was given. It calls this on a 401 and carries on
                // with the result, so a credential that expires or is revoked mid-turn costs a pause instead of
                // the turn's work. `oauthToken` tracks what the CLI currently holds so the rotation supersedes
                // exactly that one — and so a token another turn already rotated is adopted, never re-refreshed.
                refreshOauthToken = async (): Promise<string | undefined> => {
                    if (oauthToken === undefined) {
                        return undefined;
                    }
                    const replacement = await replaceRejectedToken(services.claudeStore, accountId, oauthToken).catch((error: unknown) => {
                        services.logger.warn({ err: error, account: accountId }, "claude mid-turn token refresh failed");
                        return undefined;
                    });
                    oauthToken = replacement;
                    return replacement;
                };
            }
            resolvedAccount = oauthToken !== undefined ? accountId : undefined;
            if (oauthToken === undefined && services.config.claudeCodeOauthToken === "" && services.config.anthropicApiKey === "") {
                // A connected-but-revoked account is a different problem from having no account at all, and it
                // has a different fix: reconnect this one, in place, rather than go find Setup. The code lets the
                // UI offer that inline and hold the message for replay once it lands.
                const revoked =
                    accountId !== undefined && (await services.claudeStore.list()).some((a) => a.id === accountId && a.needsReauth === true);
                yield revoked
                    ? {
                          kind: "error",
                          code: "claude-reauth",
                          message: "Claude sign-in was revoked — reconnect the account to pick this conversation back up.",
                      }
                    : { kind: "error", message: "No Claude account connected — connect it in Setup before chatting." };
                yield { kind: "done" };
                return;
            }
        }
        // Pre-flight the resume target: a session id that outlived its transcript (deleted, or minted before
        // the store persisted across rebuilds) would otherwise spawn the CLI just to fail opaquely — on every
        // retry. The coded error lets the UI drop the dead id so the next send starts fresh.
        if (input.sessionId !== undefined && !(await services.sessions.exists(effectiveCwd, input.sessionId))) {
            yield {
                kind: "error",
                code: "session-not-found",
                message:
                    "This chat's session no longer exists on the sandbox — it was deleted or lost in a rebuild. The next message starts a fresh session.",
            };
            yield { kind: "done" };
            return;
        }
        // Internal (intent-declared, from env) tools first, then external mcp-kind capabilities — a same-named
        // external tool overrides, matching mcpServersOf's last-wins merge.
        const tools = [...services.tools, ...mcpToolsOf(capabilities)];
        // Per-sandbox agent toggles. stableSystemPrompt keeps the preset system prompt byte-stable so the
        // provider prompt cache survives the turn — the cross-provider delegation note then rides the user
        // message instead of the system prompt.
        const { stableSystemPrompt, hashlineEdits, iqSearch, outputCleaners, outputHoldout, filterBackend, terseOutput } =
            await services.sandboxSettings.get();
        // The image-baked iq plugin (skill + SessionStart nudge) loads ahead of any user-added plugin-kind
        // capabilities so the agent prefers iq for code search — gated by the per-sandbox iqSearch toggle
        // (opt-in, default off). Empty dir outside the container ⇒ skipped regardless.
        // Extension checkouts with a contributes.agent manifest entry ride the same SDK plugin loader.
        const plugins = [
            ...(services.config.iqPluginDir !== "" && iqSearch ? [services.config.iqPluginDir] : []),
            ...pluginDirsOf(capabilities, services.workspace.root),
            ...(await extensionAgentDirsOf(services)),
        ];
        // Each logged-in browser capability grants the @playwright/mcp browser tools, bound to that platform's
        // persisted profile so the agent acts as the signed-in owner (read/reply/comment/post/join).
        const browserServers = await browserServersOf(capabilities, services.workspace.root);
        // Turn-scoped roots follow the effective cwd: hashline edits must anchor in the worktree an isolated
        // turn edits. Browser profiles, plugin checkouts, and attachments stay on /work — absolute-path
        // inputs, not edit targets.
        const sdkServers = {
            ...browserServers,
            // hashlineEdits: swap the native Edit/Write (disabled below) for hash-anchored file tools.
            ...(hashlineEdits ? { hashline: createHashlineServer(effectiveCwd) } : {}),
        };
        // Cross-provider delegation via the shell: when Codex is reachable, the agent's Bash gets the shared
        // CODEX_HOME (whose config.toml selects the translator subscription) plus the local bearer, and the
        // system prompt a short how-to note. Codex is reachable when the translator holds the ChatGPT
        // subscription, or a dev OPENAI_API_KEY is set; nothing ⇒ no env, no note — delegation isn't offered.
        const codexTranslatorReady = services.config.translator.url !== "" && (await services.cliProxy.accounts()).codex;
        const codexDelegable = codexTranslatorReady || services.config.openaiApiKey !== "";
        const codexHome = codexDelegable ? services.codexHome : undefined;
        // Resolve the xAI model the delegation note names from xAI's live catalog (default, else first), so the
        // note never hardcodes a since-renamed id. Tolerate a transient xAI blip — a Claude turn must not fail on
        // this lookup; the note then omits the model and tells the agent to list xAI's models itself.
        const grokConnected = await services.openCode.connected("xai");
        // Skip the live model lookup in stable mode — the note stays model-agnostic there (it points the agent at
        // `opencode models`), so no volatile xAI id enters the turn at all.
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
        const shellEnv = {
            ...cliEnv,
            ...(codexHome !== undefined ? { CODEX_HOME: codexHome } : {}),
            // The translator provider (config.toml) reads the bearer from CODEX_API_KEY; the dev api-key path
            // uses the container's own OPENAI_API_KEY, already in the shell env.
            ...(codexTranslatorReady ? { CODEX_API_KEY: services.config.translator.token } : {}),
        };
        // The turn's user message: attachment note folded in as before. With stableSystemPrompt on, the delegation
        // note is prepended HERE (a user-message preamble) instead of appended to the preset system prompt, so the
        // cached system+tools prefix stays byte-stable and the provider prompt cache is reused across the session.
        const promptWithAttachments = attachmentPaths.length > 0 ? withAttachmentNote(base.prompt, attachmentPaths) : base.prompt;
        // Dependency readiness for the tree this turn actually works in (an isolated turn's worktree, not /work).
        // Told up front because the alternative is the model paying to rediscover it the expensive way — a package
        // script exiting `vue-tsc: not found`, an `npx` reaching the registry for a binary that was never a package
        // name, and a post-edit type-check whose every error is false. Rides the USER message, never systemAppend:
        // it changes the moment an install finishes, and the system prefix is kept byte-stable for the prompt cache.
        const setupNotice = setupNoticeFor(await workspaceSetup(effectiveCwd, services.processes));
        const preamble = [...(stableSystemPrompt && note !== undefined ? [note] : []), ...(setupNotice !== undefined ? [setupNotice] : [])];
        const prompt = preamble.length > 0 ? `${preamble.join("\n\n")}\n\n---\n\n${promptWithAttachments}` : promptWithAttachments;
        // System-prompt suffix: the delegation note (unless stableSystemPrompt moved it into the user message)
        // followed by the terse-output steer. Both are stable across a session, so appending here keeps the cached
        // system+tools prefix intact (the point of stableSystemPrompt).
        const systemAppend =
            [...(note !== undefined && !stableSystemPrompt ? [note] : []), ...(terseOutput ? [TERSE_NOTE] : [])].join("\n\n") || undefined;
        run = services.agent;
        request = {
            ...base,
            prompt,
            // A routed turn (codex/grok under the Claude Code harness) pins the translator endpoint + bearer +
            // mapped model and withholds the Anthropic OAuth token (baseUrl in agent.ts drops CLAUDE_CODE_OAUTH_TOKEN).
            // A native Claude turn keeps its OAuth token and falls back to the daemon-wide default model when the turn
            // didn't pin one (a per-automation `model` already rode into `base` above and wins; empty ⇒ subscription default).
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
            // hashlineEdits owns file mutation via the hashline MCP server above, so drop the native Edit/Write
            // from the model's context (native Read stays for viewing images/PDFs).
            ...(hashlineEdits ? { disallowedTools: ["Edit", "Write"] } : {}),
            // Forward the Bash output-cleaner spec (default "off" ⇒ forwarded ⇒ filter disabled; "" ⇒ omit ⇒
            // filter's all-on default), the holdout control fraction, and the cleaner backend (default "native" ⇒ omit).
            ...(outputCleaners !== "" ? { outputCleaners } : {}),
            ...(outputHoldout > 0 ? { outputHoldout } : {}),
            ...(filterBackend !== "native" ? { filterBackend } : {}),
            ...(Object.keys(shellEnv).length > 0 ? { cliEnv: shellEnv } : {}),
            // Delegation note (when stableSystemPrompt left it here) + terseOutput steer, composed above.
            ...(systemAppend !== undefined ? { systemAppend } : {}),
            // Mid-turn steering (the /agent/steer queue streamAgent registered) — Claude Code harness only.
            ...(steering !== undefined ? { steering } : {}),
        };
    }
    // Bring every repo with a remote up to its latest commit before the agent reads the tree, so the turn works
    // on current code. Clean-only fast-forward — a dirty/diverged/detached repo is left as-is and its stale state
    // reported into the prompt so the agent knows. Throttled per repo; a network failure on one repo is isolated
    // into its outcome, never blocking the turn. Runs before the attribution snapshot so pulled files land as
    // user-authored, not attributed to this turn.
    const advisory = syncPromise === undefined ? undefined : syncAdvisory(await syncPromise);
    if (advisory !== undefined) {
        request = { ...request, prompt: `${advisory}\n\n${request.prompt}` };
    }
    // Attribution fence: capture anything pending as user-authored (terminal edits, desktop-sync arrivals,
    // unflushed UI writes) BEFORE the agent runs, so the turn-end snapshot below is purely the agent's work.
    // A no-op skip when the tree is clean; a history failure never blocks a turn. Isolated turns skip BOTH
    // snapshots: history captures the MAIN tree, which an isolated turn never touches — the worktree branch's
    // diff-vs-base is that conversation's review and rollback surface.
    if (conversation === undefined) {
        // The turn-start state's checkpoint id: the fence capture when it recorded something, else the newest
        // visible checkpoint (a clean tree at turn start IS that checkpoint's state — the common case). The
        // client hangs "restore to before this message" on the frame; no id (fresh workspace) ⇒ no button.
        const checkpointId = await services.history
            .snapshot("user")
            .then(async (id) => id ?? (await services.history.list())[0]?.id)
            .catch((error: unknown) => {
                services.logger.warn({ err: error }, "history: turn-start snapshot failed");
                return undefined;
            });
        if (checkpointId !== undefined) {
            yield { kind: "checkpoint", id: checkpointId };
        }
    }
    // Tee every frame past the activity sniffer — outbound provider calls (discord curl) are only visible
    // here, and every turn origin (chat, automation wake, voice wake) flows through this generator.
    const sniffer = createOutboundSniffer(services);
    // Turn lifecycle into the activity log — the durable trail of every turn (start, plan artifacts, errors,
    // completion with usage) that survives rebuilds and the agent's own reach, while full content stays in
    // the SDK transcript. Fire-and-forget: logging must never delay or fail a turn.
    const provider = input.agent ?? "claude";
    let sessionId = input.sessionId;
    let usageExtra: Record<string, unknown> | undefined;
    // The turn's usage, kept typed (unlike usageExtra, which is the activity log's opaque `extra`) so the spend
    // ledger below appends numbers rather than re-narrowing unknowns. SUMMED, not last-wins: a turn emits one
    // frame per SDK turn, and a steered follow-up or an imp-mode round is a second one — the money is the total.
    let usage: UsageFrame | undefined;
    const record = (event: Omit<ActivityEvent, "id" | "at" | "provider" | "direction">): void => {
        void services.activity
            .append({
                provider,
                direction: "system",
                ...(resolvedAccount !== undefined ? { account: resolvedAccount } : {}),
                ...(sessionId !== undefined ? { sessionId } : {}),
                ...event,
            })
            .catch((error: unknown) => services.logger.warn({ err: error }, "activity: turn event append failed"));
    };
    record({ type: "turn.started", content: input.prompt.slice(0, 2_000) });
    try {
        for await (const event of run(request)) {
            sniffer.observe(event);
            // Fold every frame into the fleet registry so the card shows live status/activity/cost.
            if (conversation !== undefined) {
                services.agents.observe(conversation.id, event);
            }
            if (event.kind === "session") {
                sessionId = event.sessionId;
            } else if (event.kind === "usage") {
                usage = sumUsage(usage, event);
                const { kind: _kind, ...rest } = usage;
                usageExtra = rest;
                // Attribute the per-turn totals (and the account-wide rate-limit snapshot) to the account that
                // served the turn, so the client keys its usage displays by account.
                yield { ...event, ...(resolvedAccount !== undefined ? { account: resolvedAccount } : {}) };
                continue;
            } else if (event.kind === "rate_limit_info") {
                yield { ...event, ...(resolvedAccount !== undefined ? { account: resolvedAccount } : {}) };
                continue;
            } else if (event.kind === "account_usage") {
                // Persist the windows as well as streaming them, so the account picker can report this
                // account's headroom on the next page load instead of only for as long as this tab stays open.
                // Attributed turns only — an env-token turn has no account to key it by. Fire-and-forget: a
                // usage write must never delay or fail a turn (same contract as the activity append below).
                if (resolvedAccount !== undefined) {
                    services.claudeUsage
                        .record(resolvedAccount, { windows: event.windows, measuredAt: Date.now() })
                        .catch((error: unknown) => services.logger.warn({ err: error }, "claude usage: snapshot write failed"));
                }
                yield { ...event, ...(resolvedAccount !== undefined ? { account: resolvedAccount } : {}) };
                continue;
            } else if (event.kind === "plan") {
                record({ type: "turn.plan", content: event.text, extra: { requestId: event.requestId } });
            } else if (event.kind === "error") {
                record({ type: "turn.error", outcome: "error", error: event.message });
            }
            yield event;
        }
    } finally {
        record({ type: "turn.completed", ...(usageExtra !== undefined ? { extra: usageExtra } : {}) });
        // The spend ledger — the durable, never-pruned record the cost dashboard reads. Only turns the provider
        // actually billed land here: no usage frame means no spend to attribute, and a zero row would inflate
        // the turn count with turns that cost nothing (the activity log already carries those for the audit
        // trail). Aborted turns DO land — a cancelled turn still spent what it spent before the stop.
        // `request.model` is the model resolved past the client's pick and every provider default, which is the
        // one the money was spent on; `harness` and the conversation make cost-by-model and cost-by-agent
        // answerable without a second source. Fire-and-forget, same contract as every other turn-end write.
        if (usage !== undefined) {
            services.usage
                .record({
                    provider,
                    ...(resolvedAccount !== undefined ? { account: resolvedAccount } : {}),
                    ...(request.model !== undefined ? { model: request.model } : {}),
                    harness,
                    ...(conversation !== undefined ? { conversationId: conversation.id } : {}),
                    turns: usage.numTurns ?? 1,
                    inputTokens: usage.inputTokens ?? 0,
                    outputTokens: usage.outputTokens ?? 0,
                    cacheReadTokens: usage.cacheReadTokens ?? 0,
                    cacheCreationTokens: usage.cacheCreationTokens ?? 0,
                    costUsd: usage.costUsd ?? 0,
                    durationMs: usage.durationMs ?? 0,
                })
                .catch((error: unknown) => services.logger.warn({ err: error }, "usage: ledger append failed"));
        }
        sniffer.flush();
        // Fire-and-forget workspace snapshot at turn end (aborted turns included) — history must never delay
        // or fail a turn. The raw prompt (not the enriched request) labels the checkpoint in the user's words.
        // Isolated turns skip it (main tree untouched); their registry finish lives in streamAgent's finally.
        if (conversation === undefined) {
            services.history
                .snapshot("turn", input.prompt)
                .catch((error: unknown) => services.logger.warn({ err: error }, "history: turn snapshot failed"));
        }
    }
}

export const createAgentRoutes = (services: Services) => {
    const i = implement(agentContract).$context<OrpcContext>();
    return {
        // Start the conversation's turn as a detached run — the ack carries the run id and the turn executes
        // regardless of what happens to this request (the request signal is deliberately not wired in; the
        // only cancel is /agent/stop). CONFLICT = another window/device is mid-turn on this conversation.
        run: i.run.handler(({ input }) => {
            if (input.conversationId === undefined) {
                throw new ORPCError("BAD_REQUEST", { message: "conversationId required" });
            }
            const conversationId = input.conversationId;
            // Push notifications ride the run's lifecycle, not this request's: the point is to reach a user
            // whose tab is asleep or closed, which is exactly when nobody is reading the response. Every send
            // goes through notifyIfAway, so a user watching the turn finish is told nothing.
            const run = startTurnRun(
                (turn, signal) => streamAgent(services, turn, signal),
                { ...input, conversationId },
                {
                    awaiting: (kind) => void services.pushSender.notifyIfAway(turnAwaiting(conversationId, kind)),
                    settled: (outcome) => void services.pushSender.notifyIfAway(turnFinished(conversationId, input.prompt, outcome)),
                },
            );
            if (run === undefined) {
                throw new ORPCError("CONFLICT", { message: "a turn is already running for this conversation" });
            }
            return { run: run.id };
        }),
        // Render the conversation's run: head (identity + replay/live boundary), frames from the client's
        // cursor, `end` when the run settles. A cursor naming a superseded run replays the current one from
        // its first frame — the head's run id tells the client which world it's in.
        attach: i.attach.handler(async function* ({ input }) {
            const run = turnRunOf(input.conversationId);
            if (run === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "no live or recent turn for that conversation" });
            }
            yield { kind: "attached" as const, run: run.id, prompt: run.prompt, startedAt: run.startedAt, seq: run.seq };
            const after = input.run === run.id ? (input.after ?? 0) : 0;
            for await (const frame of run.follow(after)) {
                yield { kind: "frame" as const, ...frame };
            }
            yield { kind: "end" as const };
        }),
        // Un-park a turn waiting on an interactive card — a plan approval, question picks, or a per-tool
        // permission prompt, all keyed by the same requestId. NOT_FOUND when nothing holds that id (already
        // answered, or the turn ended), which is what tells the client to freeze the card as stale.
        reply: i.reply.handler(({ input }) => {
            if (!resolveRequest(input)) {
                throw new ORPCError("NOT_FOUND", { message: `no pending ${input.kind} for that request` });
            }
            return { ok: true } as const;
        }),
        // Inject a user message into the conversation's running turn (delivered between tool calls);
        // NOT_FOUND when no steerable turn is live — the client then keeps it queued for the next turn.
        // The message is composed exactly like a turn's own prompt (editor-context note, then the attachment
        // note over workspace-resolved paths), so adding a file mid-turn reads the same to the agent as
        // attaching it to a fresh message.
        steer: i.steer.handler(({ input }) => {
            const paths: string[] = [];
            for (const rel of input.attachments ?? []) {
                const abs = resolveWithin(services.workspace.root, rel);
                if (abs === undefined) {
                    throw new ORPCError("BAD_REQUEST", { message: `invalid attachment path: ${rel}` });
                }
                paths.push(abs);
            }
            if (input.editorContext !== undefined && resolveWithin(services.workspace.root, input.editorContext.file) === undefined) {
                throw new ORPCError("BAD_REQUEST", { message: `invalid editor context path: ${input.editorContext.file}` });
            }
            const withEditor = [input.text, ...(input.editorContext !== undefined ? [editorContextNote(input.editorContext)] : [])]
                .filter((part) => part !== "")
                .join("\n\n");
            if (!steerTurn(input.conversationId, paths.length > 0 ? withAttachmentNote(withEditor, paths) : withEditor)) {
                throw new ORPCError("NOT_FOUND", { message: "no steerable turn running for that conversation" });
            }
            return { ok: true } as const;
        }),
        // Hard-cancel the conversation's running turn daemon-side (the browser's fetch abort can't).
        stop: i.stop.handler(({ input }) => {
            if (!stopTurn(input.conversationId)) {
                throw new ORPCError("NOT_FOUND", { message: "no running turn for that conversation" });
            }
            return { ok: true } as const;
        }),
        // The provider's slash commands from its most recent turn. Empty (not an error) when it has never run
        // one here — the popover simply stays closed until the first turn publishes the list.
        commands: i.commands.handler(({ input }) => ({ commands: [...commandsOf(input.agent ?? "claude")] })),
    };
};
