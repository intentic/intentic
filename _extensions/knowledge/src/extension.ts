import type { ExtensionContext, IntenticApi } from "@intentic/extension-api";
import { bindHost } from "./host";

/* ext-knowledge activation: bind the host handle, then register the always-present "Knowledge" view.
 *
 * A SANDBOX SECTION, BESIDE MEMORY, not a rail tile. The rail is a column of unlabelled squares aimed at from
 * muscle memory all day, and a tile earns one of those seats by being somewhere you go constantly or by being
 * able to tell you something happened. A knowledge vault is neither. It is somewhere you go to look something
 * up — deliberately, knowing what you want — and it has nothing to announce: the one thing it could badge is
 * "the agent captured things you have not read", which would be lit most of the day in a working sandbox and
 * would teach the reader to stop seeing the rail. That is the exact failure the badge vocabulary exists to
 * prevent. What it belongs beside is the agent's other body of knowledge, which is where the hub already keeps
 * Memory.
 *
 * It detects unconditionally, like memory: a vault is a folder that either has notes in it or does not, and an
 * empty state that explains how one gets filled is a far better first meeting than an absent tab. */
export const activate = (api: IntenticApi, context: ExtensionContext): void => {
    bindHost(api);
    context.subscriptions.push(
        api.views.register({
            id: `knowledge`,
            label: `Knowledge`,
            surface: `sandbox`,
            detect: () => [{ key: `knowledge`, title: `Knowledge`, icon: `sitemap` }],
            view: async () => (await import(`./KnowledgeView.vue`)).default,
        }),
    );
};
