import type { IconName } from "@intentic/ui";
import type { Need, NeedKind } from "@intentic/sandbox-contract";
import { t } from "@intentic/ui/i18n";
import type { CardStatus } from "../chat/transcript/cards/ChatCard.vue";

// How a need reads at a glance, wherever it is drawn: the chat card, the conversation's strip, the inbox. Live state
// comes from the needs store, so the same need reads the same everywhere and changes everywhere at once.

export const NEED_ICONS: Readonly<Record<NeedKind, IconName>> = {
    capability: `bolt`,
    secret: `key`,
    grant: `shield`,
    release: `unlock`,
    environment: `box`,
    // The rail's own Automations glyph, which a held wake in Needs you already wears.
    automation: `automations`,
};

// The header chip of a need that is no longer waiting; undefined while it is, since the card's own buttons say that.
export const needStatus = (need: Pick<Need, "status">): CardStatus | undefined => {
    switch (need.status) {
        case `met`:
            return { label: t(`needs.status.met`), tone: `done` };
        case `declined`:
            return { label: t(`needs.status.declined`), tone: `gone` };
        case `cancelled`:
            return { label: t(`needs.status.withdrawn`), tone: `gone` };
        case `open`:
        case `working`:
            return undefined;
    }
};

// One line for a need that is being carried out (a connection mid-setup, an overlay approved but not built), and for
// one the agent has not heard about yet.
export const workingLine = (need: Pick<Need, "status" | "subject">): string | undefined => {
    if (need.status !== `working`) {
        return undefined;
    }
    return need.subject.kind === `environment` ? t(`needs.card.approvedRebuild`) : t(`needs.card.settingUp`);
};

// How the agent heard the outcome, said for the person reading the closed card.
export const toldLine = (need: Pick<Need, "status" | "told">): string | undefined => {
    if (need.status !== `met` && need.status !== `declined`) {
        return undefined;
    }
    switch (need.told) {
        case `call`:
            return t(`needs.card.toldCall`);
        case `turn`:
            return t(`needs.card.toldTurn`);
        case `queued`:
            return t(`needs.card.toldQueued`);
        case undefined:
            return need.status === `met` ? t(`needs.card.toldNot`) : undefined;
    }
};
