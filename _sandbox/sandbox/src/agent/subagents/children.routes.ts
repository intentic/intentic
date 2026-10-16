import { conversationReader, registryProvenance } from "../../auth/scope/conversation-reader.js";
import type { Context } from "hono";
import { AgentHarnessSchema } from "@intentic/sandbox-contract/schemas/agent";
import { z } from "zod";
import { listSubagentSessions, type SubagentWaitUntil } from "./subagents.js";
import { waitForWork, workWaitAnswer } from "./work-wait.js";
import { soleLiveConversation } from "../../conversations/actor/conversation-holdings.js";
import type { AppEnv } from "../../app-env.js";
import type { Services } from "../../composition.js";
import { childLandingWords } from "../../conversations/land/child-lands.js";
import { childReportOf, pendingQuestionOf, supervisorFor } from "./children.js";
import { spawnCatalogText, spawnableProviders } from "./spawn-catalog.js";
import { markSpentByHand, unmarkSpentByHand } from "../../usage/observed-accounts.js";
import { opt } from "../../opt.js";
import { defineRawRoutes } from "../../http/raw-route-server.js";
import { parseJsonOr } from "@intentic/base/json";

// The `agents` CLI's shell door onto the child-agent service, using the same engine as the in-process tool calls.
// Scoped to the agent token; the real gate is the arming planTurn already recorded (children.ts armSupervisor), not the
// token. Conversation comes from `x-intentic-conversation`, else the sole live turn.

const conversationOf = (services: Pick<Services, "conversations">, c: Context<AppEnv>): string | undefined => {
    const named = c.req.header("x-intentic-conversation");
    return named !== undefined && named !== "" ? named : soleLiveConversation(services.conversations);
};

const SpawnBodySchema = z.object({
    prompt: z.string().min(1),
    description: z.string().max(200).optional(),
    // Both required: a child may not be pointed nowhere.
    provider: z.string().min(1),
    model: z.string().min(1),
    harness: AgentHarnessSchema.optional(),
    effort: z.string().min(1).optional(),
    // Which machine runs it: a runner's name, or "here" for this sandbox; absent lets the fleet scheduler pick.
    on: z.string().min(1).optional(),
});

// Wait's default and ceiling: long enough for a real child, short enough that a forgotten wait still returns.
const WAIT_DEFAULT_S = 600;
const WAIT_MAX_S = 1800;

const CancelBodySchema = z.object({ child: z.string().min(1) });

// A task for another of the owner's sandboxes: which link card, the whole task, and its one-line name.
const DelegateBodySchema = z.object({
    to: z.string().min(1),
    task: z.string().min(1),
    description: z.string().max(200).optional(),
});

const SendBodySchema = z.object({
    child: z.string().min(1),
    message: z.string().min(1),
});

// One of `answers` (keyed by question text) or `text` (a one-question card's shorthand).
const AnswerBodySchema = z
    .object({
        child: z.string().min(1),
        answers: z.record(z.string(), z.array(z.string())).optional(),
        text: z.string().min(1).optional(),
    })
    .refine((body) => body.answers !== undefined || body.text !== undefined, { message: "answers or text required" });

const WaitBodySchema = z.object({
    target: z.string().min(1).optional(),
    until: z.array(z.enum(["blocked", "finished"])).min(1).optional(),
    timeoutSeconds: z.number().min(5).max(WAIT_MAX_S).optional(),
});

// Marking a model spent by hand, the last resort for a plan that reports nothing. `spent: false` unmarks.
const SpentBodySchema = z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
    // Absent marks every connected account of the provider, which is what a spent subscription usually means.
    account: z.string().min(1).optional(),
    spent: z.boolean().default(true),
    // Kept on the entry so whoever reads the mark later knows what it was about.
    why: z.string().max(200).optional(),
});

// A wait's arguments: an empty body is a wait on everything with the defaults, a malformed one is no arguments at all,
// never those defaults, or a wait meant for one child would return on any other.
const waitBody = (text: string): unknown => {
    if (text.trim() === "") {
        return {};
    }
    return parseJsonOr(text, undefined);
};

const createChildrenRoutes = (services: Services) => ({
    /** POST /children/spawn — start a child; answers `{ok:true,id}` the moment it is queued, before any wait for memory. */
    spawn: async (c: Context<AppEnv>): Promise<Response> => {
        const conversationId = conversationOf(services, c);
        if (conversationId === undefined) {
            return c.json({ ok: false, message: "No conversation to file the child under: this shell carries no turn stamp and nothing is live." }, 400);
        }
        const supervisor = supervisorFor(services.conversations, conversationId);
        if (supervisor === undefined) {
            return c.json(
                { ok: false, message: "This conversation may not spawn agents: no turn with full agency has run on it (or the daemon restarted since)." },
                403,
            );
        }
        const parsed = SpawnBodySchema.safeParse(await c.req.json().catch(() => undefined));
        if (!parsed.success) {
            // The refusal includes the live catalogue, so a model isn't left guessing what's actually connected.
            const catalog = spawnCatalogText(await spawnableProviders(services));
            return c.json(
                {
                    ok: false,
                    message: `A spawn needs a prompt, a provider and a model: pass JSON like {"prompt": "...", "provider": "...", "model": "..."}.\n\nConnected right now:\n${catalog}`,
                },
                400,
            );
        }
        const { prompt, description, provider, harness, model, effort, on } = parsed.data;
        const result = await supervisor.spawn({
            prompt,
            provider,
            model,
            ...(description !== undefined ? { description } : {}),
            ...(harness !== undefined ? { harness } : {}),
            ...(effort !== undefined ? { effort } : {}),
            ...(on !== undefined ? { on } : {}),
        });
        return c.json(result, result.ok ? 200 : 409);
    },
    /** GET /children/providers — what a child could be started on right now, and what still has allowance. */
    providers: async (c: Context<AppEnv>): Promise<Response> => {
        const providers = await spawnableProviders(services);
        // `?all=1` names every unmetered model instead of counting the tail of them.
        const all = c.req.query("all");
        const named = all !== undefined && all !== "" && all !== "0" && all !== "false";
        // Both shapes: the CLI and the MCP tool print the text, anything reading this as data gets the rows.
        return c.json({ providers, text: spawnCatalogText(providers, Date.now(), { all: named }) });
    },
    /**
     * POST /children/providers/spent — marks one provider's model out of allowance by hand, or unmarks it. The last
     * resort for a plan that publishes nothing to read (Cursor, Devin): the ledger a refused turn writes is the only
     * measurement those have, and until something refuses, nothing knows. Believed 24h, or until unmarked.
     */
    markSpent: async (c: Context<AppEnv>): Promise<Response> => {
        // allow(silent-catch): a body that is not JSON is answered by the refusal below, which says what to send; the
        // parse error itself adds nothing a caller could act on.
        const parsed = SpentBodySchema.safeParse(await c.req.json().catch(() => undefined));
        if (!parsed.success) {
            return c.json(
                {
                    ok: false,
                    message: `Marking a model spent needs a provider and a model: pass JSON like {"provider": "cursor", "model": "claude-opus-5-5"}, or {"spent": false} to unmark.`,
                },
                400,
            );
        }
        const { provider, model, account, spent, why } = parsed.data;
        const asked = { provider, model, ...opt("account", account) };
        const outcome = spent ? await markSpentByHand(services, { ...asked, ...opt("why", why) }) : await unmarkSpentByHand(services, asked);
        return c.json(outcome, outcome.ok ? 200 : 400);
    },
    /** POST /children/wait — long-poll on this conversation's children and background commands. */
    wait: async (c: Context<AppEnv>): Promise<Response> => {
        const conversationId = conversationOf(services, c);
        if (conversationId === undefined) {
            return c.json({ outcome: "unknown-target", note: "No conversation: this shell carries no turn stamp and nothing is live." });
        }
        const parsed = WaitBodySchema.safeParse(waitBody(await c.req.text()));
        if (!parsed.success) {
            return c.json({ outcome: "unknown-target", note: "The wait's own arguments did not parse; fix them rather than retrying." }, 400);
        }
        const until: readonly SubagentWaitUntil[] = parsed.data.until ?? ["blocked", "finished"];
        const result = await waitForWork(services.conversations, conversationId, {
            ...(parsed.data.target !== undefined ? { target: parsed.data.target } : {}),
            until,
            timeoutMs: Math.round((parsed.data.timeoutSeconds ?? WAIT_DEFAULT_S) * 1000),
            signal: c.req.raw.signal,
        });
        return c.json(
            workWaitAnswer(result, {
                pendingQuestion: (childId) =>
                    services.linkedChildren.owns(childId) ? services.linkedChildren.pendingQuestion(childId) : pendingQuestionOf(services.conversations, childId),
                report: (childId) => (services.linkedChildren.owns(childId) ? services.linkedChildren.report(childId) : childReportOf(services.conversations, childId)),
                landing: (childId) =>
                    services.linkedChildren.owns(childId) ? services.linkedChildren.landing(childId) : childLandingWords(services.agents, childId),
            }),
        );
    },
    /** POST /children/send — steer a working child, or run a follow-up turn on a settled one. */
    send: async (c: Context<AppEnv>): Promise<Response> => {
        const conversationId = conversationOf(services, c);
        if (conversationId === undefined) {
            return c.json({ ok: false, message: "No conversation: this shell carries no turn stamp and nothing is live." }, 400);
        }
        const supervisor = supervisorFor(services.conversations, conversationId);
        if (supervisor === undefined) {
            return c.json({ ok: false, message: "This conversation may not supervise agents: no turn with full agency has run on it." }, 403);
        }
        const parsed = SendBodySchema.safeParse(await c.req.json().catch(() => undefined));
        if (!parsed.success) {
            return c.json({ ok: false, message: 'Pass JSON like {"child": "sub-…", "message": "…"}.' }, 400);
        }
        const result = await supervisor.send(parsed.data.child, parsed.data.message);
        return c.json(result, result.ok ? 200 : 409);
    },
    /** POST /children/cancel — stop a child's running turn, its pending start, or the re-run the sandbox booked for it. */
    cancel: async (c: Context<AppEnv>): Promise<Response> => {
        const conversationId = conversationOf(services, c);
        if (conversationId === undefined) {
            return c.json({ ok: false, message: "No conversation: this shell carries no turn stamp and nothing is live." }, 400);
        }
        const supervisor = supervisorFor(services.conversations, conversationId);
        if (supervisor === undefined) {
            return c.json({ ok: false, message: "This conversation may not supervise agents: no turn with full agency has run on it." }, 403);
        }
        // allow(silent-catch): a body that is not JSON is answered as a malformed one, just below.
        const parsed = CancelBodySchema.safeParse(await c.req.json().catch(() => undefined));
        if (!parsed.success) {
            return c.json({ ok: false, message: 'Pass JSON like {"child": "sub-…"}.' }, 400);
        }
        const result = await supervisor.cancel(parsed.data.child);
        return c.json(result, result.ok ? 200 : 409);
    },
    /** POST /children/merge — bring a child's work held off this conversation's checkout into it, with conflict markers. */
    merge: async (c: Context<AppEnv>): Promise<Response> => {
        const conversationId = conversationOf(services, c);
        if (conversationId === undefined) {
            return c.json({ ok: false, message: "No conversation: this shell carries no turn stamp and nothing is live." }, 400);
        }
        const supervisor = supervisorFor(services.conversations, conversationId);
        if (supervisor === undefined) {
            return c.json({ ok: false, message: "This conversation may not supervise agents: no turn with full agency has run on it." }, 403);
        }
        // allow(silent-catch): a body that is not JSON is answered as a malformed one, just below.
        const parsed = CancelBodySchema.safeParse(await c.req.json().catch(() => undefined));
        if (!parsed.success) {
            return c.json({ ok: false, message: 'Pass JSON like {"child": "sub-…"}.' }, 400);
        }
        const result = await supervisor.merge(parsed.data.child);
        return c.json(result, result.ok ? 200 : 409);
    },
    /** POST /children/answer — settle a child's question; consent cards refuse, they are the owner's. */
    answer: async (c: Context<AppEnv>): Promise<Response> => {
        const conversationId = conversationOf(services, c);
        if (conversationId === undefined) {
            return c.json({ ok: false, message: "No conversation: this shell carries no turn stamp and nothing is live." }, 400);
        }
        const supervisor = supervisorFor(services.conversations, conversationId);
        if (supervisor === undefined) {
            return c.json({ ok: false, message: "This conversation may not supervise agents: no turn with full agency has run on it." }, 403);
        }
        const parsed = AnswerBodySchema.safeParse(await c.req.json().catch(() => undefined));
        if (!parsed.success) {
            return c.json({ ok: false, message: 'Pass JSON like {"child": "sub-…", "answers": {"<question>": ["<pick>"]}} or {"child": "sub-…", "text": "…"}.' }, 400);
        }
        const { child, text } = parsed.data;
        // A bare `text` answer maps onto the question's own key; on a multi-question card the rest are unanswered.
        const answers =
            parsed.data.answers ??
            ((): Record<string, string[]> => {
                const pending = services.linkedChildren.owns(child) ? services.linkedChildren.pendingQuestion(child) : pendingQuestionOf(services.conversations, child);
                const first = pending?.questions?.[0]?.question;
                return { [first ?? ""]: [text ?? ""] };
            })();
        const result = await supervisor.answer(child, answers);
        return c.json(result, result.ok ? 200 : 409);
    },
    /** POST /children/delegate — hand a task to another of the owner's sandboxes over a link card. */
    delegate: async (c: Context<AppEnv>): Promise<Response> => {
        const conversationId = conversationOf(services, c);
        if (conversationId === undefined) {
            return c.json({ ok: false, message: "No conversation to file the task under: this shell carries no turn stamp and nothing is live." }, 400);
        }
        const supervisor = supervisorFor(services.conversations, conversationId);
        if (supervisor === undefined) {
            return c.json({ ok: false, message: "This conversation may not hand work on: no turn with full agency has run on it (or the daemon restarted since)." }, 403);
        }
        // allow(silent-catch): a body that is not JSON is answered as a malformed one, just below.
        const parsed = DelegateBodySchema.safeParse(await c.req.json().catch(() => undefined));
        if (!parsed.success) {
            return c.json({ ok: false, message: 'Pass JSON like {"to": "<link>", "task": "...", "description": "..."}; `agents links` names the links.' }, 400);
        }
        const result = await supervisor.delegate({ to: parsed.data.to, task: parsed.data.task, description: parsed.data.description });
        return c.json(result, result.ok ? 200 : 409);
    },
    /** GET /children/links — the linked sandboxes this conversation's turn may hand work to, and whether each answers. */
    links: async (c: Context<AppEnv>): Promise<Response> => {
        const conversationId = conversationOf(services, c);
        const supervisor = conversationId === undefined ? undefined : supervisorFor(services.conversations, conversationId);
        if (supervisor === undefined) {
            return c.json({ ok: false, message: "This conversation may not hand work on: no turn with full agency has run on it." }, 403);
        }
        return c.json({ ok: true, links: await supervisor.links() });
    },
    /** GET /children — this conversation's children, every kind, live first. */
    list: async (c: Context<AppEnv>): Promise<Response> => {
        const conversationId = conversationOf(services, c);
        // The header is the caller's to write: a member reads only the children of a conversation they may read.
        const reads = conversationReader(c.get("identity"), registryProvenance(services.agents));
        const sessions =
            conversationId === undefined || !reads(conversationId)
                ? []
                : listSubagentSessions(services.conversations).filter((session) => session.conversationId === conversationId);
        return c.json({ sessions });
    },
});

// The child-agent surface: start a full agent on any connected provider, park for input, list this conversation's
// children.
// The gate is the arming recorded at plan time, since the agent token names the sandbox, never a persona; scoped
// like `services`/`capabilities`.
export const childrenRawRoutes = defineRawRoutes((services: Services) => {
    const childrenRoutes = createChildrenRoutes(services);
    return {
        "POST /children/spawn": childrenRoutes.spawn,
        // What a child could be started on now, with each model's remaining allowance.
        "GET /children/providers": childrenRoutes.providers,
        "POST /children/providers/spent": childrenRoutes.markSpent,
        "POST /children/wait": childrenRoutes.wait,
        "POST /children/send": childrenRoutes.send,
        "POST /children/answer": childrenRoutes.answer,
        "POST /children/cancel": childrenRoutes.cancel,
        "POST /children/merge": childrenRoutes.merge,
        // A task handed to another of the owner's sandboxes over a link card, and which ones this turn may hand work to.
        "POST /children/delegate": childrenRoutes.delegate,
        "GET /children/links": childrenRoutes.links,
        "GET /children": childrenRoutes.list,
    };
});
