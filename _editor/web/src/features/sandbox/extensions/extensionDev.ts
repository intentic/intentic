import type { ExtensionSummary } from "@intentic/sandbox-contract/schemas/extension-updates";
import { t } from "@intentic/ui/i18n";

// An install running from a source checkout instead of its pinned copy (dev mode), or pointed at one that is held, as
// one sentence. The Installed row says it while closed and the extension's page leads with it, because what runs is not
// what the commit on the page names, and that is the first thing to know about it.
export const devLineOf = (extension: ExtensionSummary): string | undefined => {
    const current = extension.dev;
    if (current === undefined) {
        return undefined;
    }
    const where =
        current.conversation === undefined
            ? current.path
            : t(`sandbox.extensionRow.devInConversation`, { path: current.path, conversation: current.conversation });
    if (current.held !== undefined) {
        return t(`sandbox.extensionRow.devHeld`, { where, reason: current.held });
    }
    const running = t(`sandbox.extensionRow.devRunningFrom`, { where });
    const count = current.uncommitted ?? 0;
    return count === 0 ? running : `${running} · ${t(`sandbox.extensionRow.devUncommitted`, { count }, count)}`;
};
