import type { ExtensionContext, IntenticApi } from "@intentic/extension-api";
import { startBadge, unseenCount } from "./badge";
import { bindHost } from "./host";

// intentic.example: one contribution of every kind the extension API offers, each in minimal code.
// views a rail tile at /ext/example, badged from module state
// files `.intentic/example-notes.json` → the `example-notes` query key: writes push, not poll
// settings `limit`, stored daemon-side and shared across the owner's browsers
// commands `example.reload`, in the command palette
// bin `intentic-example`, on the agent's PATH every turn
// agent the `example-notes` skill, so the agent knows the CLI exists and when to use it
// Every one is declared in intentic-extension.json; the host refuses undeclared registrations and api.sandbox throws
// outside permissions.sandbox, so this file can't grow reach the install dialog didn't show.
export const activate = (api: IntenticApi, context: ExtensionContext): void => {
    bindHost(api);
    context.subscriptions.push(
        startBadge(),
        api.views.register({
            id: `example`,
            label: `Example`,
            surface: `rail`,
            // Unconditional: the note file belongs to the workspace, not a repo, so nothing per-repo to filter on.
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
