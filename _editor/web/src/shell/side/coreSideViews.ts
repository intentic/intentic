import type { Disposable } from "@intentic/extension-api";
import { isLockedWorkspacePath } from "@intentic/sandbox-contract/state/workspace-state";
import type { PortSummary } from "@intentic/sandbox-contract/schemas/ports";
import { explorerColorClass, iconForEntry, type IconName, useExplorerStyle } from "@intentic/ui";
import { basename } from "@intentic/ui/path";
import { t } from "@intentic/ui/i18n";
import { useVocabulary } from "../../workbench/views/vocabulary";
import { useAgents } from "../../models/fleet/useAgents";
import { loopbackPreviewTarget } from "../../models/preview/previewModel";
import {
    BROWSERS_SIDE_VIEW,
    browsersFront,
    browsersSideInput,
    browsersTabNames,
    browsersTabOfInput,
    markBrowsersOpened,
    openBrowsers,
    showTab,
} from "../../workbench/browsers/browsersSurface";
import { browsersPath, tabKey, type LiveTab } from "../../workbench/browsers/browsersPaths";
import { openInWorkspace } from "../../models/workspace/files/openFileRef";
import { rpcKey } from "../../lib/queryKeys";
import { queryClient } from "../../lib/queryPersistence";
import { navigation } from "../../workbench/navigation/navigation";
import { handOffToMainWindow } from "../../workbench/window/mainWindow";
import { browsersSlot } from "../../workbench/window/panelSlots";
import { FILE_SIDE_VIEW, FileSideInputSchema } from "../../workbench/side/sideFileInput";
import { registerSideView } from "../../workbench/side/sideViews";

// What a side tab calls its tab of the view before the view has named it (browsersTabNames): the app, server or window
// read off the key itself. `app:shop/web` is `web`, `repo:shop` is `shop`, `port:5173` is `:5173`.
const targetName = (id: string): string => {
    const at = id.indexOf(`:`);
    const kind = id.slice(0, at);
    const rest = id.slice(at + 1);
    if (kind === `app`) {
        return rest.slice(rest.lastIndexOf(`/`) + 1);
    }
    if (kind === `repo`) {
        return rest;
    }
    return kind === `port` ? `:${rest}` : id;
};

// The ports the shell already holds (usePorts, at the rail), read at the click rather than fetched for it.
const heldPorts = (): readonly PortSummary[] =>
    queryClient.getQueryData<{ readonly ports: readonly PortSummary[] }>(rpcKey(`ports.list`))?.ports ?? [];

const fallbackName = (tab: LiveTab): string => {
    switch (tab.kind) {
        case `preview`:
            return targetName(tab.id);
        case `desktop`:
            return t(`shared.desktop`);
        case `app`:
            return t(`browsers.kind.window`);
        case `web`:
            return t(`shared.browsers`);
    }
};

// The glyph a tab of the view wears, as on the view's own strip: what kind of thing it is.
const ICONS = { preview: `eye`, web: `globe`, desktop: `screen`, app: `window-maximize` } as const satisfies Record<LiveTab[`kind`], IconName>;

// The side views the core draws itself, registered by each window with a side panel (the desktop shell, a popped-out
// chat). Each names its home, the section its thing belongs to, so a peek can be moved there whole.

export const registerCoreSideViews = (): readonly Disposable[] => {
    const words = useVocabulary();
    const { explorerStyle } = useExplorerStyle();
    const { agentById } = useAgents();

    const file = registerSideView({
        id: FILE_SIDE_VIEW,
        owner: `builtin`,
        get label() {
            return words.value.workspace;
        },
        // A file tab reads like the Workspace's own: its name, the glyph and colour its type has in the tree, and on hover the
        // whole path and whose copy it is.
        describe: (input) => {
            const parsed = FileSideInputSchema.safeParse(input).data;
            const path = parsed?.path ?? ``;
            const name = basename(path);
            const agent = parsed?.agent;
            return {
                title: name,
                // A reference nothing matched has no file to wear the glyph of.
                icon: parsed?.missing === true ? `link-broken` : isLockedWorkspacePath(path) ? `lock` : iconForEntry(name, `file`),
                iconClass: explorerColorClass(explorerStyle.value, name, `file`, false),
                tip: {
                    title: path,
                    rows: agent === undefined ? undefined : [{ label: words.value.Agent, value: agentById(agent)?.title ?? agent }],
                },
            };
        },
        home: (input) => {
            const parsed = FileSideInputSchema.safeParse(input).data;
            // Nothing to move there: a reference that matched no file has no home but this card.
            return parsed === undefined || parsed.missing === true
                ? undefined
                : { label: words.value.workspace, open: () => void openInWorkspace(parsed.path, undefined, { agent: parsed.agent }) };
        },
        component: async () => (await import(`./SideFile.vue`)).default,
    });

    // One side tab per tab of the view (an app, the desktop, a web window), so beside the section the panel's strip is the
    // only strip; the one view a window draws is shared between them and shows the tab on screen.
    const browsers = registerSideView({
        id: BROWSERS_SIDE_VIEW,
        owner: `builtin`,
        get label() {
            return t(`shared.browsers`);
        },
        describe: (input) => {
            const tab = browsersTabOfInput(input);
            const named = browsersTabNames.value.get(tabKey(tab));
            const title = named?.title ?? fallbackName(tab);
            return {
                title,
                icon: ICONS[tab.kind],
                tip: named?.note === undefined ? undefined : { title, note: named.note },
            };
        },
        // The tab, in the full view; from a popped-out chat, in the app's own window.
        home: (input) => ({
            label: t(`shared.browsers`),
            open: () => {
                const tab = browsersTabOfInput(input);
                if (!handOffToMainWindow({ kind: `route`, path: browsersPath(tab) })) {
                    openBrowsers(navigation(), tab);
                }
            },
        }),
        claim: (url) => {
            const target = loopbackPreviewTarget(url, heldPorts());
            return target === undefined ? undefined : browsersSideInput({ kind: `preview`, id: target });
        },
        // Opened on no tab in particular, it stands for the one in front.
        kept: true,
        opening: (input) => {
            markBrowsersOpened();
            const tab = input[`tab`] === undefined ? browsersFront.value : browsersTabOfInput(input);
            showTab(tab);
            return browsersSideInput(tab);
        },
        shared: true,
        component: async () => (await import(`./SideBrowsers.vue`)).default,
        // Standing on /browsers, the section draws the one view; its side tabs step aside until the reader leaves.
        lent: () => browsersSlot.value !== null,
    });

    return [file, browsers];
};
