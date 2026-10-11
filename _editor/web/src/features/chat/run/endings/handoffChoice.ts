import { HANDOFF_MODES, type HandoffMode, type HandoffOffer } from "@intentic/sandbox-contract";
import { formatTokens, type IconName, type Tip } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";

// How a spent allowance's held turn continues once its cache has gone cold, as the pick-up card asks it: carry the
// session whole, trim it, or open a fresh one from a summary (contract: schemas/providers/handoff.ts). The sandbox
// suggests one by the conversation's size and the person decides; this file is every word the card says about it, so the
// pills, their hovers and the line beside them cannot drift apart.

const ICONS: Readonly<Record<HandoffMode, IconName>> = { carry: `history`, trim: `eraser`, summary: `align-left` };

export const handoffLabel = (mode: HandoffMode): string => t(`chat.handoffChoice.${mode}`);

const brief = (mode: HandoffMode): string => t(`chat.handoffChoice.${mode}Brief`);

// What the way does, with the daemon's own sizes where it measured them.
export const handoffWhat = (offer: HandoffOffer, mode: HandoffMode): string => {
    const carried = offer.carry?.tokens;
    switch (mode) {
        case `carry`:
            return carried === undefined ? t(`chat.handoffChoice.carryWhatUnmeasured`) : t(`chat.handoffChoice.carryWhat`, { tokens: formatTokens(carried) });
        case `trim`: {
            const trim = offer.trim;
            if (trim === undefined) {
                return ``;
            }
            return carried === undefined
                ? t(`chat.handoffChoice.trimWhatUnmeasured`, { cleared: trim.cleared, tokens: formatTokens(trim.tokens) })
                : t(`chat.handoffChoice.trimWhat`, { cleared: trim.cleared, tokens: formatTokens(trim.tokens), from: formatTokens(carried) });
        }
        case `summary`: {
            const summary = offer.summary;
            if (summary === undefined) {
                return ``;
            }
            return summary.reads === undefined
                ? t(`chat.handoffChoice.summaryWhatUnread`, { tokens: formatTokens(summary.tokens) })
                : t(`chat.handoffChoice.summaryWhat`, { tokens: formatTokens(summary.tokens), reads: formatTokens(summary.reads) });
        }
    }
};

// Why the selected way is the selected one: the sandbox's suggestion (by size or by the owner's setting), or the person's
// own pick, which then names what was suggested so going back is one look away.
export const handoffWhy = (offer: HandoffOffer, mode: HandoffMode): string => {
    if (mode !== offer.suggested) {
        return t(`chat.handoffChoice.suggestedWas`, { way: handoffLabel(offer.suggested) });
    }
    return offer.basis === `setting` ? t(`chat.handoffChoice.yourDefault`) : t(`chat.handoffChoice.suggestedForSize`);
};

/** The line beside the pills: what the selected way does, then why it is selected. */
export const handoffLine = (offer: HandoffOffer, mode: HandoffMode): string => `${handoffWhat(offer, mode)} ${handoffWhy(offer, mode)}`;

export interface HandoffOption {
    readonly value: HandoffMode;
    readonly label: string;
    readonly icon: IconName;
    readonly title: Tip;
    readonly mark?: IconName;
    readonly markTitle?: string;
}

// The pills, in one order whatever is suggested (a control whose options move is misread), only the ways this turn can
// take; the suggested one carries a mark, so the suggestion stays visible after the person picks another.
export const handoffOptions = (offer: HandoffOffer): readonly HandoffOption[] =>
    HANDOFF_MODES.filter((mode) => offer[mode] !== undefined).map((mode) => ({
        value: mode,
        label: handoffLabel(mode),
        icon: ICONS[mode],
        title: { title: handoffLabel(mode), note: `${brief(mode)}. ${handoffWhat(offer, mode)}` },
        ...(mode === offer.suggested ? { mark: `sparkles` as IconName, markTitle: offer.basis === `setting` ? t(`chat.handoffChoice.yourDefault`) : t(`chat.handoffChoice.suggested`) } : {}),
    }));
