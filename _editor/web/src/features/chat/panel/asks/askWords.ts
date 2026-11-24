import type { useT } from "@intentic/ui/i18n";
import type { PendingAsk, WaitKind } from "../../../../models/conversations/panel/pendingAsks";

type T = ReturnType<typeof useT>;

// The kind of an ask in one word, the board's own pill words, for an ask whose data names nothing shorter.
export const kindWord = (kind: WaitKind, t: T): string => t(`chat.askDock.kind.${kind}`);

/** The few words an ask's line or its stub says for it: its own label, else what kind of ask it is. */
export const askLabel = (ask: PendingAsk, t: T): string => {
    if (ask.label !== ``) {
        return ask.label;
    }
    return kindWord(ask.source === `need` ? `other` : ask.kind, t);
};

/** The word for what an ask is, before its own few words on its line; none where those words already are that word. */
export const askKind = (ask: PendingAsk, t: T): string | undefined => {
    if (ask.label === ``) {
        return undefined;
    }
    if (ask.source === `card` && ask.field === `pageAsk`) {
        return t(`chat.askDock.kind.page`);
    }
    return kindWord(ask.source === `need` ? `other` : ask.kind, t);
};
