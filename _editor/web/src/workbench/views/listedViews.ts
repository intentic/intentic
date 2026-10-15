import { computed } from "vue";
import type { RouteLocationRaw } from "vue-router";
import { extensionsLoaded, extensionStatuses } from "./extensionStatuses";
import { viewRegistered } from "./registry";

// Core surfaces that link to a view a LISTED first-party extension contributes (installed from the registry, not
// compiled in), and so have to know whether that view is here before sending anyone to it. Read off the view registry
// and the extension host's load record, both of which the host writes, so a feature asks without importing the host.

interface ListedView {
    // The view's id: its /ext/<id> route and its rail tile.
    readonly view: string;
    // The extension's identity (publisher.name), which is also its registry listing's name.
    readonly listing: string;
}

export const WORKFLOWS: ListedView = { view: `workflows`, listing: `intentic.workflows` };

// Known missing, not merely not loaded yet: until the loader's pass finishes, an unregistered view may still activate,
// and a surface that offered the install in that second would be wrong for everyone who has it.
export const listedViewMissing = (view: string): boolean => extensionsLoaded.value && !viewRegistered(view);

// A listing's own panel in Extensions → Browse, where its Install button is.
const browseListing = (listing: string): RouteLocationRaw => ({ path: `/sandbox/extensions`, query: { view: `browse`, ext: listing } });

// Whether the view is here, its extension is installed and switched off, or it is not installed at all, and where to
// send someone for the last two: the switch on the Installed tab, or the listing to install it from.
export const useListedView = (target: ListedView) => {
    const state = computed<`here` | `off` | `absent`>(() => {
        if (!listedViewMissing(target.view)) {
            return `here`;
        }
        return extensionStatuses.value.some((status) => status.state === `disabled` && status.extensionId === target.listing) ? `off` : `absent`;
    });
    const setUp = computed<RouteLocationRaw>(() =>
        state.value === `off` ? { path: `/sandbox/extensions`, query: { view: `installed` } } : browseListing(target.listing),
    );
    return { state, setUp };
};
