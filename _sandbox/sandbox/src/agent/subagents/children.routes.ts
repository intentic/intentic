import type { Context } from "hono";
import { z } from "zod";
import { listSubagentSessions, type SubagentWaitUntil } from "./subagents.js";
import { waitForWork, workWaitAnswer } from "./work-wait.js";
import { soleLiveConversation } from "../../agents/actor/conversation-holdings.js";
import type { AppEnv } from "../../app-env.js";
import type { Services } from "../../composition.js";
import { pendingQuestionOf, supervisorFor } from "./children.js";
import { spawnCatalogText, spawnableProviders } from "./spawn-catalog.js";

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
    harness: z.enum(["native", "claude-code"]).optional(),
    effort: z.string().min(1).optional(),
    // Which machine runs it: a runner's name, or "here" for this sandbox; absent lets the fleet scheduler pick.
    on: z.string().min(1).optional(),
});

// Wait's default and ceiling: long enough for a real child, short enough that a forgotten wait still returns.
const WAIT_DEFAULT_S = 600;
const WAIT_MAX_S = 1800;

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

// A wait's arguments: an empty body is a wait on everything with the defaults, a malformed one is no arguments at all,
// never those defaults, or a wait meant for one child would return on any other.
const waitBody = (text: string): unknown => {
    if (text.trim() === "") {
        return {};
    }
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
};

export const createChildrenRoutes = (services: Services) => ({
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
        // Both shapes: the CLI and the MCP tool print the text, anything reading this as data gets the rows.
        return c.json({ providers, text: spawnCatalogText(providers) });
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
        return c.json(workWaitAnswer(result, (childId) => pendingQuestionOf(services.conversations, childId)));
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
                const first = pendingQuestionOf(services.conversations, child)?.questions?.[0]?.question;
                return { [first ?? ""]: [text ?? ""] };
            })();
        const result = await supervisor.answer(child, answers);
        return c.json(result, result.ok ? 200 : 409);
    },
    /** GET /children — this conversation's children, every kind, live first. */
    list: async (c: Context<AppEnv>): Promise<Response> => {
        const conversationId = conversationOf(services, c);
        const sessions =
            conversationId === undefined
                ? []
                : listSubagentSessions(services.conversations).filter((session) => session.conversationId === conversationId);
        return c.json({ sessions });
    },
});
