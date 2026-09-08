import type { PrismaClient } from "@intentic/prisma";
import { TRIAL_LABEL, TRIAL_MODEL_ID } from "@intentic/sandbox-contract";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { Hono } from "hono";
import type { Logger } from "pino";
import type { Config } from "../config.js";
import { createTrialLadder } from "./trial-ladder.js";
import { createTrialPool, type Fetcher, poolRefused, trialEnabled } from "./trial-pool.js";
import { recordServedModel, refundTrialMessage, spendTrialMessage, trialStatus } from "./trial-usage.js";

// Free trial served as a model API: the platform's own credential can't be handed to a tenant machine, so this is the
// one place it sits on the command path. OpenAI-compatible, so the sandbox's existing endpoint machinery works
// unchanged. Authenticated by the connect token as a bearer, resolved to the sandbox's owner.

// One row; `owned_by` names the trial, not Google, since it's intentic's own allowance being spent.
const TRIAL_CATALOG = { object: `list`, data: [{ id: TRIAL_MODEL_ID, object: `model`, owned_by: `intentic-trial`, display_name: TRIAL_LABEL }] };

// Model field is ours to set, not the caller's: whatever `model` the body names is discarded and replaced per attempt,
// since the ladder picks the rung. Non-JSON passes through untouched; the upstream's own complaint about it beats ours.
const withModel = (body: string, model: string | undefined): string => {
    if (model === undefined) {
        return body;
    }
    try {
        const parsed: unknown = JSON.parse(body);
        if (typeof parsed !== `object` || parsed === null || Array.isArray(parsed)) {
            return body;
        }
        return JSON.stringify({ ...parsed, model });
    } catch {
        return body;
    }
};

export interface TrialDeps {
    readonly config: Config;
    readonly prisma: PrismaClient;
    // Injected so tests can drive the pool without a network, like the daemon's own clients.
    readonly fetchFn?: Fetcher;
    readonly now?: () => Date;
}

// Bearer for an OpenAI-shaped client, or `x-intentic-connect`, used by every other sandbox-authenticated route.
const connectToken = (authorization: string | undefined, header: string | undefined): string | undefined => {
    const bearer = authorization?.startsWith(`Bearer `) === true ? authorization.slice(`Bearer `.length).trim() : undefined;
    const token = bearer !== undefined && bearer !== `` ? bearer : header;
    return token === undefined || token === `` ? undefined : token;
};

export const trialRoutes = ({ config, prisma, fetchFn = fetch, now = () => new Date() }: TrialDeps) => {
    const app = new Hono<{ Variables: { logger: Logger } }>();
    const pool = createTrialPool(config, fetchFn, () => now().getTime());
    const ladder = createTrialLadder(config, pool, () => now().getTime());

    // Resolves the caller to the account that pays, or refuses. 404, not 401, for an unknown token or a switched-off
    // trial: a 401 would confirm to a probe that the route exists and the token is merely wrong.
    const ownerOf = async (c: { req: { header: (name: string) => string | undefined } }): Promise<string | undefined> => {
        const token = connectToken(c.req.header(`authorization`), c.req.header(`x-intentic-connect`));
        if (token === undefined) {
            return undefined;
        }
        const sandbox = await prisma.sandbox.findUnique({ where: { tokenDigest: sha256Hex(token) }, select: { ownerId: true } });
        return sandbox?.ownerId;
    };

    // What this account has left today; polled by the daemon for the model picker's badge, and spends nothing.
    app.get(`/status`, async (c) => {
        if (!trialEnabled(config)) {
            return c.json({ error: `the free trial is not enabled on this platform` }, 404);
        }
        const ownerId = await ownerOf(c);
        if (ownerId === undefined) {
            return c.json({ error: `unknown sandbox` }, 404);
        }
        return c.json({ ...(await trialStatus(prisma, config, ownerId, now())), ...pool.status() });
    });

    // A constant list, not discovery: the old catalog could be empty, full of models that fail their first message, or
    // drift out of sync with the translator's routing table. One id can't be empty, unvouched-for, or go stale; which
    // real model runs is decided per message on the chat route.
    app.get(`/v1/models`, async (c) => {
        if (!trialEnabled(config)) {
            return c.json({ error: `the free trial is not enabled on this platform` }, 404);
        }
        if ((await ownerOf(c)) === undefined) {
            return c.json({ error: `unknown sandbox` }, 404);
        }
        return c.json(TRIAL_CATALOG);
    });

    // Allowance is spent before the upstream call and refunded unless it returns a successful completion: billing on
    // success can't be made atomic across a response that may fail mid-stream.
    app.post(`/v1/chat/completions`, async (c) => {
        if (!trialEnabled(config)) {
            return c.json({ error: `the free trial is not enabled on this platform` }, 404);
        }
        const ownerId = await ownerOf(c);
        if (ownerId === undefined) {
            return c.json({ error: `unknown sandbox` }, 404);
        }
        const body = await c.req.text();
        const at = now();
        const spend = await spendTrialMessage(prisma, config, ownerId, at);
        if (!spend.allowed) {
            // Names the way forward, not just the wall; 429 reads to an OpenAI client as "slow down".
            return c.json(
                {
                    error: {
                        type: `trial_exhausted`,
                        message: `Free trial used up for today (${spend.allowance} messages). Resets at ${spend.resetsAt}. Connect Google to keep going free.`,
                    },
                    trial: { allowance: spend.allowance, remaining: 0, resetsAt: spend.resetsAt },
                },
                429,
            );
        }
        // The ladder orders real models, the pool walks keys against them; an unserved turn is refunded and answered in
        // our own words rather than passing through Google's refusal (billing advice that doesn't apply to a user with
        // no Google plan).
        const candidates = await ladder.candidates();
        const attempt = await pool.call(`/chat/completions`, {
            method: `POST`,
            models: candidates,
            body: (model) => withModel(body, model),
            observeHealth: true,
        });
        if (attempt === undefined || poolRefused(attempt.response.status)) {
            await attempt?.response.body?.cancel().catch(() => undefined);
            await refundTrialMessage(prisma, ownerId, at);
            c.get(`logger`)?.warn(
                { tried: attempt?.tried ?? 0, status: attempt?.response.status ?? 0, candidates },
                `trial: no key answered on any model`,
            );
            return c.json(
                { error: { type: `trial_unavailable`, message: `Free trial unavailable. Try again shortly.` } },
                502,
            );
        }
        // A failed completion is preserved for the sandbox to explain, but never consumes allowance.
        if (!attempt.response.ok) {
            await refundTrialMessage(prisma, ownerId, at);
        }
        // Body streamed through untouched, since owning this wire format means re-shipping the service on every
        // upstream change. Remaining-allowance stays off it deliberately; the translator would mangle it, so the daemon
        // reads it from /status instead.
        // Not awaited: a database round trip here would delay the user's first token for a label.
        if (attempt.model !== undefined) {
            void recordServedModel(prisma, ownerId, at, attempt.model);
        }
        return new Response(attempt.response.body, {
            status: attempt.response.status,
            headers: {
                "content-type": attempt.response.headers.get(`content-type`) ?? `application/json`,
                // Advisory only, for anything reading this API directly; nothing in the product depends on it.
                "x-intentic-trial-remaining": String(spend.remaining),
                ...(attempt.model === undefined ? {} : { "x-intentic-trial-model": attempt.model }),
            },
        });
    });

    return app;
};
