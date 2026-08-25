import type { Context } from "hono";
import { z } from "zod";
import { listSubagentSessions, waitForSubagent, type SubagentWaitUntil } from "../agent/subagents.js";
import { soleLiveConversation } from "../agent/turn-runs.js";
import type { AppEnv } from "../context.js";
import { spawnFor } from "./children.js";

/* The `agents` CLI's three routes (bin/agents), the SHELL door onto the child-agent service — what makes
 * spawning work from every runtime that has a shell and no tool seam: a native Codex, OpenCode, Kimi, Pi or
 * ACP turn runs `agents spawn` exactly where it would run any other command, and lands on the same engine the
 * Claude loop's `spawn` tool and Cursor's custom tool call in-process. Scoped to the agent token in
 * auth/grants.ts like `services` and `capabilities`.
 *
 * THE GATE IS THE ARMING, not the token. The agent token names the sandbox, not a persona, so the route
 * cannot re-derive "may this conversation spawn" from the request; planTurn already decided it, once, where
 * the persona was in hand, and recorded the decision as the ready-to-run closure (children.ts armSpawn). A
 * conversation no qualifying turn ever planned gets a refusal that says so, not a fallback.
 *
 * WHOSE conversation: the `x-intentic-conversation` header (the CLI sends INTENTIC_TURN_OWNER, the same stamp
 * the services CLI rides), falling back to the sole live turn — the services gate's own rule, for a shell
 * whose environment predates the stamp. */

const conversationOf = (c: Context<AppEnv>): string | undefined => {
    const named = c.req.header("x-intentic-conversation");
    return named !== undefined && named !== "" ? named : soleLiveConversation();
};

const SpawnBodySchema = z.object({
    prompt: z.string().min(1),
    description: z.string().max(200).optional(),
    provider: z.string().min(1).optional(),
    harness: z.enum(["native", "claude-code"]).optional(),
    model: z.string().min(1).optional(),
    effort: z.string().min(1).optional(),
});

// One wait's ceiling and default, the tool's numbers (agent/subagent-wait.ts): long enough for a real child,
// short enough that a forgotten wait returns; a caller that wants longer calls again.
const WAIT_DEFAULT_S = 600;
const WAIT_MAX_S = 1800;

const WaitBodySchema = z.object({
    target: z.string().min(1).optional(),
    until: z.array(z.enum(["blocked", "finished"])).min(1).optional(),
    timeoutSeconds: z.number().min(5).max(WAIT_MAX_S).optional(),
});

export const createChildrenRoutes = () => ({
    /** POST /children/spawn — start a child; answers `{ok:true,id}` the moment it is running. */
    spawn: async (c: Context<AppEnv>): Promise<Response> => {
        const conversationId = conversationOf(c);
        if (conversationId === undefined) {
            return c.json({ ok: false, message: "No conversation to file the child under: this shell carries no turn stamp and nothing is live." }, 400);
        }
        const spawn = spawnFor(conversationId);
        if (spawn === undefined) {
            return c.json(
                { ok: false, message: "This conversation may not spawn agents: no turn with full agency has run on it (or the daemon restarted since)." },
                403,
            );
        }
        const parsed = SpawnBodySchema.safeParse(await c.req.json().catch(() => undefined));
        if (!parsed.success) {
            return c.json({ ok: false, message: 'A spawn needs at least a prompt: pass JSON like {"prompt": "..."}.' }, 400);
        }
        const { prompt, description, provider, harness, model, effort } = parsed.data;
        const result = await spawn({
            prompt,
            ...(description !== undefined ? { description } : {}),
            ...(provider !== undefined ? { provider } : {}),
            ...(harness !== undefined ? { harness } : {}),
            ...(model !== undefined ? { model } : {}),
            ...(effort !== undefined ? { effort } : {}),
        });
        return c.json(result, result.ok ? 200 : 409);
    },
    /** POST /children/wait — park until a child of this conversation needs input or finishes. Long-poll: the
     *  connection is held for up to the asked timeout, settled early by the request's own abort. */
    wait: async (c: Context<AppEnv>): Promise<Response> => {
        const conversationId = conversationOf(c);
        if (conversationId === undefined) {
            return c.json({ outcome: "unknown-target", note: "No conversation: this shell carries no turn stamp and nothing is live." });
        }
        const parsed = WaitBodySchema.safeParse(await c.req.json().catch(() => ({})));
        if (!parsed.success) {
            return c.json({ outcome: "unknown-target", note: "The wait's own arguments did not parse; fix them rather than retrying." }, 400);
        }
        const until: readonly SubagentWaitUntil[] = parsed.data.until ?? ["blocked", "finished"];
        const result = await waitForSubagent(conversationId, {
            ...(parsed.data.target !== undefined ? { target: parsed.data.target } : {}),
            until,
            timeoutMs: Math.round((parsed.data.timeoutSeconds ?? WAIT_DEFAULT_S) * 1000),
            signal: c.req.raw.signal,
        });
        return c.json({ outcome: result.outcome, ...(result.matched !== undefined ? { agent: result.matched } : {}) });
    },
    /** GET /children — this conversation's children, every kind, live first. */
    list: async (c: Context<AppEnv>): Promise<Response> => {
        const conversationId = conversationOf(c);
        const sessions = conversationId === undefined ? [] : listSubagentSessions().filter((session) => session.conversationId === conversationId);
        return c.json({ sessions });
    },
});
