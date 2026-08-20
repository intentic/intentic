import type { PrismaClient } from "@intentic-app/prisma";
import { TRIAL_LABEL, TRIAL_MODEL_ID } from "@intentic/sandbox-contract";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { Hono } from "hono";
import type { Logger } from "pino";
import type { Config } from "../config.js";
import { createTrialLadder } from "./trial-ladder.js";
import { createTrialPool, type Fetcher, poolRefused, trialEnabled } from "./trial-pool.js";
import { recordServedModel, refundTrialMessage, spendTrialMessage, trialStatus } from "./trial-usage.js";

/* THE FREE TRIAL, served as a model API, the one place the platform sits ON the command path, and the reason
 * that sentence needed the word "one".
 *
 * Everything else here is identity and a stored URL: the browser drives the sandbox directly, and a platform
 * breach reads an address rather than a conversation. The trial cannot be built that way, because the whole
 * point is that the user has connected NO model account, so the only credential available is intentic's own,
 * and a credential handed to a tenant machine is a credential published. So these turns pass through, the
 * surfaces that offer the trial say exactly that in those words, and connecting any account takes the user off
 * this path for good.
 *
 * Shape: OpenAI-compatible, because that is the wire the sandbox already knows how to adopt (an `endpoint`
 * capability, re-served to the agent by the bundled translator). It buys a trial that needs no new turn path,
 * no new provider and no new adapter, the daemon points its existing endpoint machinery here and everything
 * downstream, catalog and picker included, works unchanged.
 *
 * Authenticated by the sandbox's connect token, the credential the daemon already holds and already presents
 * to /sandbox/announce, as a bearer, which is where an OpenAI-shaped client puts its API key. It resolves to
 * the sandbox's OWNER, and the owner is who the allowance belongs to. */

/* THE WHOLE CATALOG, one row, and `display_name` is what the picker renders, so the trial names itself rather
 * than being labelled again in the client. `owned_by` names the trial rather than Google on purpose: what the
 * user is spending is intentic's allowance, and the surfaces that read this say so in those words. */
const TRIAL_CATALOG = { object: `list`, data: [{ id: TRIAL_MODEL_ID, object: `model`, owned_by: `intentic-trial`, display_name: TRIAL_LABEL }] };

/* THE MODEL FIELD IS OURS TO SET, not the caller's to choose, which is the whole bargain of a routed trial.
 *
 * The body arrives as text and is streamed to whichever rung of the ladder is being tried, so the id in it has
 * to be replaced per attempt. A body that is not JSON is passed through untouched: it is going to be refused by
 * the upstream either way, and the upstream's own complaint about it is more useful than ours.
 *
 * Whatever the caller put in `model` is discarded rather than honoured. The published catalog has exactly one
 * id, so a caller naming anything else is naming a model this trial does not offer, and one that names a real
 * Google id is asking to pick their own rung, which is the choice the ladder exists to take away. */
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
    // Injected so the tests can drive the pool without a network, the same way the daemon's clients are built.
    readonly fetchFn?: Fetcher;
    readonly now?: () => Date;
}

// The bearer an OpenAI-shaped client sends. Also accepted on `x-intentic-connect`, which is what every other
// sandbox-authenticated route on this platform uses, the daemon's own status poll speaks that dialect and
// should not have to pretend to be a model client.
const connectToken = (authorization: string | undefined, header: string | undefined): string | undefined => {
    const bearer = authorization?.startsWith(`Bearer `) === true ? authorization.slice(`Bearer `.length).trim() : undefined;
    const token = bearer !== undefined && bearer !== `` ? bearer : header;
    return token === undefined || token === `` ? undefined : token;
};

export const trialRoutes = ({ config, prisma, fetchFn = fetch, now = () => new Date() }: TrialDeps) => {
    const app = new Hono<{ Variables: { logger: Logger } }>();
    const pool = createTrialPool(config, fetchFn, () => now().getTime());
    const ladder = createTrialLadder(config, pool, () => now().getTime());

    /* Resolve the caller to the account that pays, or refuse. 404 rather than 401 for an unknown token, and for
     * a trial that is switched off: both are "there is nothing here", and a 401 would confirm to a probe that a
     * token is merely wrong rather than that the route is closed. */
    const ownerOf = async (c: { req: { header: (name: string) => string | undefined } }): Promise<string | undefined> => {
        const token = connectToken(c.req.header(`authorization`), c.req.header(`x-intentic-connect`));
        if (token === undefined) {
            return undefined;
        }
        const sandbox = await prisma.sandbox.findUnique({ where: { tokenDigest: sha256Hex(token) }, select: { ownerId: true } });
        return sandbox?.ownerId;
    };

    // What this account has left today. The daemon polls it so the model picker can badge the trial with a real
    // number; it spends nothing, so polling it is free.
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

    /* THE MODEL LIST IS A CONSTANT NOW, and every hard thing about this route went away with the list.
     *
     * It used to discover the upstream's catalog, filter it by capability, and publish the survivors, with a
     * floor underneath, because Google's `/models` answers a fresh key with an EMPTY list while chat on that same
     * key works. Three failure modes lived in that: a picker with nothing in it, a picker full of rows that
     * cannot answer (the `generateContent` flag is declared by deep-research, gemma, lyria, robotics and
     * computer-use models that all fail the first message), and, the one that produced the error people
     * actually reported, a list that MOVED. The sandbox's translator writes its routing table from this
     * catalog at boot and on capability edits while the picker re-reads it every minute, so a model discovered
     * in between was offered and then refused with "unknown provider for model".
     *
     * One id ends all three. It cannot be empty, nothing unvouched-for can appear in it, and a routing table
     * built from a constant cannot go stale. WHICH real model runs is decided per message on the chat route,
     * by the only party that can see which key still has quota on which model. */
    app.get(`/v1/models`, async (c) => {
        if (!trialEnabled(config)) {
            return c.json({ error: `the free trial is not enabled on this platform` }, 404);
        }
        if ((await ownerOf(c)) === undefined) {
            return c.json({ error: `unknown sandbox` }, 404);
        }
        return c.json(TRIAL_CATALOG);
    });

    /* One trial message. The allowance is spent BEFORE the upstream call and refunded unless it returns a
     * successful completion response, because the alternative, bill on success, cannot be made atomic across
     * a streamed response that may fail halfway, and a meter that can be raced is not a meter. */
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
            // The message a user actually reads when the trial runs out, so it names the way forward rather than
            // just the wall. 429 is the status an OpenAI-shaped client already understands as "slow down".
            return c.json(
                {
                    error: {
                        type: `trial_exhausted`,
                        message: `Free trial used up for today (${spend.allowance} messages). It resets at ${spend.resetsAt}. Connect a Google account in Sandbox ▸ Agent to keep going for free.`,
                    },
                    trial: { allowance: spend.allowance, remaining: 0, resetsAt: spend.resetsAt },
                },
                429,
            );
        }
        /* WHERE THE ROUTING HAPPENS. The caller asked for the trial's single published id; the ladder says which
         * real models may answer, in preference order, and the pool walks them against its keys until one does.
         * A quota window closed on the first rung therefore costs a user one refused request rather than their
         * message, which is the entire reason the picker no longer asks them to choose.
         *
         * A turn NO rung served is refunded and answered in our own words, including the pool's own quota
         * ceiling, which used to ride through as upstream's 429. Two things were wrong with that: the account
         * was billed a message nobody answered, so a "12 left today" that had served eight was simply untrue;
         * and Google's refusal tells the reader to "check your plan and billing details", which belongs to
         * intentic's key, not to a user who has no plan with Google and never asked for one. */
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
                { error: { type: `trial_unavailable`, message: `The free trial is unavailable right now. Please try again shortly.` } },
                502,
            );
        }
        // Any non-successful completion is a message the user did not receive. Request-scoped 4xx answers are
        // preserved so the sandbox can explain that model/request failure, but they do not consume allowance.
        if (!attempt.response.ok) {
            await refundTrialMessage(prisma, ownerId, at);
        }
        /* Streamed straight through. The body is upstream's own. SSE frames for a streaming request, JSON for a
         * plain one, and re-encoding it here would mean owning a wire format that is not ours and re-shipping
         * this service every time it gains a field. The remaining-allowance count deliberately does NOT ride
         * along in it: the daemon reads that from /status, because a count buried in a stream the translator
         * re-encodes would arrive at the picker mangled or not at all.
         *
         * WHICH MODEL ANSWERED is recorded before the response leaves, because the user is told it on the turn
         * and this is the only moment anyone knows. The header beside it is for whatever reads this API
         * directly; the daemon cannot see it, since the translator between us does not forward response headers,
         * which is exactly why the fact is also written to the account's status. */
        /* Not awaited: the upstream's headers are in and the body is about to start flowing, so a database
         * round trip here is delay on the user's first token, paid for a label. The write is non-throwing and
         * the value is not read until the status poll that follows the turn, which is seconds away. */
        if (attempt.model !== undefined) {
            void recordServedModel(prisma, ownerId, at, attempt.model);
        }
        return new Response(attempt.response.body, {
            status: attempt.response.status,
            headers: {
                "content-type": attempt.response.headers.get(`content-type`) ?? `application/json`,
                // Advisory, for anything reading this API directly. Nothing in the product depends on it.
                "x-intentic-trial-remaining": String(spend.remaining),
                ...(attempt.model === undefined ? {} : { "x-intentic-trial-model": attempt.model }),
            },
        });
    });

    return app;
};
