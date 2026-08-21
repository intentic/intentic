import {
    type AgentProvider,
    type AgentTurn,
    type ComplexityVerdict,
    type NativeProvider,
    NATIVE_PROVIDERS,
    type SandboxSettings,
    fastTierModel,
    judgeComplexity,
} from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";
import { splitAttachments } from "./attachment-note.js";

/* AUTOMATIC TIER SELECTION, daemon side: the one place a turn is judged and, when the owner has asked for it,
 * quietly moved onto a cheaper rung of the provider it is already on.
 *
 * The split is the same one quick-model.ts and agent-run-model.ts already make. The CONTRACT owns the rule
 * (prompt-complexity.ts judges the words, fast-tier.ts names the cheaper model), because a settings row has to
 * be able to say what a turn will run on before it runs; this file owns the facts only the daemon holds — what
 * the settings say, what the provider's catalog publishes, and what the previous turn in this conversation was
 * judged to be.
 *
 * IT SITS ABOVE THE PROVIDER SPLIT, in planTurn, which is the one function every session start in the sandbox
 * passes through: the chat, an automation wake, a Front Desk message, a workflow step, a loop iteration. One
 * placement, so a runtime added tomorrow inherits the behaviour rather than having to opt into it, and so a
 * surface can never route by accident on one runtime and not on another.
 *
 * NOTHING HERE COSTS A CALL, and in the default mode nothing here costs an I/O either. The judge is a pure
 * function over the turn's own words, and the catalog read that Auto needs happens ONLY when the owner has
 * switched routing on AND this particular turn was judged cheap, which is a small fraction of a small fraction.
 * A mechanism that exists to save money must not spend any to decide. */

// The three states of settings.autoTier, named here so the reader of a branch does not have to remember which
// string means which. "shadow" is the default: judge everything, record everything, route nothing.
const JUDGING = new Set(["shadow", "on"]);

export interface TurnTier {
    readonly verdict: ComplexityVerdict;
    /* The cheaper model this turn should actually run on, or undefined for "run what the user picked", which is
     * every turn in shadow mode, every turn judged standard, and every turn whose provider publishes nothing
     * cheaper than the pick. Three different reasons, one answer, deliberately: the caller's job is to honour a
     * substitution or not, and the ledger keeps the reasons apart (score, rules, tierRouted). */
    readonly model?: string;
}

const isNative = (provider: AgentProvider): provider is NativeProvider => (NATIVE_PROVIDERS as readonly string[]).includes(provider);

/* AUTO'S CANDIDATE LIST: what this provider publishes, or nothing.
 *
 * Native providers only. An `endpoint` provider is somebody's own model server: this repo cannot see its bill,
 * and reaching for whichever of its rows happens to carry the cheapest-sounding word is the same overreach
 * quick-model.ts already refuses when it seats an endpoint last in Auto. A PIN on an endpoint model still
 * works, because a pin is the owner saying they know what that row costs, which is exactly the fact missing
 * here. Empty is a legal answer and resolves, through fastTierModel, to no downgrade at all.
 *
 * A catalog read that fails is not a reason to fail a turn: the whole feature is optional and the fallback is
 * the model the user asked for, which is never wrong, only dearer. */
const catalogFor = async (services: Services, provider: AgentProvider): Promise<readonly string[]> => {
    if (!isNative(provider)) {
        return [];
    }
    try {
        return (await services.providerCatalogs[provider].models()).models.map((model) => model.id);
    } catch (error: unknown) {
        services.logger.warn({ err: error, provider }, "auto tier: catalog unreadable, leaving the turn on its own model");
        return [];
    }
};

/* JUDGE THIS TURN, and say what to do about it.
 *
 * `lastTier` is the previous turn's VERDICT in this conversation (AgentSummary.tier), which is the only thing
 * here that can see past the words of a follow-up: "now do the same for the other file" is nine easy words
 * carrying the whole weight of the task before them. Absent for an opening message, which is correct — a fresh
 * conversation has no history to be deceived about.
 *
 * Undefined out means the judge did not run at all ("off"), which the ledger records as absence rather than as
 * a score of zero: a turn nobody judged and a turn judged trivial are not the same row. */
export const turnTier = async (
    services: Services,
    input: AgentTurn,
    context: { readonly settings: SandboxSettings; readonly provider: AgentProvider; readonly lastTier: "fast" | "standard" | undefined },
): Promise<TurnTier | undefined> => {
    if (!JUDGING.has(context.settings.autoTier)) {
        return undefined;
    }
    const attachments = input.attachments ?? [];
    const verdict = judgeComplexity({
        prompt: input.prompt,
        attachments: attachments.length,
        hasImages: splitAttachments(attachments).images.length > 0,
        editorContext: input.editorContext !== undefined,
        unattended: input.unattended === true,
        // The starting posture only. An agent that moves itself into plan mode mid-turn has already been given
        // a model, and a turn cannot change model under its own feet.
        planMode: input.permissionMode === "plan",
        afterHardTurn: context.lastTier === "standard",
    });
    /* SHADOW STOPS HERE, and stopping here is the entire point of the mode: the verdict is recorded against
     * what the turn really cost, and the turn runs on exactly the model it would have without this file. That
     * is what turns the weights in prompt-complexity.ts from a hypothesis into something fittable, and it is
     * why the cutoff is not a number anyone had to guess in advance. */
    if (context.settings.autoTier !== "on" || verdict.tier !== "fast" || input.model === undefined) {
        return { verdict };
    }
    const model = fastTierModel({
        provider: context.provider,
        model: input.model,
        models: await catalogFor(services, context.provider),
        pinned: context.settings.autoFastModels,
    });
    return model === undefined ? { verdict } : { verdict, model };
};
