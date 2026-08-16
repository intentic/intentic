import type { PrismaClient } from "@intentic-app/prisma";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { Hono } from "hono";
import type { Logger } from "pino";
import type { Config } from "../config.js";
import { callUpstream, type Fetcher, nativeModelsUrl, poolRefused, trialEnabled, trialFloorModels, trialModels } from "./trial-pool.js";
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

// One row of an OpenAI-shaped catalog. `owned_by` names the trial rather than Google on purpose: what the user
// is spending is intentic's allowance, and the surfaces that read this say so in those words.
const modelEntry = (id: string) => ({ id, object: `model`, owned_by: `intentic-trial` });

// Google addresses a model as `models/<id>` on both of its listing surfaces; the harness addresses the bare id.
const bareId = (name: unknown): string | undefined => (typeof name === `string` ? name.replace(/^models\//, ``) : undefined);

/* WHICH OF THE UPSTREAM'S MODELS CAN BE CHATTED WITH, straight from the upstream (trial-pool's nativeModelsUrl).
 * `undefined` means it would not say — no such surface, unreachable, or a shape we do not recognise — which is
 * NOT the same as "none of them" and is why the caller falls back to the floor instead of publishing the list
 * unfiltered. Publishing it unfiltered is the bug this exists for: Imagen, Veo, Lyria, the embedding and TTS
 * endpoints and the Interactions-only previews all sorted ABOVE the Gemini rows (nothing about their ids says
 * "not a chat model"), so a fresh conversation defaulted to one and every first message failed. */
const chatCapableIds = async (config: Config, fetchFn: Fetcher): Promise<Set<string> | undefined> => {
    const url = nativeModelsUrl(config);
    if (url === undefined) {
        return undefined;
    }
    const attempt = await callUpstream(config, fetchFn, ``, { method: `GET`, url, auth: `goog` });
    if (attempt?.response.ok !== true) {
        return undefined;
    }
    const body = (await attempt.response.json().catch(() => undefined)) as
        { models?: { name?: unknown; supportedGenerationMethods?: unknown }[] } | undefined;
    if (!Array.isArray(body?.models)) {
        return undefined;
    }
    const capable = new Set<string>();
    for (const model of body.models) {
        const id = bareId(model.name);
        const methods = model.supportedGenerationMethods;
        if (id !== undefined && Array.isArray(methods) && methods.includes(`generateContent`)) {
            capable.add(id);
        }
    }
    // An answer that named nothing chat-capable is as uninformative as no answer: it can only mean the shape
    // moved under us, since a key that serves this trial demonstrably serves generateContent.
    return capable.size > 0 ? capable : undefined;
};

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

    /* The model list: discovery first, floor underneath — a ladder, like every other catalog in this product,
     * for the reason none of them may answer nothing. What made this one worth a rewrite is that its bottom rung
     * was the upstream's goodwill: Google's `/models` answers a fresh key with an EMPTY list while chat on that
     * same key answers normally, so the trial ran fine and every picker showed a group with nothing in it.
     *
     * Discovery still leads — a list written down here goes stale the day Google ships a model, and `trial.models`
     * narrows it for an operator keeping a free tier off the expensive end. Beneath it sits trialFloorModels,
     * which is never empty (trial-pool.ts). So there is no 502 rung left: an unreachable listing surface is not a
     * reason to empty a picker when we already know what this trial serves.
     *
     * WHAT DISCOVERY IS NOT ALLOWED TO DO ANY MORE IS PUBLISH EVERYTHING IT FINDS. A picker offering rows that
     * cannot answer is worse than a shorter picker, and it was worse in the way that costs the most: the ids the
     * upstream serves are ranked by the id-derived order every unranked catalog uses (model-order.ts), a family
     * it has never heard of leads on the reasoning that an unknown name is likelier to be a new flagship than a
     * new budget tier — and against a raw Google list the leaders were `antigravity-…`, `deep-research-…`,
     * `imagen-…`. So the FIRST row, which is the model a fresh conversation starts on, was one that answers
     * "This model only supports Interactions API", and the whole trial read as broken to anyone who did not go
     * looking through the picker for a Gemini row. Capability comes from the upstream itself; where it will not
     * say, the floor is served rather than a list we cannot vouch for. */
    app.get(`/v1/models`, async (c) => {
        if (!trialEnabled(config)) {
            return c.json({ error: `the free trial is not enabled on this platform` }, 404);
        }
        if ((await ownerOf(c)) === undefined) {
            return c.json({ error: `unknown sandbox` }, 404);
        }
        const narrowedTo = trialModels(config);
        const [attempt, chatCapable] = await Promise.all([
            callUpstream(config, fetchFn, `/models`, { method: `GET` }),
            chatCapableIds(config, fetchFn),
        ]);
        const body =
            attempt?.response.ok === true
                ? ((await attempt.response.json().catch(() => undefined)) as { data?: { id?: unknown }[] } | undefined)
                : undefined;
        const servable = chatCapable ?? new Set<string>();
        const discovered = (chatCapable === undefined ? [] : (body?.data ?? [])).flatMap((model) => {
            const id = bareId(model.id);
            if (id === undefined || !servable.has(id) || (narrowedTo.length > 0 && !narrowedTo.includes(id))) {
                return [];
            }
            return [modelEntry(id)];
        });
        if (discovered.length > 0) {
            return c.json({ object: `list`, data: discovered });
        }
        const floor = trialFloorModels(config);
        c.get(`logger`)?.info(
            { status: attempt?.response.status ?? 0, capabilityKnown: chatCapable !== undefined, floor },
            `trial: upstream offered no chat model, serving the floor`,
        );
        return c.json({ object: `list`, data: floor.map(modelEntry) });
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
        /* A turn NO key served is refunded and answered in our own words — including the pool's own quota
         * ceiling, which used to ride through as upstream's 429. Two things were wrong with that: the account
         * was billed a message nobody answered, so a "12 left today" that had served eight was simply untrue;
         * and Google's refusal tells the reader to "check your plan and billing details", which belongs to
         * intentic's key, not to a user who has no plan with Google and never asked for one. */
        const attempt = await callUpstream(config, fetchFn, `/chat/completions`, { method: `POST`, body });
        if (attempt === undefined || poolRefused(attempt.response.status)) {
            await refundTrialMessage(prisma, ownerId, at);
            c.get(`logger`)?.warn({ tried: attempt?.tried ?? 0, status: attempt?.response.status ?? 0 }, `trial: no key answered`);
            return c.json(
                { error: { type: `trial_unavailable`, message: `The free trial is unavailable right now. Please try again shortly.` } },
                502,
            );
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
