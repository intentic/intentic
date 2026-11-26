import type { ExtensionContext, IntenticApi } from "@intentic/extension-api";
import { legacyPathOf } from "@intentic/sandbox-contract/app-routes";
import { z } from "zod";
import { bindHost } from "./host";
import { t } from "./i18n.js";

// The install panel, beside whichever section the reader is in: a chat's embed snippet and which sites loaded it. The
// Automations view opens it for a row with `visitor-chat.install <automation id>`, which is how one extension shows
// another's panel; from the palette, with no chat named, it opens the Automations view to pick one in.
export const INSTALL_SIDE_VIEW = `install`;
export const INSTALL_COMMAND = `visitor-chat.install`;

const ChatIdSchema = z.string().min(1);

export const activate = (api: IntenticApi, context: ExtensionContext): void => {
    bindHost(api);
    const automations = api.links.extension(`automations`);
    context.subscriptions.push(
        api.sideViews.register({
            id: INSTALL_SIDE_VIEW,
            describe: (input) => ({ title: t(`installPanel.embedCode`), icon: `globe`, tooltip: String(input[`automation`] ?? ``) }),
            // A side view's `home` is read as a path from before the editor's frames, which legacyPathOf writes.
            home: () => legacyPathOf(automations),
            view: async () => (await import(`./InstallPanel.vue`)).default,
        }),
        api.commands.register(INSTALL_COMMAND, (...args) => {
            const automation = ChatIdSchema.safeParse(args[0]);
            if (!automation.success) {
                api.navigate(automations);
                return;
            }
            api.sideViews.open(INSTALL_SIDE_VIEW, { automation: automation.data }, { keep: true });
        }),
    );
};
