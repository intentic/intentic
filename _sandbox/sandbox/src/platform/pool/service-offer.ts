import type { AgentEvent, ServiceOffer } from "@intentic/sandbox-contract";
import { type CardDeps, cardRun, OFFER_DEADLINE_MS, raiseCard, whyOf } from "../../agent/run/offer-card.js";
import type { RelayedAnswer, RelayedRunAnswer } from "./pool-services.js";

/* THE SPEND GATE, what turns the services skill's etiquette into a wall.
 *
 * The agent's `services run` used to relay straight to the platform, with "quote the price and wait for a yes
 * in chat" as instructions the model was trusted to follow. This module is that consent step, moved out of the
 * model and into the daemon: the run request PARKS here, an offer card goes up in the conversation's live turn
 * with every number on it taken from the platform's own catalog answer (never from anything the model typed),
 * and the request is forwarded only when the owner's click settles the card with a yes. One click releases
 * exactly one run, a repeat parks a fresh card, so "never loop runs without asking" stopped being etiquette
 * and became a property of the plumbing. A prompt-injected model can ask; it cannot spend.
 *
 * The card is raised from OUTSIDE the turn generator (the agent's CLI call arrives as an HTTP request while
 * the turn sits inside its Bash tool): agent/offer-card.ts is that plumbing, shared with every other offer
 * card, and argues why such a card is never journalled for restore.
 *
 * WHAT THE MODEL STILL OWNS is choosing the service, composing the request body, and one line of why, the
 * three things on the card that are judgment rather than arithmetic. */

// The catalog as the platform answers it (platform pool.routes.ts /services), the read every number on the
// card comes from. Parsed loosely: a field the platform stops sending is a card that says less, not a throw.
interface CatalogAnswer {
    readonly member?: boolean;
    readonly credits?: { readonly allowance: number; readonly remaining: number; readonly resetsAt: string };
    readonly services?: readonly {
        readonly slug: string;
        readonly publisher: string;
        readonly name: string;
        readonly description: string;
        readonly creditsPerRun: number;
        // Set on a listing the platform admitted automatically and has not yet graduated (open admission's
        // probation). Optional like every other field here: a platform that stops sending it is a card that
        // says less, not a throw.
        readonly probation?: boolean;
        // A request body the provider published as a worked example of their service's shape.
        readonly sampleRequest?: string;
    }[];
}

export interface OfferDeps extends CardDeps {
    // The platform reads/writes, injected relay-shaped so tests drive the gate without a network
    // (pool-services.ts is the real pair behind both).
    readonly catalog: () => Promise<RelayedAnswer>;
    readonly run: (slug: string, body: string, onStatus: (text: string) => void) => Promise<RelayedRunAnswer>;
    // Test seam for the unanswered-offer deadline.
    readonly deadlineMs?: number;
}

export interface OfferedRun {
    readonly slug: string;
    // The request body, verbatim, already JSON-validated by the CLI, forwarded untouched on a yes.
    readonly body: string;
    // The conversation the calling shell was stamped with (INTENTIC_TURN_OWNER). The two reserved owner names
    // are "no conversation" here: a pooled process or a one-shot has no chat to raise a card in.
    readonly conversationId: string | undefined;
    readonly why: string | undefined;
    // The held CLI connection, aborts when the agent's command dies (a stop, a harness timeout), which
    // settles the card cancelled instead of leaving it parked in a conversation nothing waits behind.
    readonly signal: AbortSignal;
}

const refusal = (status: number, type: string, message: string): RelayedAnswer => ({
    status,
    body: JSON.stringify({ error: { type, message } }),
    contentType: "application/json",
});

export const gatedServiceRun = async (deps: OfferDeps, offered: OfferedRun): Promise<RelayedAnswer> => {
    const run = cardRun(deps, offered.conversationId);
    if (run === undefined) {
        return refusal(
            409,
            "no_conversation",
            "A premium service run needs a live conversation to raise its approval card in, and none could be found. Nothing was charged.",
        );
    }
    // The catalog read is the card's whole factual content. A non-200 is the platform refusing (no pool, an
    // unknown sandbox) in a sentence already written for the reader, relayed verbatim, like every refusal.
    const catalog = await deps.catalog();
    if (catalog.status !== 200) {
        return catalog;
    }
    const parsed = JSON.parse(catalog.body) as CatalogAnswer;
    const service = parsed.services?.find((entry) => entry.slug === offered.slug);
    if (service === undefined) {
        return refusal(404, "unknown_service", `No service is listed as "${offered.slug}": \`services list\` names what exists.`);
    }
    /* The member gate, answered BEFORE a card goes up: a non-member's card could only offer a button that does
     * not work, and the platform's refusal sentence (with its door to Settings → Membership) is the useful
     * thing to put in front of the agent instead. The platform re-checks on the run itself either way. */
    if (parsed.member === false) {
        return refusal(403, "membership_required", `Running ${service.name} needs an intentic membership (Settings → Membership).`);
    }
    const offer: ServiceOffer = {
        slug: service.slug,
        name: service.name,
        publisher: service.publisher,
        description: service.description,
        creditsPerRun: service.creditsPerRun,
        ...(service.probation === true ? { probation: true } : {}),
        ...(parsed.credits !== undefined ? { credits: parsed.credits } : {}),
        request: offered.body,
        ...whyOf(offered.why),
    };
    const card = await raiseCard(deps, run, {
        kind: "service_offer",
        onAbort: { kind: "service_offer", requestId: "", approve: false },
        raised: (requestId) => ({ kind: "service_offer", requestId, offer }),
        signal: offered.signal,
        deadlineMs: deps.deadlineMs ?? OFFER_DEADLINE_MS,
    });
    if (!card.reply.approve) {
        // Two different no's, told apart by whether a person actually answered (offer-card.ts argues why).
        return !card.answered
            ? refusal(
                  408,
                  "unanswered",
                  "The offer went unanswered and expired: nothing was charged. Continue without the service; offer again only if the owner shows up.",
              )
            : refusal(403, "declined", "The owner skipped this run, nothing was charged. Continue without the service.");
    }
    /* The approved run, relayed live: every `status` line off the provider's stream becomes a transcript
     * frame under the settled card the moment it arrives, so the owner watches the run they just paid for
     * living instead of a spinner of unknowable length. Not mirrored to the registry on purpose, progress
     * is not attention. */
    const outcome = await deps.run(offered.slug, offered.body, (text) => {
        run.push({ kind: "service_event", requestId: card.requestId, event: { event: "status", text } });
    });
    /* The receipt. A streamed run carries the platform's own trailer, the ledger's last word, used whole; a
     * stream that broke before its trailer gets NO receipt frame, because whether the charge stood is the
     * platform's to know and a guessed "refunded" would be the ledger's voice faked. A run that never
     * streamed falls back to what the answer's shape proves: the credits header is the platform's "this run
     * was charged" (a provider's paid 4xx), a 502 is its no-answer-no-charge refund, and anything else is a
     * refusal that spent nothing (a raced-out allowance, a service delisted between card and click). */
    const receipt: AgentEvent | undefined =
        outcome.receipt !== undefined
            ? {
                  kind: "service_receipt",
                  requestId: card.requestId,
                  outcome: outcome.receipt.outcome,
                  credits: outcome.receipt.credits,
                  ...(outcome.receipt.remaining !== undefined ? { remaining: outcome.receipt.remaining } : {}),
              }
            : outcome.streamed === true
              ? undefined
              : {
                    kind: "service_receipt",
                    requestId: card.requestId,
                    outcome: outcome.remaining !== undefined ? "ok" : outcome.status === 502 ? "refunded" : "refused",
                    credits: service.creditsPerRun,
                    ...(outcome.remaining !== undefined ? { remaining: Number(outcome.remaining) } : {}),
                };
    if (receipt !== undefined) {
        card.say(receipt);
    }
    return outcome;
};
