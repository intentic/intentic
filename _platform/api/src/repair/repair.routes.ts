import { Hono } from "hono";
import type { Logger } from "pino";
import type { PrismaClient } from "@intentic/prisma";
import type { Auth } from "../auth.js";
import { buildOrpcContext } from "../context.js";
import type { Config } from "../config.js";
import { createTrialLadder } from "../trial/trial-ladder.js";
import { createTrialPool, poolRefused, type Fetcher,listed } from "../trial/trial-pool.js";
import { asOpenAiMessages, repairToolDefinitions, repairTurnBodySchema } from "./repair-turn-schema.js";
import { refundRepairTurn, repairStatus, spendRepairTurn } from "./repair-usage.js";

export interface RepairDeps {
    readonly config: Config;
    readonly prisma: PrismaClient;
    readonly auth: Auth;
    readonly fetchFn?: Fetcher;
    readonly now?: () => Date;
}

const repairKeys = (config: Config): string[] => {
    const own = listed(config.repair.keys);
    return own.length > 0 ? own : listed(config.trial.keys);
};

export const repairEnabled = (config: Config): boolean => repairKeys(config).length > 0;

const parseAssistant = (
    text: string,
): { content: string; toolCalls: { id: string; name: string; arguments: string }[] } | undefined => {
    try {
        const parsed = JSON.parse(text) as {
            choices?: { message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
        };
        const message = parsed.choices?.[0]?.message;
        if (message === undefined) {
            return undefined;
        }
        const toolCalls =
            message.tool_calls?.map((call) => ({
                id: call.id,
                name: call.function.name,
                arguments: call.function.arguments,
            })) ?? [];
        return { content: message.content ?? ``, toolCalls };
    } catch {
        // allow(silent-catch): upstream JSON is untrusted; a bad body becomes a generic 502 below.
        return undefined;
    }
};

export const repairRoutes = ({ config, prisma, auth, fetchFn = fetch, now = () => new Date() }: RepairDeps) => {
    const app = new Hono<{ Variables: { logger: Logger } }>();

    app.post(`/turn`, async (c) => {
        if (!repairEnabled(config)) {
            return c.json({ error: `repair is not enabled on this platform` }, 404);
        }
        const context = await buildOrpcContext({ auth, prisma, config, logger: c.get(`logger`) }, c.req.raw.headers);
        const user = context.user;
        if (user === null) {
            return c.json({ error: `sign in to use Repair` }, 401);
        }
        let rawBody: unknown;
        try {
            rawBody = await c.req.json();
        } catch {
            return c.json({ error: `invalid JSON body` }, 400);
        }
        const parsed = repairTurnBodySchema.safeParse(rawBody);
        if (!parsed.success) {
            return c.json({ error: `invalid repair turn`, issues: parsed.error.issues.map((issue) => issue.message) }, 400);
        }
        const body = parsed.data;
        const at = now();
        const spend = await spendRepairTurn(prisma, config, user.id, at);
        if (!spend.allowed) {
            return c.json(
                {
                    error: {
                        type: `repair_exhausted`,
                        message: `Repair allowance used for today (${spend.allowance} turns). Resets at ${spend.resetsAt}.`,
                    },
                    repair: { allowance: spend.allowance, remaining: 0, resetsAt: spend.resetsAt },
                },
                429,
            );
        }
        const repairConfig = {
            ...config,
            trial: {
                ...config.trial,
                keys: repairKeys(config).join(`,`),
                baseUrl: config.repair.baseUrl,
                models: config.repair.models || config.trial.models,
            },
        };
        const pool = createTrialPool(repairConfig, fetchFn, () => at.getTime());
        const ladder = createTrialLadder(repairConfig, pool, () => at.getTime());
        const candidates = await ladder.candidates();
        const payload = JSON.stringify({
            model: candidates[0],
            messages: asOpenAiMessages(body),
            tools: repairToolDefinitions(),
            max_tokens: config.repair.maxTokensPerTurn,
        });
        const attempt = await pool.call(`/chat/completions`, {
            method: `POST`,
            models: candidates,
            body: () => payload,
            observeHealth: false,
        });
        if (attempt === undefined || poolRefused(attempt.response.status)) {
            await attempt?.response.body?.cancel().catch(() => {
                // allow(silent-catch): cancel is best-effort when the pool already refused the response.
                return undefined;
            });
            await refundRepairTurn(prisma, c.get(`logger`), user.id, at);
            return c.json({ error: { type: `repair_unavailable`, message: `Repair could not reach the model. Try again shortly.` } }, 502);
        }
        const raw = await attempt.response.text();
        if (!attempt.response.ok) {
            c.get(`logger`).warn({ status: attempt.response.status, body: raw.slice(0, 2000) }, `repair upstream error`);
            await refundRepairTurn(prisma, c.get(`logger`), user.id, at);
            return c.json({ error: { type: `repair_upstream`, message: `Repair could not reach the model. Try again shortly.` } }, 502);
        }
        const assistant = parseAssistant(raw);
        if (assistant === undefined) {
            c.get(`logger`).warn({ body: raw.slice(0, 2000) }, `repair upstream answer was not parseable`);
            await refundRepairTurn(prisma, c.get(`logger`), user.id, at);
            return c.json({ error: { type: `repair_upstream`, message: `Repair could not read the model's answer. Try again shortly.` } }, 502);
        }
        const status = await repairStatus(prisma, config, user.id, at);
        const cookies = context.sessionHeaders.getSetCookie();
        const headers = new Headers({ "content-type": `application/json` });
        for (const cookie of cookies) {
            headers.append(`set-cookie`, cookie);
        }
        return new Response(
            JSON.stringify({
                message: {
                    role: `assistant`,
                    content: assistant.content,
                    toolCalls: assistant.toolCalls,
                },
                repair: status,
            }),
            { status: 200, headers },
        );
    });

    return app;
};
