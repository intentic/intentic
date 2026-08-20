import type { ExtensionContext, IntenticApi } from "@intentic/extension-api";
import { startBadge, unseenCount } from "./badge";
import { bindHost } from "./host";

/* intentic.example, one contribution of every kind the extension API offers, in as little code as each one
 * takes, so the whole surface can be read in one sitting:
 *
 *   views     a rail tile at /ext/example, badged from module state
 *   files     `.intentic/example-notes.json` → the `example-notes` query key, so writes push instead of polling
 *   settings  `limit`, stored daemon-side and shared across the owner's browsers
 *   commands  `example.reload`, in the command palette
 *   bin       `intentic-example`, on the agent's PATH every turn
 *   agent     the `example-notes` skill, so the agent knows the CLI exists and when to reach for it
 *
 * Every one of those is DECLARED in intentic-extension.json. The host refuses a registration the approved
 * manifest never named, and `api.sandbox` throws on any route outside `permissions.sandbox`, so this file
 * cannot quietly grow reach that the install dialog didn't show the owner. */
export const activate = (api: IntenticApi, context: ExtensionContext): void => {
    bindHost(api);
    context.subscriptions.push(
        startBadge(),
        api.views.register({
            id: `example`,
            label: `Example`,
            surface: `rail`,
            // Unconditional: the note file is a property of the workspace, not of any repo in it, so there is no
            // per-repo evidence to detect on and one activation is the honest answer. A view that IS about repos
            // filters `repos` here and returns one activation each.
            detect: () => [{ key: `example`, title: `Example`, icon: `sparkles` }],
            badge: () => {
                const count = unseenCount();
                return count > 0 ? { count, tone: `info`, tooltip: `${count} new note${count === 1 ? `` : `s`}` } : undefined;
            },
            view: async () => (await import(`./ExampleView.vue`)).default,
        }),
        api.commands.register(`example.reload`, () => api.navigate(`/ext/example`)),
    );
};
