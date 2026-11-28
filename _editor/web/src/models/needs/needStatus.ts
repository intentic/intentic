import type { IconName } from "@intentic/ui";
import type { Need, NeedKind } from "@intentic/sandbox-contract/schemas/needs";
import { t } from "@intentic/ui/i18n";
import type { CardStatus } from "../../components/ChatCard.vue";

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
    // A standing rule for AGENTS.md, the workspace's book of instructions.
    instruction: `book`,
    // A computer that would sleep through booked work: the glyph the Devices page gives a sleeping machine.
    "host-power": `moon`,
    // A PC whose WSL VM is too big for it: the glyph of memory.
    "wsl-memory": `memory`,
    // A project claimed so the owner's other sandboxes report its problems here: the Settings ▸ Projects row's glyph.
    claim: `folder`,
    // A person's leave for this sandbox to act as them in another: the glyph linked sandboxes wear.
    route: `link`,
    // A person's message sent on to the sandbox it was meant for.
    redirect: `send`,
    // A managed stack let receive its secrets: the rail's own Deployments glyph.
    deploy: `deployments`,
    // Another sandbox added or accepted as a contact (docs/architecture/messages.md).
    contact: `users`,
};

// The header chip of a need that is no longer waiting; undefined while it is, since the card's own buttons say that.
// A redirect's yes and no are where the message went, not a thing done or turned down.
export const needStatus = (need: Pick<Need, "status" | "subject">): CardStatus | undefined => {
    const redirect = need.subject.kind === `redirect`;
    switch (need.status) {
        case `met`:
            return { label: redirect ? t(`needs.status.sent`) : t(`needs.status.met`), tone: `done` };
        case `declined`:
            return { label: redirect ? t(`needs.status.keptHere`) : t(`needs.status.declined`), tone: `gone` };
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
    if (need.subject.kind === `host-power`) {
        return t(`needs.hostPower.working`, { device: need.subject.device });
    }
    if (need.subject.kind === `wsl-memory`) {
        return t(`needs.wslMemory.working`, { device: need.subject.device });
    }
    return need.subject.kind === `environment` ? t(`needs.card.approvedRebuild`) : t(`needs.card.settingUp`);
};

// Said on a closed card only when the agent has not heard the outcome yet. Hearing it, on the call or in a turn, is what
// a closed card means, so it goes unsaid. A power card's answer is the person's alone: its conversation is never woken
// to hear it (a woken turn would run the booked work early), so there is nobody left to tell; nor is a WSL memory card's,
// which is about the PC, not the conversation's work.
export const unheardLine = (need: Pick<Need, "status" | "told" | "subject">): string | undefined => {
    if ((need.status !== `met` && need.status !== `declined`) || need.subject.kind === `host-power` || need.subject.kind === `wsl-memory`) {
        return undefined;
    }
    switch (need.told) {
        case `call`:
        case `turn`:
            return undefined;
        case `queued`:
            return t(`needs.card.toldQueued`);
        case undefined:
            return need.status === `met` ? t(`needs.card.toldNot`) : undefined;
    }
};

// The person's own words back to the agent on a decline. The daemon stores them after a lead-in written for the agent
// ("They said: …", needs.ts); the card quotes them under the face of who said them, so the lead-in goes.
const SAID = /^They said: /u;
export const declineNote = (need: Pick<Need, "status" | "outcome">): string | undefined =>
    need.status === `declined` && need.outcome !== undefined && SAID.test(need.outcome) ? need.outcome.replace(SAID, ``) : undefined;
