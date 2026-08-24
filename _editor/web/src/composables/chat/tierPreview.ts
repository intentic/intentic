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
 * NOTHING IS PREVIEWED UNLESS THE TURN IS REALLY ABOUT TO MOVE. The judge runs in Measure mode too, and this
 * used to say so on the composer ("Looks simple", inert, explained only by a hover title). That is the state
 * most people are in — Measure is the default — so the feature's whole public face was a label with no
 * consequence, no press, and no sentence a mouse-less or touch reader could ever reach. A control that reports
 * a non-event teaches people to stop reading the row it sits in, and that row is where the model, the mode and
 * the persona also announce themselves. Measure's product is the ledger, and the ledger is read where it can be
 * acted on (Settings › Models: "62 of 100 simple · $4.20 on your pick"), plus the picker's own after-the-fact
 * line. So the preview answers only in `on`, where there are exactly two things worth a chip: the substitution
 * that is about to happen, and this conversation's veto declining one. */

// The image extensions the attachment strip itself previews. An approximation of the daemon's own MIME read,
// erring toward "image", which errs the verdict toward standard, the safe direction.
const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|bmp|svg|avif|heic)$/i;

export interface TierPreview {
    // A substitution about to happen, or this conversation's standing veto declining one. No third state: a
    // mode that changes nothing draws nothing (see the header).
    readonly kind: "route" | "held";
    // The cheaper rung: what the turn runs on instead ("route"), or what the veto just declined ("held").
    readonly cheap: string;
    /* The model the user actually picked. BOTH labels, always, because the chip's two sentences each need the
     * other's model: "runs on Haiku instead of Opus", "kept on Opus rather than Haiku". Reading the pick off
     * the pill next door is not the same thing — the pill is a separate control that truncates its own name. */
    readonly pick: string;
}

/* The preview for one composer. GETTERS, not captured instances: the chat pane swaps its conversation prop in
 * place (ChatPane wraps it in a computed rather than remounting), so anything closed over here must re-read the
 * live one. The draft getter doubles as the test seam: a spec can drive the judge with a plain string. */
export const useTierPreview = (conversation: () => Conversation, draft: () => string): ComputedRef<TierPreview | undefined> => {
    const { settings } = useSandboxSettings();
    return computed<TierPreview | undefined>(() => {
        const chat = conversation();
        // `on` only. Off judges nothing; Measure judges everything and moves nothing, and a chip for a
        // non-event is the thing this preview stopped drawing (see the header).
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
        const cheap = modelLabelFor(provider, model);
        const pick = modelLabelFor(provider, chat.model.value);
        return chat.tierHold.value ? { kind: `held`, cheap, pick } : { kind: `route`, cheap, pick };
    });
};
