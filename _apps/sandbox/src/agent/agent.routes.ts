import { type ActivityEvent, type AgentEvent, type AgentTurn, agentContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import { createOutboundSniffer } from "../activity/outbound.js";
import { browserServersOf } from "../browser/browser-tools.js";
import { cliEnvOf } from "../capabilities/cli-env.js";
import { mcpToolsOf } from "../capabilities/mcp-tools.js";
import { pluginDirsOf } from "../capabilities/plugin-dirs.js";
import { ensureFreshToken } from "../claude/claude-credentials.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { createDiscordVoiceServer } from "../discord/voice-tools.js";
import { createSessionSearchServer } from "../sessions/session-search-tool.js";
import { syncAdvisory, syncWorkspaceRepos } from "../workspace/sync-repos.js";
import { resolveWithin } from "../workspace/workspace-files.js";
import type { AgentRequest } from "./agent.js";
import { resolvePlanDecision, resolveQuestionAnswer } from "./agent-requests.js";
import { delegationNote } from "./delegation.js";

// Fold attached-file paths into the prompt — Claude Code's canonical attachment mechanism (its Read tool
// handles images and PDFs from disk natively, same as dragging a file into the CLI).
const withAttachmentNote = (prompt: string, paths: readonly string[]): string =>
    `${prompt}\n\nThe user attached these files — read them with the Read tool as needed:\n${paths.map((path) => `- ${path}`).join("\n")}`;

// Fold a switched conversation's prior transcript into the turn as a role-attributed preamble — ONE format
// for all three runtimes (native per-adapter injection can come later). Newest messages win the budget so
// long conversations keep their tail; an oversized single message is head-truncated.
const HISTORY_MESSAGE_CHAR_CAP = 4_000;
const HISTORY_CHAR_CAP = 24_000;
const withHistory = (prompt: string, history: NonNullable<AgentTurn["history"]>): string => {
    const lines: string[] = [];
    let used = 0;
    for (const message of [...history].reverse()) {
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
export async function* streamAgent(services: Services, input: AgentTurn, signal: AbortSignal | undefined): AsyncGenerator<AgentEvent> {
    // cli-kind capabilities contribute env vars (their stored credentials) so either agent's shell can run
    // their CLI tools.
    const capabilities = await services.capabilities.list();
    const cliEnv = cliEnvOf(capabilities);
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
    // Kick the repo sync off now so its network git-fetch overlaps the token refresh, browser-server setup,
    // and config reads below instead of running strictly after them. Throttled to 60s, so it's a no-op on most
    // turns; awaited just before the snapshot, which must see the pulled files (the attribution fence below).
    // A top-level failure degrades to no advisory — per-repo errors already ride inside the outcomes.
    const syncPromise = syncWorkspaceRepos(services, 60_000).catch((error: unknown) => {
        services.logger.warn({ err: error }, "repo sync failed");
        return [];
    });
    const base: AgentRequest = {
        prompt: input.history !== undefined && input.history.length > 0 ? withHistory(input.prompt, input.history) : input.prompt,
        cwd: services.workspace.root,
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
    if (input.agent === "codex") {
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
        // Pin CODEX_HOME to the resolved home; absent ⇒ the adapter's OPENAI_API_KEY fallback home. Codex takes
        // attachments structurally: images ride as native local_image inputs, the rest as a file list in the
        // prompt (split in the adapter).
        const withHome = codexHome !== undefined ? { ...base, codexHome } : base;
        request = attachmentPaths.length > 0 ? { ...withHome, attachments: attachmentPaths } : withHome;
    } else if (input.agent === "grok") {
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
        // fall back to that same retired default. Resolve from xAI's live catalog: keep the pinned model when xAI
        // still serves it, else the live default.
        const catalog = await services.openCode.xaiModels();
        const valid = new Set(catalog.models.map((entry) => entry.id));
        const model = input.model !== undefined && valid.has(input.model) ? input.model : catalog.default;
        if (model === undefined) {
            yield {
                kind: "error",
                code: "grok-model-invalid",
                message: "xAI returned no available models for your account — check your Grok (SuperGrok / X Premium) subscription.",
            };
            yield { kind: "done" };
            return;
        }
        run = services.grokAgent;
        // OpenCode holds one xAI auth, so the single Grok account is "xai" (see grok.routes.ts).
        resolvedAccount = "xai";
        // Override base's input.model with the validated id; the adapter folds attachment paths into the prompt
        // (OpenCode's tools read them from disk).
        const withModel = { ...base, model };
        request = attachmentPaths.length > 0 ? { ...withModel, attachments: attachmentPaths } : withModel;
    } else {
        const accountId = input.account ?? (await services.claudeStore.list())[0]?.id;
        let oauthToken: string | undefined;
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
        // Pre-flight the resume target: a session id that outlived its transcript (deleted, or minted before
        // the store persisted across rebuilds) would otherwise spawn the CLI just to fail opaquely — on every
        // retry. The coded error lets the UI drop the dead id so the next send starts fresh.
        if (input.sessionId !== undefined && !(await services.sessions.exists(services.workspace.root, input.sessionId))) {
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
        const plugins = pluginDirsOf(capabilities, services.workspace.root);
        // Each discord capability also grants the in-process voice tools (join_voice/leave_voice/voice_status),
        // one MCP server named for the instance — the session they drive lives in the daemon and outlives this turn.
        const discordServers = Object.fromEntries(
            capabilities.flatMap((capability) =>
                capability.kind === "cli" && capability.config.provider === "discord"
                    ? [[capability.id, createDiscordVoiceServer(services, streamAgent, capability.id, capability.config)] as const]
                    : [],
            ),
        );
        // Each logged-in browser capability grants the @playwright/mcp browser tools, bound to that platform's
        // persisted profile so the agent acts as the signed-in owner (read/reply/comment/post/join).
        const browserServers = await browserServersOf(capabilities, services.workspace.root);
        // When the sandbox setting is on, give the agent the search_past_chats tool over this workspace's prior
        // sessions (Claude-only — Codex has no equivalent in-process tool seam).
        const { searchPastChats } = await services.sandboxSettings.get();
        const sdkServers = {
            ...discordServers,
            ...browserServers,
            ...(searchPastChats ? { pastChats: createSessionSearchServer(services.workspace.root, input.sessionId) } : {}),
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
        const grokModel = grokConnected
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
        run = services.agent;
        request = {
            ...base,
            // Fall back to the daemon-wide default model when the turn didn't pin one (a per-automation
            // `model` already rode into `base` above and wins). Empty config ⇒ the subscription default.
            ...(input.model === undefined && services.config.intenticAgentModel !== "" ? { model: services.config.intenticAgentModel } : {}),
            ...(attachmentPaths.length > 0 ? { prompt: withAttachmentNote(base.prompt, attachmentPaths) } : {}),
            ...(plugins.length > 0 ? { plugins } : {}),
            ...(oauthToken !== undefined ? { oauthToken } : {}),
            ...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
            ...(tools.length > 0 ? { tools } : {}),
            ...(Object.keys(sdkServers).length > 0 ? { sdkServers } : {}),
            ...(Object.keys(shellEnv).length > 0 ? { cliEnv: shellEnv } : {}),
            ...(note !== undefined ? { systemAppend: note } : {}),
        };
    }
    // Bring every repo with a remote up to its latest commit before the agent reads the tree, so the turn works
    // on current code. Clean-only fast-forward — a dirty/diverged/detached repo is left as-is and its stale state
    // reported into the prompt so the agent knows. Throttled per repo; a network failure on one repo is isolated
    // into its outcome, never blocking the turn. Runs before the attribution snapshot so pulled files land as
    // user-authored, not attributed to this turn.
    const advisory = syncAdvisory(await syncPromise);
    if (advisory !== undefined) {
        request = { ...request, prompt: `${advisory}\n\n${request.prompt}` };
    }
    // Attribution fence: capture anything pending as user-authored (terminal edits, desktop-sync arrivals,
    // unflushed UI writes) BEFORE the agent runs, so the turn-end snapshot below is purely the agent's work.
    // A no-op skip when the tree is clean; a history failure never blocks a turn.
    await services.history.snapshot("user").catch((error: unknown) => services.logger.warn({ err: error }, "history: turn-start snapshot failed"));
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
        // or fail a turn.
        services.history.snapshot("turn").catch((error: unknown) => services.logger.warn({ err: error }, "history: turn snapshot failed"));
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
