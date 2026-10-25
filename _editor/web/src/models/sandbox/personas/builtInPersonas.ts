import type { IconName } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import {
    type BuiltInPersonaId,
    defaultPersona,
    FULL_ACCESS_PERSONA,
    isBuiltInPersona,
    NO_ACCOUNTS_PERSONA,
    type Persona,
} from "@intentic/sandbox-contract/schemas/personas";

// THE TWO BUILT-IN PERSONAS as the editor says them (schemas/personas.ts holds the ids and the rule). Every turn wears
// somebody: a card, or one of these, so a screen naming who a chat or a run acts as always has a name to show. A
// composer that picks no card sends no `actsAs`, which a watched turn wears as Full access.

export interface BuiltInPersonaView {
    readonly id: BuiltInPersonaId;
    readonly label: string;
    // What it reaches, in one line.
    readonly note: string;
    // When it is worn without being picked.
    readonly when: string;
    readonly icon: IconName;
}

export const builtInPersonaView = (id: BuiltInPersonaId): BuiltInPersonaView =>
    id === FULL_ACCESS_PERSONA
        ? {
              id,
              label: t(`sandbox.builtInPersonas.fullAccess`),
              note: t(`sandbox.builtInPersonas.fullAccessNote`),
              when: t(`sandbox.builtInPersonas.fullAccessWhen`),
              icon: `users`,
          }
        : {
              id,
              label: t(`sandbox.builtInPersonas.noAccounts`),
              note: t(`sandbox.builtInPersonas.noAccountsNote`),
              when: t(`sandbox.builtInPersonas.noAccountsWhen`),
              icon: `lock`,
          };

export const builtInPersonaViews = (): readonly BuiltInPersonaView[] => [builtInPersonaView(FULL_ACCESS_PERSONA), builtInPersonaView(NO_ACCOUNTS_PERSONA)];

// The built-in a pick wears: none picked is the watched default, Full access. Undefined for a card's id.
export const builtInOf = (actsAs: string | undefined, unattended = false): BuiltInPersonaId | undefined =>
    actsAs === undefined ? defaultPersona(unattended) : isBuiltInPersona(actsAs) ? actsAs : undefined;

// Who a pick acts as, by name: its card's label, a built-in's, or the raw id of a card that is gone.
export const personaLabel = (actsAs: string | undefined, cards: readonly Persona[], unattended = false): string => {
    const builtIn = builtInOf(actsAs, unattended);
    if (builtIn !== undefined) {
        return builtInPersonaView(builtIn).label;
    }
    const card = cards.find((persona) => persona.id === actsAs);
    return card?.label ?? card?.id ?? actsAs ?? ``;
};
