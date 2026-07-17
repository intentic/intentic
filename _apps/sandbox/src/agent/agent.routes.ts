import { type ActivityEvent, type AgentEvent, type AgentTurn, agentContract, NATIVE_PROVIDERS } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import { createOutboundSniffer } from "../activity/outbound.js";
import { browserServersOf } from "../browser/browser-tools.js";
import { cliEnvOf } from "../capabilities/cli-env.js";
import { mcpToolsOf } from "../capabilities/mcp-tools.js";
import { pluginDirsOf } from "../capabilities/plugin-dirs.js";
import { extensionEnvOf } from "../extensions/extension-env.js";
import { extensionAgentDirsOf, extensionBinDirsOf } from "../extensions/installed-extensions.js";
import { ensureFreshToken } from "../claude/claude-credentials.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { createHashlineServer } from "../hashline/hashline-tools.js";
import { createSessionSearchServer } from "../sessions/session-search-tool.js";
import { syncAdvisory, syncWorkspaceRepos } from "../workspace/sync-repos.js";
import { resolveWithin } from "../workspace/workspace-files.js";
import type { AgentRequest } from "./agent.js";
import { resolvePlanDecision, resolveQuestionAnswer } from "./agent-requests.js";
import { delegationNote } from "./delegation.js";

// The upstream model id a routed turn (codex/grok under the Claude Code harness) hands the translator, which maps
// it to its provider. Unlike native Codex (which uses the ChatGPT account default and omits the model), the router
// requires an explicit id — the UI catalog supplies one per provider under the claude-code harness; this is the floor.
const routedModel = (provider: "codex" | "grok", model: string | undefined): string =>
    model !== undefined && model !== "" ? model : provider === "codex" ? "gpt-5-codex" : "grok-4";

// Fold attached-file paths into the prompt — Claude Code's canonical attachment mechanism (its Read tool
// handles images and PDFs from disk natively, same as dragging a file into the CLI).
const withAttachmentNote = (prompt: string, paths: readonly string[]): string =>
    `${prompt}\n\nThe user attached these files — read them with the Read tool as needed:\n${paths.map((path) => `- ${path}`).join("\n")}`;

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
// An ISOLATED turn (isolated + conversationId) is wrapped in the fleet-registry lifecycle here — mutex acquire
// + worktree ensure before the turn, finish (usage flush + mutex release) in a finally — so EVERY exit of the
// turn body (provider gates, stream errors, aborts) releases the conversation. The wake paths never set
// `isolated`, so automations/webchat/listeners run the main-tree body unchanged.
export async function* streamAgent(services: Services, input: AgentTurn, signal: AbortSignal | undefined): AsyncGenerator<AgentEvent> {
    if (input.isolated !== true || input.conversationId === undefined) {
        yield* runTurn(services, input, signal, undefined);
        return;
    }
    const conversationId = input.conversationId;
    const began = await services.agents.begin(
        {
            conversationId,
            prompt: input.prompt,
            provider: input.agent ?? "claude",
            harness: input.harness ?? "native",
            ...(input.model !== undefined ? { model: input.model } : {}),
            ...(input.account !== undefined ? { account: input.account } : {}),
        },
        Date.now(),
    );
    if (!began) {
        yield { kind: "error", code: "agent-busy", message: "This agent is already running a turn — wait for it to finish." };
        yield { kind: "done" };
        return;
    }
    try {
        // Lazily create (first turn) or repair the conversation's worktree composition, then announce it.
        const entry = services.agents.entry(conversationId);
        const worktree = await services.agentWorktrees.ensure(conversationId, entry?.repos ?? []);
        if ((entry?.repos.length ?? 0) === 0) {
            await services.agents.recordWorktree(conversationId, worktree.repos);
        }
        const base = (worktree.repos.find((repo) => repo.repo === "root") ?? worktree.repos[0])?.base.slice(0, 7) ?? "";
        yield { kind: "worktree", branch: worktree.branch, base };
        yield* runTurn(services, input, signal, { id: conversationId, cwd: worktree.cwd });
    } finally {
        await services.agents.finish(conversationId, Date.now());
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
    const base: AgentRequest = {
        prompt: input.history !== undefined && input.history.length > 0 ? withHistory(input.prompt, input.history) : input.prompt,
        cwd: effectiveCwd,
        signal: signal ?? new AbortController().signal,
        ...(Object.keys(cliEnv).length > 0 ? { cliEnv } : {}),
        ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.plan !== undefined ? { plan: input.plan } : {}),
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
        // Codex reads its credential itself from the account's CODEX_HOME/auth.json (and refreshes it in place);
        // the gate only checks something is there. Claude-only fields (plugins, MCP, thinking) don't apply.
        // A resume must run under the CODEX_HOME that MINTED the thread — its rollout lives under exactly one home
        // and the connected-account set can change between turns (turn 1 served by OPENAI_API_KEY's fallback home,
        // then the user signs into ChatGPT and the "first" account changes). Locate the owner and pin the turn to
        // it so the resume finds its rollout and the conversation continues; no owner ⇒ the same self-healing
        // coded error the Claude path uses below. A fresh turn (no sessionId) keeps the default resolution.
        const located = input.sessionId !== undefined ? await services.locateCodexThread(input.sessionId) : undefined;
        if (input.sessionId !== undefined && located === undefined) {
            yield {
                kind: "error",
                code: "session-not-found",
                message:
                    "This chat's Codex thread no longer exists on the sandbox — it was deleted or lost in a rebuild. The next message starts a fresh session.",
            };
            yield { kind: "done" };
            return;
        }
        // The home + account serving the turn: the located owner on a resume (undefined accountId ⇒ the
        // OPENAI_API_KEY fallback home), else the selected/first account (fallback home when none is connected).
        let codexHome: string | undefined;
        let accountId: string | undefined;
        let servedByFallback: boolean;
        if (located !== undefined) {
            codexHome = located.home;
            accountId = located.accountId;
            servedByFallback = located.accountId === undefined;
        } else {
            accountId = input.account ?? (await services.codexStore.list())[0]?.id;
            const connected = accountId !== undefined && (await services.codexStore.connected(accountId));
            codexHome = accountId !== undefined && connected ? services.codexStore.home(accountId) : undefined;
            servedByFallback = !connected;
        }
        if (servedByFallback && services.config.openaiApiKey === "") {
            yield { kind: "error", message: "No ChatGPT account connected — connect it in Setup before chatting." };
            yield { kind: "done" };
            return;
        }
        // Surface a revoked/expired sign-in as a clean, coded error BEFORE spawning the CLI (which would otherwise
        // fail opaquely mid-turn). Only for an account-served turn with no OPENAI_API_KEY fallback to save it.
        const health =
            accountId !== undefined && !servedByFallback && services.config.openaiApiKey === "" ? await services.codexHealth(accountId) : undefined;
        if (health?.needsReauth) {
            yield { kind: "error", code: "codex-reauth", message: health.detail };
            yield { kind: "done" };
            return;
        }
        run = services.codexAgent;
        resolvedAccount = servedByFallback ? undefined : accountId;
        // Resolve a concrete model so the turn never falls back to @openai/codex-sdk's built-in default
        // (gpt-5-codex), which a ChatGPT account can reject ("model not supported when using Codex with a ChatGPT
        // account"). An explicit selection rides through (a stale one self-heals via codex-model-invalid); an empty
        // one resolves the catalog default (discovery → persisted → seed floor, never empty — see codex-catalog).
        const model = input.model !== undefined && input.model !== "" ? input.model : (await services.codexModels.models(accountId)).default;
        const withModel = { ...base, model };
        // Pin CODEX_HOME to the resolved home; absent ⇒ the adapter's OPENAI_API_KEY fallback home. Codex takes
        // attachments structurally: images ride as native local_image inputs, the rest as a file list in the
        // prompt (split in the adapter).
        const withHome = codexHome !== undefined ? { ...withModel, codexHome } : withModel;
        request = attachmentPaths.length > 0 ? { ...withHome, attachments: attachmentPaths } : withHome;
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
        // Anthropic subscription OAuth. A codex/grok provider running UNDER this harness (harness === "claude-code")
        // instead points the harness at the sandbox's translator (CLIProxyAPI), which serves that provider on its
        // connected SUBSCRIPTION OAuth — so the turn only needs the provider's subscription connected in the translator.
        let oauthToken: string | undefined;
        let endpoint: { baseUrl: string; authToken: string; model: string } | undefined;
        if (input.agent === "codex" || input.agent === "grok") {
            if (services.config.translator.url === "") {
                yield {
                    kind: "error",
                    message:
                        "This sandbox has no model translator, so a non-Claude model can't run under the Claude Code harness here. Use the provider's native harness, or run a sandbox built from the published image.",
                };
                yield { kind: "done" };
                return;
            }
            if (!(await services.cliProxy.accounts())[input.agent]) {
                const label = input.agent === "codex" ? "ChatGPT" : "SuperGrok";
                yield {
                    kind: "error",
                    code: "subscription-required",
                    message: `Connect your ${label} subscription in Sandbox ▸ Agent to run ${input.agent} under the Claude Code harness.`,
                };
                yield { kind: "done" };
                return;
            }
            endpoint = { baseUrl: services.config.translator.url, authToken: services.config.translator.token, model: routedModel(input.agent, input.model) };
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
            }
            resolvedAccount = oauthToken !== undefined ? accountId : undefined;
            if (oauthToken === undefined && services.config.claudeCodeOauthToken === "" && services.config.anthropicApiKey === "") {
                yield { kind: "error", message: "No Claude account connected — connect it in Setup before chatting." };
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
        // Per-sandbox agent toggles. searchPastChats gives the agent the search_past_chats tool over this
        // workspace's prior sessions (Claude-only — Codex has no equivalent in-process tool seam).
        // stableSystemPrompt keeps the preset system prompt byte-stable so the provider prompt cache survives the
        // turn — the cross-provider delegation note then rides the user message instead of the system prompt.
        const { searchPastChats, stableSystemPrompt, hashlineEdits, iqSearch, outputCleaners, outputHoldout, filterBackend, terseOutput } =
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
        // turn edits, and session search reads that worktree's own session namespace. Browser profiles, plugin
        // checkouts, and attachments stay on /work — absolute-path inputs, not edit targets.
        const sdkServers = {
            ...browserServers,
            ...(searchPastChats ? { pastChats: createSessionSearchServer(effectiveCwd, input.sessionId) } : {}),
            // hashlineEdits: swap the native Edit/Write (disabled below) for hash-anchored file tools.
            ...(hashlineEdits ? { hashline: createHashlineServer(effectiveCwd) } : {}),
        };
        // Cross-provider delegation via the shell: when a Codex/Grok account is connected, the agent's Bash
        // gets the codex CLI's CODEX_HOME (first connected account, same resolution as a primary turn) and the
        // system prompt a short how-to note. Nothing connected ⇒ no env, no note — delegation isn't offered.
        const codexAccountId = (await services.codexStore.list())[0]?.id;
        const codexHome =
            codexAccountId !== undefined && (await services.codexStore.connected(codexAccountId))
                ? services.codexStore.home(codexAccountId)
                : undefined;
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
        const shellEnv = { ...cliEnv, ...(codexHome !== undefined ? { CODEX_HOME: codexHome } : {}) };
        // The turn's user message: attachment note folded in as before. With stableSystemPrompt on, the delegation
        // note is prepended HERE (a user-message preamble) instead of appended to the preset system prompt, so the
        // cached system+tools prefix stays byte-stable and the provider prompt cache is reused across the session.
        const promptWithAttachments = attachmentPaths.length > 0 ? withAttachmentNote(base.prompt, attachmentPaths) : base.prompt;
        const prompt = stableSystemPrompt && note !== undefined ? `${note}\n\n---\n\n${promptWithAttachments}` : promptWithAttachments;
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
                      ...(input.model === undefined && services.config.intenticAgentModel !== "" ? { model: services.config.intenticAgentModel } : {}),
                      ...(oauthToken !== undefined ? { oauthToken } : {}),
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
        await services.history
            .snapshot("user")
            .catch((error: unknown) => services.logger.warn({ err: error }, "history: turn-start snapshot failed"));
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
                const { kind: _kind, ...rest } = event;
                usageExtra = rest;
                // Attribute the per-turn totals (and the account-wide rate-limit snapshot) to the account that
                // served the turn, so the client keys its usage displays by account.
                yield { ...event, ...(resolvedAccount !== undefined ? { account: resolvedAccount } : {}) };
                continue;
            } else if (event.kind === "rate_limit_info") {
                yield { ...event, ...(resolvedAccount !== undefined ? { account: resolvedAccount } : {}) };
                continue;
            } else if (event.kind === "plan") {
                record({ type: "turn.plan", content: event.text, extra: { decisionId: event.decisionId } });
            } else if (event.kind === "error") {
                record({ type: "turn.error", outcome: "error", error: event.message });
            }
            yield event;
        }
    } finally {
        record({ type: "turn.completed", ...(usageExtra !== undefined ? { extra: usageExtra } : {}) });
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
        run: i.run.handler(({ input, signal }) => streamAgent(services, input, signal)),
        // Resolve a turn paused on an ExitPlanMode approval / interactive question; NOT_FOUND when nothing is
        // waiting on that id (already answered, or the turn ended).
        decision: i.decision.handler(({ input }) => {
            const resolved = resolvePlanDecision(input.decisionId, {
                approve: input.approve,
                ...(input.feedback !== undefined ? { feedback: input.feedback } : {}),
            });
            if (!resolved) {
                throw new ORPCError("NOT_FOUND", { message: "no pending plan for that decision" });
            }
            return { ok: true } as const;
        }),
        answer: i.answer.handler(({ input }) => {
            const resolved = resolveQuestionAnswer(
                input.requestId,
                input.cancelled === true ? { cancelled: true } : { answers: input.answers ?? {} },
            );
            if (!resolved) {
                throw new ORPCError("NOT_FOUND", { message: "no pending question for that request" });
            }
            return { ok: true } as const;
        }),
    };
};
