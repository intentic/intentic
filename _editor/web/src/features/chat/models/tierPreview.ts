import { fastTierModel, judgeComplexity } from "@intentic/sandbox-contract";
import { computed, type ComputedRef } from "vue";
import { useSandboxSettings } from "../../sandbox/overview/useSandboxSettings";
import type { Conversation } from "../session/conversation";
import { modelLabelFor, providerModels } from "../accounts/providerCatalog";

// Previews what the judge (prompt-complexity.ts) will decide, so the chip matches the daemon's verdict except
// where drift pushes it only upward (more attachments/context) — never a cheap promise the daemon then charges
// more for. Shown only when autoTier is `on`; Measure judges too but has no composer-facing chip (see Settings ›
// Models).

// Approximates the daemon's MIME read; erring toward "image" errs the verdict toward the safer "standard".
const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|bmp|svg|avif|heic)$/i;

export interface TierPreview {
    // A substitution about to happen, or this conversation's standing veto declining one; no third state.
    readonly kind: "route" | "held";
    // The cheaper rung: what the turn runs on instead (`route`), or what the veto declined (`held`).
    readonly cheap: string;
    // The model the user actually picked; kept alongside `cheap` since each chip sentence names the other's model.
    readonly pick: string;
}

// Getters, not captured instances: ChatPane swaps its conversation prop via a computed rather than remounting, so
// this must re-read it live. The draft getter also lets a test drive the judge with a plain string.
export const useTierPreview = (conversation: () => Conversation, draft: () => string): ComputedRef<TierPreview | undefined> => {
    const { settings } = useSandboxSettings();
    return computed<TierPreview | undefined>(() => {
        const chat = conversation();
        // `on` only: Off judges nothing, Measure judges everything but moves nothing (no chip for a non-event).
        if (settings.value?.autoTier !== `on`) {
            return undefined;
        }
        const text = draft();
        if (text.trim() === ``) {
            return undefined;
        }
        const attachments = chat.attachments.value;
        const verdict = judgeComplexity({
            prompt: text,
            attachments: attachments.length,
            hasImages: attachments.some((attachment) => IMAGE_EXT.test(attachment.name)),
            // editorContext folds in at send; reading it absent only risks promising cheap, the harmless direction.
            editorContext: false,
            unattended: false,
            planMode: chat.modePick.value === `plan`,
            afterHardTurn: chat.lastTier.value === `standard`,
            // Same dial the daemon reads; absent settings resolve to the judge's own default, matching the daemon's.
            ...(settings.value?.autoTierEagerness !== undefined ? { eagerness: settings.value.autoTierEagerness } : {}),
        });
        if (verdict.tier !== `fast`) {
            return undefined;
        }
        const provider = chat.provider.value;
        const model = fastTierModel({
            provider,
            model: chat.model.value,
            models: (providerModels.value[provider] ?? []).map((option) => option.value),
            pinned: settings.value?.autoFastModels ?? [],
        });
        if (model === undefined) {
            // Nothing cheaper published than the pick: the turn already runs what was asked, so no chip is drawn.
            return undefined;
        }
        const cheap = modelLabelFor(provider, model);
        const pick = modelLabelFor(provider, chat.model.value);
        return chat.tierHold.value ? { kind: `held`, cheap, pick } : { kind: `route`, cheap, pick };
    });
};
