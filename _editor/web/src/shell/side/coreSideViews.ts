import type { Disposable } from "@intentic/extension-api";
import { isLockedWorkspacePath, type PortSummary } from "@intentic/sandbox-contract";
import { explorerColorClass, iconForEntry, useExplorerStyle } from "@intentic/ui";
import { basename } from "@intentic/ui/path";
import { z } from "zod";
import { t } from "@intentic/ui/i18n";
import { useVocabulary } from "../../workbench/views/vocabulary";
import { useAgents } from "../../features/agents/fleet/useAgents";
import { loopbackPreviewTarget } from "../../features/preview/previewModel";
import { BROWSERS_SIDE_VIEW, browsersFront, markBrowsersOpened, openBrowsers, showTab } from "../../workbench/browsers/browsersSurface";
import { browsersPath, parseTabKey, tabKey, type LiveTab } from "../../workbench/browsers/browsersPaths";
import { openInWorkspace } from "../../features/workspace/files/refs/openFileRef";
import { PORTS } from "../../lib/queryKeys";
import { queryClient } from "../../lib/queryPersistence";
import { router } from "../../router";
import { handOffToMainWindow } from "../../workbench/window/mainWindow";
import { browsersSlot } from "../../workbench/window/panelSlots";
import { FILE_SIDE_VIEW, FileSideInputSchema } from "../../workbench/side/sideFileInput";
import { registerSideView } from "../../workbench/side/sideViews";

// What the side tab names the view by: the app, server or page in front, read off the tab itself, since the live lists
// are the view's to fetch. `app:shop/web` is `web`, `repo:shop` is `shop`, `port:5173` is `:5173`; a web window or a
// window on the desktop says nothing more than the view's own name.
const targetName = (id: string): string | undefined => {
    const at = id.indexOf(`:`);
    const kind = id.slice(0, at);
    const rest = id.slice(at + 1);
    if (kind === `app`) {
        return rest.slice(rest.lastIndexOf(`/`) + 1);
    }
    if (kind === `repo`) {
        return rest;
    }
    return kind === `port` ? `:${rest}` : undefined;
};

// The ports the shell already holds (usePorts, at the rail), read at the click rather than fetched for it.
const heldPorts = (): readonly PortSummary[] => queryClient.getQueryData<{ readonly ports: readonly PortSummary[] }>(PORTS.of())?.ports ?? [];

const frontName = (tab: LiveTab): string | undefined =>
    tab.kind === `preview` ? targetName(tab.id) : tab.kind === `desktop` ? t(`shared.desktop`) : undefined;

// What a claimed link hands the view: the tab it names (a live app's, by its key), which the one side tab then shows.
const BrowsersInputSchema = z.object({ tab: z.string().min(1).optional() });

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
                icon: isLockedWorkspacePath(path) ? `lock` : iconForEntry(name, `file`),
                iconClass: explorerColorClass(explorerStyle.value, name, `file`, false),
                tip: {
                    title: path,
                    rows: agent === undefined ? undefined : [{ label: words.value.Agent, value: agentById(agent)?.title ?? agent }],
                },
            };
        },
        home: (input) => {
            const parsed = FileSideInputSchema.safeParse(input).data;
            return parsed === undefined
                ? undefined
                : { label: words.value.workspace, open: () => void openInWorkspace(parsed.path, undefined, { agent: parsed.agent }) };
        },
        component: async () => (await import(`./SideFile.vue`)).default,
    });

    // One tab, since a window draws one Browsers view: its own strip says what is in front.
    const browsers = registerSideView({
        id: BROWSERS_SIDE_VIEW,
        owner: `builtin`,
        get label() {
            return t(`shared.browsers`);
        },
        describe: () => {
            const label = t(`shared.browsers`);
            const front = browsersFront.value;
            const name = frontName(front);
            return {
                title: name === undefined ? label : `${label} · ${name}`,
                icon: front.kind === `preview` ? `eye` : front.kind === `web` ? `browsers` : `screen`,
                tip: { title: label, note: name },
            };
        },
        // From a popped-out chat, the app's own window goes to its Browsers; this one has no section to go to.
        home: () => ({
            label: t(`shared.browsers`),
            open: () => {
                if (!handOffToMainWindow({ kind: `route`, path: browsersPath(browsersFront.value) })) {
                    openBrowsers(router);
                }
            },
        }),
        claim: (url) => {
            const target = loopbackPreviewTarget(url, heldPorts());
            return target === undefined ? undefined : { tab: tabKey({ kind: `preview`, id: target }) };
        },
        // Brings the tab a claimed link named to front, and keeps the one side tab a window's one view has.
        kept: true,
        opening: (input) => {
            const key = BrowsersInputSchema.safeParse(input).data?.tab;
            if (key !== undefined) {
                showTab(parseTabKey(key));
            }
            markBrowsersOpened();
            return {};
        },
        component: async () => (await import(`./SideBrowsers.vue`)).default,
        // Standing on /browsers, the section draws the one view; the side tab steps aside until the reader leaves.
        lent: () => browsersSlot.value !== null,
    });

    return [file, browsers];
};
