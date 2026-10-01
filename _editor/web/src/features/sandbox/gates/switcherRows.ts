import { t } from "@intentic/ui/i18n";

// What a removal takes with it is about words rather than wiring. Pure, so it is pinned by a test instead of by
// reading a template.

// WHAT LEAVES WITH A REMOVED SANDBOX. Everything the reader set up lives inside the sandbox, not on the account, so a
// removal takes it along; the dialog used to say only that the box keeps running. A member leaving takes nothing.
export const removalTakes = (role: string): readonly string[] =>
    role === `owner`
        ? [t(`sandbox.sandboxSwitcher.takesAccounts`), t(`sandbox.sandboxSwitcher.takesSettings`), t(`sandbox.sandboxSwitcher.takesChats`)]
        : [];
