import type { Disposable, SideViewInput, SideViewRegistration } from "@intentic/extension-api";
import type { SideViewContribution } from "@intentic/extension-manifest";
import type { IconName } from "@intentic/ui";
import { defineComponent, h, type PropType } from "vue";
import { registerSideView, type SideViewEntry } from "../workbench/side/sideViews";
import ExtensionSideView from "./ExtensionSideView.vue";
import { registeredViews } from "../workbench/views/registry";

// An extension's side view, as the side panel draws every side view: the manifest's entry decides its family name and
// whether it may take links, the registration answers the rest. The id is the extension's, then the view's, so two
// extensions' `run` views never share a tab.

export const extensionSideViewId = (extensionId: string, id: string): string => `${extensionId}/${id}`;

// What "Open in …" calls a home path: the rail section it lands in (`/ext/pipelines?repo=web` is Pipelines), else the
// side view's own family name.
const sectionAt = (path: string): string | undefined => {
    const view = /^\/ext\/([^/?#]+)/u.exec(path)?.[1];
    return view === undefined ? undefined : registeredViews().find(({ registration }) => registration.id === view)?.registration.label;
};

// The tab's words, read off the registration: an extension names its glyph as an open string.
const describeWith =
    (registration: SideViewRegistration): SideViewEntry[`describe`] =>
    (input) => {
        const said = registration.describe(input);
        // SAFETY: an extension's glyph is an open string, and the Icon component draws its fallback for a name its set
        // lacks, as it does for a document provider's.
        const icon = (said.icon ?? `extensions`) as IconName;
        return { title: said.title, icon, tip: { title: said.title, note: said.tooltip } };
    };

// `go` takes the reader to an app path: the host's own navigation, handed in so this registry needs no route table.
export const registerExtensionSideView = (
    extensionId: string,
    declared: SideViewContribution,
    registration: SideViewRegistration,
    go: (path: string) => void,
): Disposable => {
    // The tab's body: the extension's component with the input bound, inside its error boundary.
    const body = defineComponent({
        // SAFETY: Vue types an object prop through PropType; the side panel binds the tab's stored input, plain values.
        props: { input: { type: Object as PropType<SideViewInput>, required: true } },
        setup: (props) => () => h(ExtensionSideView, { extensionId, view: registration.view, input: props.input }),
    });
    const { home, claim } = registration;
    return registerSideView({
        id: extensionSideViewId(extensionId, registration.id),
        owner: extensionId,
        label: declared.label,
        describe: describeWith(registration),
        home:
            home === undefined
                ? undefined
                : (input) => {
                      const path = home(input);
                      return path === undefined ? undefined : { label: sectionAt(path) ?? declared.label, open: () => go(path) };
                  },
        // Taken only where the manifest says it may, since a claim changes what the reader's click does.
        claim: declared.links === true ? claim : undefined,
        component: async () => body,
    });
};
