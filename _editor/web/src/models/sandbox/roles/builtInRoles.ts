import type { IconName } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import {
    type BuiltInRoleId,
    defaultRole,
    FULL_ACCESS_ROLE,
    isBuiltInRole,
    NO_ACCOUNTS_ROLE,
    type Role,
} from "@intentic/sandbox-contract/schemas/roles";

// THE TWO BUILT-IN ROLES as the editor says them (schemas/roles.ts holds the ids and the rule). Every turn wears
// somebody: a card, or one of these, so a screen naming who a chat or a run acts as always has a name to show. A
// composer that picks no card sends no `actsAs`, which a watched turn wears as Full access.

export interface BuiltInRoleView {
    readonly id: BuiltInRoleId;
    readonly label: string;
    // What it reaches, in one line.
    readonly note: string;
    // When it is worn without being picked.
    readonly when: string;
    readonly icon: IconName;
}

export const builtInRoleView = (id: BuiltInRoleId): BuiltInRoleView =>
    id === FULL_ACCESS_ROLE
        ? {
              id,
              label: t(`sandbox.builtInRoles.fullAccess`),
              note: t(`sandbox.builtInRoles.fullAccessNote`),
              when: t(`sandbox.builtInRoles.fullAccessWhen`),
              icon: `users`,
          }
        : {
              id,
              label: t(`sandbox.builtInRoles.noAccounts`),
              note: t(`sandbox.builtInRoles.noAccountsNote`),
              when: t(`sandbox.builtInRoles.noAccountsWhen`),
              icon: `lock`,
          };

export const builtInRoleViews = (): readonly BuiltInRoleView[] => [builtInRoleView(FULL_ACCESS_ROLE), builtInRoleView(NO_ACCOUNTS_ROLE)];

// The built-in a pick wears: none picked is the watched default, Full access. Undefined for a card's id.
export const builtInOf = (actsAs: string | undefined, unattended = false): BuiltInRoleId | undefined =>
    actsAs === undefined ? defaultRole(unattended) : isBuiltInRole(actsAs) ? actsAs : undefined;

// Who a pick acts as, by name: its card's label, a built-in's, or the raw id of a card that is gone.
export const roleLabel = (actsAs: string | undefined, cards: readonly Role[], unattended = false): string => {
    const builtIn = builtInOf(actsAs, unattended);
    if (builtIn !== undefined) {
        return builtInRoleView(builtIn).label;
    }
    const card = cards.find((role) => role.id === actsAs);
    return card?.label ?? card?.id ?? actsAs ?? ``;
};
