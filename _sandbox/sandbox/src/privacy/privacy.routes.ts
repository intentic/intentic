import { conversationReader, registryProvenance } from "../auth/scope/conversation-reader.js";
import { noteAudit } from "../audit/audit-http.js";
import { errorMessage } from "@intentic/base/errors";
import { privacyContract } from "@intentic/sandbox-contract/contracts/privacy.contract";
import {
    PRIVACY_PATTERN_MAX,
    type PrivacyPatternProblem,
    type PrivacyShieldPolicy,
    patternProblem,
} from "@intentic/sandbox-contract/schemas/privacy";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../app-env.js";
import type { Services } from "../composition.js";
import { nameDictionary } from "./name-dictionary.js";
import { detectorFor } from "./policy-detector.js";
import { nerInstalled } from "./ner.js";
import { shieldedInReplies } from "./shielded-replies.js";
import { privacyPinRefusal } from "../compliance/org-pins.js";
import { provesOwner } from "../seams/workload-stamp.js";
import {
    applyProposal,
    dismissProposal,
    judgeLeak,
    LeakRefusal,
    type LeaksDeps,
    leaksView,
    measureLeakHardening,
    proposeHardening,
    reportLeak,
    scanLeaks,
} from "./leaks/leaks-service.js";

// The privacy shield's page and the agent CLI's door: the status everybody may read, the policy only the owner may
// change (the route's floor says so, and the agent's token never reaches it), the log and the values behind its tokens
// (those the owner's alone too), and the taught datasets.
// Teaching masks more, so the agent may; forgetting masks less, so only the owner may.

// Unreadable stores are an error here, not an empty answer: an empty policy would read as the shield being off.
const failing = (error: unknown): ORPCError<"INTERNAL_SERVER_ERROR", unknown> =>
    new ORPCError("INTERNAL_SERVER_ERROR", { message: errorMessage(error), cause: error });

// The read, or a store that cannot be read as the error it is.
const orFailing = async <T>(read: Promise<T>): Promise<T> => {
    try {
        return await read;
    } catch (error) {
        throw failing(error);
    }
};

const PATTERN_PROBLEMS = {
    invalid: "is not a regular expression the shield can read",
    tooLong: `is longer than ${PRIVACY_PATTERN_MAX} characters`,
    empty: "matches empty text, so it would mask nothing and cost every request",
    nested: "repeats a group that repeats inside itself, like (a+)+, which can hold the daemon for minutes on one line; write it without the nested repeat",
} as const satisfies Record<PrivacyPatternProblem, string>;

// Why a rule the save adds or changes cannot run. A pattern already saved stands as it is, so a build that judges more
// strictly never refuses a whole policy for what an earlier one took.
export const patternRefusal = (input: PrivacyShieldPolicy, saved: PrivacyShieldPolicy): string | undefined => {
    const kept = new Set(saved.rules.map((rule) => rule.pattern));
    for (const rule of input.rules) {
        const problem = rule.match === "pattern" && !kept.has(rule.pattern) ? patternProblem(rule.pattern) : undefined;
        if (problem !== undefined) {
            return `The rule "${rule.title}" can't be saved: its pattern ${PATTERN_PROBLEMS[problem]}.`;
        }
    }
    return undefined;
};

// A refusal the leaks service worded, as the route's answer; anything else is a fault and goes through as one.
const answered = async <T>(work: Promise<T>): Promise<T> => {
    try {
        return await work;
    } catch (error) {
        if (error instanceof LeakRefusal) {
            throw new ORPCError("BAD_REQUEST", { message: error.message });
        }
        throw error;
    }
};

// The conversation an agent CLI names, believed only with its turn's proof.
const provenConversation = (headers: Headers): string | undefined => {
    const named = headers.get("x-intentic-conversation") ?? undefined;
    return named !== undefined && named !== "" && provesOwner(named, headers.get("x-intentic-turn-proof") ?? undefined) ? named : undefined;
};

type PrivacyServices = Pick<Services, "agents" | "privacyShield" | "privacyLeaks" | "transcripts" | "composeEnvironment" | "logger" | "orgPolicy">;

// The owner's write of the whole policy: the organisation's pins, then the patterns, then the environment's recompose.
const policySaver =
    (services: PrivacyServices) =>
    async (input: PrivacyShieldPolicy): Promise<void> => {
        const shield = services.privacyShield;
        // The organisation's pins hold whatever is saved; a save that would undo one is refused with it named.
        const pinned = await privacyPinRefusal(services.orgPolicy, input, async () => nerInstalled());
        if (pinned !== undefined) {
            throw new ORPCError("FORBIDDEN", { message: pinned.error, data: pinned });
        }
        const refused = patternRefusal(input, await orFailing(shield.policy()));
        if (refused !== undefined) {
            throw new ORPCError("BAD_REQUEST", { message: refused });
        }
        noteAudit({ details: { mode: input.mode, trusted: input.trusted.length, rules: input.rules.length } });
        await shield.setPolicy(input);
        // The policy decides whether the privacy pack rides the overlay (environment/privacy-pack.ts), so the
        // Environment card offers the rebuild that installs its readers, or drops them, the moment it changes. Saved
        // either way: a compose that failed is the overlay's problem, not a reason to refuse the owner's policy.
        await services.composeEnvironment().catch((error: unknown) => {
            services.logger.warn({ err: error }, "privacy policy saved, but recomposing the environment failed");
        });
    };

// Whether this reader may read leak values: a person (the route's right already held them to running the shield), or an
// agent whose proven conversation runs on a provider the values pass to as they are. Never an agent that cannot say
// which conversation it is.
// What deciding it reads: the conversation's provider, and the shield's verdict on it.
export interface RevealDeps {
    readonly privacyShield: Pick<Services["privacyShield"], "decide">;
    readonly agents: { readonly entry: (id: string) => { readonly profile: { readonly provider: string } } | undefined };
}

export const revealer =
    (services: RevealDeps) =>
    async (context: OrpcContext): Promise<boolean> => {
        if (context.headers.get("x-intentic-agent") === null) {
            return true;
        }
        const conversationId = provenConversation(context.headers);
        const provider = conversationId === undefined ? undefined : services.agents.entry(conversationId)?.profile.provider;
        if (provider === undefined) {
            return false;
        }
        return (await services.privacyShield.decide({ provider, conversationId, route: "gateway" })).verdict.kind === "pass";
    };

export const createPrivacyRoutes = (services: PrivacyServices) => {
    const i = implement(privacyContract).$context<OrpcContext>();
    const shield = services.privacyShield;
    const leaks: LeaksDeps = {
        shield,
        store: services.privacyLeaks,
        conversations: () => services.agents.list(),
        rows: (conversationId) => services.transcripts.rows({ id: conversationId }),
    };
    const savePolicy = policySaver(services);
    const mayReveal = revealer(services);
    return {
        status: i.status.handler(async () =>
            shield.status().catch((error: unknown) => {
                throw failing(error);
            }),
        ),
        setPolicy: i.setPolicy.handler(async ({ input }) => {
            await savePolicy(input);
            return { ok: true } as const;
        }),
        // Each entry quotes the text around what was masked, so it is read as its conversation is.
        log: i.log.handler(async ({ context }) => {
            const reads = conversationReader(context.identity, registryProvenance(services.agents));
            return (await shield.ledger.recent()).filter((entry) => reads(entry.conversationId));
        }),
        // The conversation's own words, so read as the conversation is: one this caller cannot read answers as one never masked.
        shielded: i.shielded.handler(async ({ input, context }) => {
            const reads = conversationReader(context.identity, registryProvenance(services.agents));
            if (!reads(input.conversationId)) {
                return [];
            }
            return orFailing(
                shieldedInReplies(
                    { shield, provider: (id) => services.agents.entry(id)?.profile.provider, rows: (id) => services.transcripts.rows({ id }) },
                    input.conversationId,
                ),
            );
        }),
        reveal: i.reveal.handler(async ({ input }) =>
            shield.reveal(input.tokens).catch((error: unknown) => {
                throw failing(error);
            }),
        ),
        image: i.image.handler(async ({ input }) => {
            const pair = await shield.images.read(input.id);
            if (pair === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "That image is no longer kept: only the most recent ones are." });
            }
            return pair;
        }),
        // Read under the policy as saved: the lists the owner switched off or added, and the lexicon the shield reads.
        dictionary: i.dictionary.handler(async ({ input }) => {
            const policy = await orFailing(shield.policy());
            return nameDictionary(input.query, policy.dictionary, detectorFor(policy).lexicon);
        }),
        preview: i.preview.handler(async ({ input }) => orFailing(shield.preview(input.text))),
        sources: i.sources.handler(async () =>
            shield.sources().catch((error: unknown) => {
                throw failing(error);
            }),
        ),
        learn: i.learn.handler(async ({ input }) => shield.learn(input.source, input.values)),
        forget: i.forget.handler(async ({ input }) => ({ forgotten: await shield.forget(input.source) })),
        leaks: i.leaks.handler(async ({ context }) => orFailing(leaksView(leaks, await mayReveal(context)))),
        report: i.report.handler(async ({ input }) => ({ id: (await answered(reportLeak(leaks, input))).id })),
        judge: i.judge.handler(async ({ input }) => {
            await answered(judgeLeak(leaks, input.id, input.state));
            return { ok: true } as const;
        }),
        scan: i.scan.handler(async ({ input }) => orFailing(scanLeaks(leaks, input.conversations))),
        tryHardening: i.tryHardening.handler(async ({ input, context }) => answered(measureLeakHardening(leaks, input, await mayReveal(context)))),
        propose: i.propose.handler(async ({ input, context }) => answered(proposeHardening(leaks, input, provenConversation(context.headers)))),
        applyProposal: i.applyProposal.handler(async ({ input }) => {
            await answered(applyProposal(leaks, input.id, savePolicy));
            return { ok: true } as const;
        }),
        dismissProposal: i.dismissProposal.handler(async ({ input }) => {
            await answered(dismissProposal(leaks, input.id));
            return { ok: true } as const;
        }),
        hardeningSession: i.hardeningSession.handler(async ({ input }) => {
            await services.privacyLeaks.noteSession(input.conversationId, new Date().toISOString());
            return { ok: true } as const;
        }),
    };
};
