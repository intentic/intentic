import { fastTierModel, judgeComplexity } from "@intentic/sandbox-contract";
import { computed, type ComputedRef } from "vue";
import { useSandboxSettings } from "../sandbox/useSandboxSettings";
import type { Conversation } from "./conversation";
import { modelLabelFor, providerModels } from "./providerCatalog";

/* THE COMPOSER SAYING WHAT THE JUDGE WILL SAY, before send. The judge is a pure function in the contract for
 * exactly this (prompt-complexity.ts): the daemon and this file run the same rules over the same words, so the
 * chip over the send button and the tier frame that comes back agree except where they honestly cannot.
 *
 * WHERE THEY CANNOT: the daemon resolves @-mentions into the attachment count and folds the editor chip in
 * after upload, and this preview reads the draft as it sits. Both drifts push the daemon's verdict UP (more
 * attachments, more context), never down, so the one wrong state this preview can reach is promising a cheap
 * turn that then runs the user's own pick — the harmless direction, and the tier frame corrects the record the
 * moment the turn starts. This is the design's own constraint ("the composer's pre-send label is never wrong in
 * the expensive direction", docs/model-routing-design.md §3.3) landing where it was always meant to.
 *
 * NOTHING IS PREVIEWED unless the verdict is fast AND the mode gives the verdict a consequence: a chip
 * confirming that nothing will happen is noise. Measure mode shows "looks simple" as awareness (that is the
 * mode's whole product); on mode names the model the turn will actually run, or the veto that stops it. */

// The image extensions the attachment strip itself previews. An approximation of the daemon's own MIME read,
// erring toward "image", which errs the verdict toward standard, the safe direction.
const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|bmp|svg|avif|heic)$/i;

export interface TierPreview {
    // What the chip says: measuring awareness, an actual substitution, or the user's own standing veto.
    readonly kind: "measure" | "route" | "held";
    // The cheap model's display label, present on "route"/"held" when one is resolvable client-side.
    readonly label?: string;
}

/* The preview for one composer. GETTERS, not captured instances: the chat pane swaps its conversation prop in
 * place (ChatPane wraps it in a computed rather than remounting), so anything closed over here must re-read the
 * live one. The draft getter doubles as the test seam: a spec can drive the judge with a plain string. */
export const useTierPreview = (conversation: () => Conversation, draft: () => string): ComputedRef<TierPreview | undefined> => {
    const { settings } = useSandboxSettings();
    return computed<TierPreview | undefined>(() => {
        const chat = conversation();
        const mode = settings.value?.autoTier;
        if (mode === undefined || mode === `off`) {
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
            // The chip folds in at send; reading it as absent can only make this preview promise a cheap turn
            // the daemon then keeps on the pick, the harmless direction (see the header).
            editorContext: false,
            unattended: false,
            planMode: chat.modePick.value === `plan`,
            afterHardTurn: chat.lastTier.value === `standard`,
            // The same dial the daemon reads, so the chip cannot promise a cutoff the turn will not be judged
            // against. Absent settings resolve to the judge's own default, which is the daemon's too.
            ...(settings.value?.autoTierEagerness !== undefined ? { eagerness: settings.value.autoTierEagerness } : {}),
        });
        if (verdict.tier !== `fast`) {
            return undefined;
        }
        if (mode === `shadow`) {
            return { kind: `measure` };
        }
        const provider = chat.provider.value;
        const model = fastTierModel({
            provider,
            model: chat.model.value,
            models: (providerModels.value[provider] ?? []).map((option) => option.value),
            pinned: settings.value?.autoFastModels ?? [],
        });
        if (model === undefined) {
            // Nothing cheaper published than the pick: the turn runs what was asked, and a chip saying so
            // would be confirming a control that did nothing.
            return undefined;
        }
        const label = modelLabelFor(provider, model);
        return chat.tierHold.value ? { kind: `held`, label } : { kind: `route`, label };
    });
};
