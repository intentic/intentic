import type { AccessProfile } from "@intentic/sandbox-contract/schemas/access-profiles";
import { roleBounds } from "@intentic/sandbox-contract/schemas/roles";
import { t } from "@intentic/ui/i18n";

// The access profiles that hold a card: those whose `roles` list it. A card's limits live there, never on the card.
export const profilesHolding = <P extends Pick<AccessProfile, "roles">>(profiles: readonly P[], roleId: string): P[] =>
    profiles.filter((profile) => profile.roles?.includes(roleId) === true);

// The contract's one phrase for how bounded a card is ("Full powers", "Read-only", "No shell", "3 limits"), read off the
// access profiles holding it and shared by every surface that badges a role, said in the reader's language. Read off
// the contract's own answer, so the rule for which phrase a card earns stays there; a phrase this does not know keeps its
// English.
export const roleBoundsWords = (held: Parameters<typeof roleBounds>[0]): string => {
    const english = roleBounds(held);
    if (english === `Full powers`) {
        return t(`sandbox.roleBounds.fullPowers`);
    }
    if (english === `Read-only`) {
        return t(`sandbox.roleBounds.readOnly`);
    }
    if (english === `No shell`) {
        return t(`sandbox.roleBounds.noShell`);
    }
    const limits = /^(\d+) limits?$/.exec(english)?.[1];
    if (limits === undefined) {
        return english;
    }
    const count = Number(limits);
    return t(`sandbox.roleBounds.limits`, { count }, count);
};
