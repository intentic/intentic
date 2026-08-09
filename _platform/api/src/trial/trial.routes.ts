import type { PrismaClient } from "@intentic-app/prisma";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { Hono } from "hono";
import type { Logger } from "pino";
import type { Config } from "../config.js";
import { callUpstream, type Fetcher, trialEnabled, trialModelAllowlist } from "./trial-pool.js";
import { refundTrialMessage, spendTrialMessage, trialStatus } from "./trial-usage.js";

/* THE FREE TRIAL, served as a model API — the one place the platform sits ON the command path, and the reason
 * that sentence needed the word "one".
 *
 * Everything else here is identity and a stored URL: the browser drives the sandbox directly, and a platform
 * breach reads an address rather than a conversation. The trial cannot be built that way, because the whole
 * point is that the user has connected NO model account, so the only credential available is intentic's own —
 * and a credential handed to a tenant machine is a credential published. So these turns pass through, the
 * surfaces that offer the trial say exactly that in those words, and connecting any account takes the user off
 * this path for good.
 *
 * Shape: OpenAI-compatible, because that is the wire the sandbox already knows how to adopt (an `endpoint`
 * capability, re-served to the agent by the bundled translator). It buys a trial that needs no new turn path,
 * no new provider and no new adapter — the daemon points its existing endpoint machinery here and everything
 * downstream, catalog and picker included, works unchanged.
 *
 * Authenticated by the sandbox's connect token — the credential the daemon already holds and already presents
 * to /sandbox/announce — as a bearer, which is where an OpenAI-shaped client puts its API key. It resolves to
 * the sandbox's OWNER, and the owner is who the allowance belongs to. */

export interface TrialDeps {
    readonly config: Config;
    readonly prisma: PrismaClient;
    // Injected so the tests can drive the pool without a network, the same way the daemon's clients are built.
    readonly fetchFn?: Fetcher;
    readonly now?: () => Date;
}

// The bearer an OpenAI-shaped client sends. Also accepted on `x-intentic-connect`, which is what every other
// sandbox-authenticated route on this platform uses — the daemon's own status poll speaks that dialect and
// should not have to pretend to be a model client.
const connectToken = (authorization: string | undefined, header: string | undefined): string | undefined => {
    const bearer = authorization?.startsWith(`Bearer `) === true ? authorization.slice(`Bearer `.length).trim() : undefined;
    const token = bearer !== undefined && bearer !== `` ? bearer : header;
    return token === undefined || token === `` ? undefined : token;
};

export const trialRoutes = ({ config, prisma, fetchFn = fetch, now = () => new Date() }: TrialDeps) => {
    const app = new Hono<{ Variables: { logger: Logger } }>();

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
        return c.json(await trialStatus(prisma, config, ownerId, now()));
    });

    /* The model list, live from upstream rather than curated here — a list written into this file goes stale the
     * day Google ships a model, and the endpoint machinery reading it would then offer a model that no longer
     * exists. `trial.models` narrows it when an operator wants the trial kept off the expensive end of a free
     * tier; unset, the trial serves what the upstream serves. */
    app.get(`/v1/models`, async (c) => {
        if (!trialEnabled(config)) {
            return c.json({ error: `the free trial is not enabled on this platform` }, 404);
        }
        if ((await ownerOf(c)) === undefined) {
            return c.json({ error: `unknown sandbox` }, 404);
        }
        const attempt = await callUpstream(config, fetchFn, `/models`, { method: `GET` });
        if (attempt === undefined) {
            return c.json({ error: `the free trial is unavailable right now` }, 502);
        }
        if (!attempt.response.ok) {
            return c.json({ error: `the free trial is unavailable right now` }, 502);
        }
        const body = (await attempt.response.json().catch(() => undefined)) as { data?: { id?: unknown }[] } | undefined;
        const allowlist = trialModelAllowlist(config);
        const data = (body?.data ?? []).flatMap((model) => {
            // Google returns ids as `models/<id>` on this surface; the harness addresses the bare id.
            const id = typeof model.id === `string` ? model.id.replace(/^models\//, ``) : undefined;
            if (id === undefined || (allowlist.length > 0 && !allowlist.includes(id))) {
                return [];
            }
            return [{ id, object: `model`, owned_by: `intentic-trial` }];
        });
        return c.json({ object: `list`, data });
    });

    /* One trial message. The allowance is spent BEFORE the upstream call and refunded if the call never
     * produced an answer, because the alternative — bill on success — cannot be made atomic across a streamed
     * response that may fail halfway, and a meter that can be raced is not a meter. */
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
        const attempt = await callUpstream(config, fetchFn, `/chat/completions`, { method: `POST`, body });
        if (attempt === undefined || attempt.response.status >= 500) {
            await refundTrialMessage(prisma, ownerId, at);
            c.get(`logger`)?.warn({ tried: attempt?.tried ?? 0 }, `trial: no key answered`);
            return c.json({ error: { type: `trial_unavailable`, message: `The free trial is unavailable right now. Please try again shortly.` } }, 502);
        }
        /* Streamed straight through. The body is upstream's own — SSE frames for a streaming request, JSON for a
         * plain one — and re-encoding it here would mean owning a wire format that is not ours and re-shipping
         * this service every time it gains a field. The remaining-allowance count deliberately does NOT ride
         * along in it: the daemon reads that from /status, because a count buried in a stream the translator
         * re-encodes would arrive at the picker mangled or not at all. */
        return new Response(attempt.response.body, {
            status: attempt.response.status,
            headers: {
                "content-type": attempt.response.headers.get(`content-type`) ?? `application/json`,
                // Advisory, for anything reading this API directly. Nothing in the product depends on it.
                "x-intentic-trial-remaining": String(spend.remaining),
            },
        });
    });

    return app;
};
