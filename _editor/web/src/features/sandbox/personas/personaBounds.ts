import { type Persona, personaBounds } from "@intentic/sandbox-contract";
import { t } from "@intentic/ui/i18n";

// The contract's one phrase for how bounded a card is ("Full powers", "Read-only", "No shell", "3 limits"), shared by
// every surface that badges a persona, said in the reader's language. Read off the contract's own answer, so the rule
// for which phrase a card earns stays there; a phrase this does not know keeps its English.
export const personaBoundsWords = (persona: Persona): string => {
    const english = personaBounds(persona);
    if (english === `Full powers`) {
        return t(`sandbox.personaBounds.fullPowers`);
    }
    if (english === `Read-only`) {
        return t(`sandbox.personaBounds.readOnly`);
    }
    if (english === `No shell`) {
        return t(`sandbox.personaBounds.noShell`);
    }
    const limits = /^(\d+) limits?$/.exec(english)?.[1];
    if (limits === undefined) {
        return english;
    }
    const count = Number(limits);
    return t(`sandbox.personaBounds.limits`, { count }, count);
};
