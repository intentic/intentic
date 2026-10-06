import { t } from "@intentic/ui/i18n";

// The families a built-in command can belong to, in one table because the word is part of the command's name
// everywhere it is read ("Terminal: Split"): two registrars spelling the same family differently would split it into
// two on every surface. An extension names its own family in its manifest.

/** Destinations: areas, hub sections, anything that answers "where". */
export const GO_TO = `Go to`;
export const SANDBOX = `Sandbox`;
export const SETTINGS = `Settings`;

/** The surfaces that own actions of their own. */
export const WORKSPACE = `Workspace`;
export const TERMINAL = `Terminal`;
export const CHAT = `Chat`;
export const SIDE_PANEL = `Side Panel`;
export const PREVIEW = `Preview`;
export const AGENTS = `Agents`;
export const ACCOUNT = `Account`;

// The constants above are the families' ids (compared, grouped, ranked on); this is what a reader sees, read in the
// language of the moment. An extension's own family is its manifest's word and passes through.
export const categoryLabel = (category: string): string => {
    switch (category) {
        case GO_TO:
            return t(`shell.commandCategories.goTo`);
        case SANDBOX:
            return t(`shared.sandboxHub`);
        case SETTINGS:
            return t(`shared.settings`);
        case WORKSPACE:
            return t(`shared.workspace`);
        case TERMINAL:
            return t(`shared.terminal`);
        case CHAT:
            return t(`shared.chat`);
        case SIDE_PANEL:
            return t(`shell.commandCategories.sidePanel`);
        case PREVIEW:
            return t(`shared.preview`);
        case AGENTS:
            return t(`shared.agents`);
        case ACCOUNT:
            return t(`shared.account`);
        default:
            return category;
    }
};
