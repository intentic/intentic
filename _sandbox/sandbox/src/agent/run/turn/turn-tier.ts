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
import type { Services } from "../../../composition.js";
import { splitAttachments } from "../../prompt/attachment-note.js";

// Judges a turn and, when auto-tier is on, moves it to a cheaper model. The contract judges the words and names the
// model (prompt-complexity.ts, fast-tier.ts); this file supplies settings, catalog and the previous turn's verdict.
// Costs no I/O unless routing is on and the turn is judged cheap.

// The three states of settings.autoTier; "shadow" judges and records but never routes.
const JUDGING = new Set(["shadow", "on"]);

export interface TurnTier {
    readonly verdict: ComplexityVerdict;
    // The cheaper model, or undefined to keep the pick; if `held` is set it must not run (the veto named it).
    readonly model?: string;
    // Set when the turn carried a veto that would otherwise have triggered a substitution (UsageTurn.tierDenied).
    readonly held?: boolean;
}

const isNative = (provider: AgentProvider): provider is NativeProvider => (NATIVE_PROVIDERS as readonly string[]).includes(provider);

// Native providers only; an endpoint provider's cost isn't visible here (a pin on one still works). Empty is legal and
// resolves to no downgrade; a failed catalog read falls back to the model the user picked.
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

// Judges this turn using the previous turn's verdict (`lastTier`, absent for an opening message) as the only memory of
// context. Undefined out means the judge did not run at all, recorded as absence, not a score of zero.
export const turnTier = async (
    services: Services,
    input: AgentTurn,
    context: {
        readonly settings: SandboxSettings;
        readonly provider: AgentProvider;
        readonly lastTier: "fast" | "standard" | undefined;
        // The user's standing veto, resolved by the caller from the turn's flag and the registry's persisted one.
        readonly hold: boolean;
    },
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
        // Starting posture only: a turn cannot change model once it has moved itself into plan mode.
        planMode: input.permissionMode === "plan",
        afterHardTurn: context.lastTier === "standard",
        // Read from settings here so the row this turn writes records the cutoff actually in force.
        eagerness: context.settings.autoTierEagerness,
    });
    // Shadow mode always returns here: the verdict is recorded but the turn runs on the model it would have anyway.
    if (context.settings.autoTier !== "on" || verdict.tier !== "fast" || input.model === undefined) {
        return { verdict };
    }
    const model = fastTierModel({
        provider: context.provider,
        model: input.model,
        models: await catalogFor(services, context.provider),
        pinned: context.settings.autoFastModels,
    });
    if (model === undefined) {
        return { verdict };
    }
    // Veto is honoured after resolving the substitution, spending its cost only on turns actually overridden.
    return context.hold ? { verdict, model, held: true } : { verdict, model };
};
