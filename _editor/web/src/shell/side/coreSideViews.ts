import type { Disposable } from "@intentic/extension-api";
import { isLockedWorkspacePath, type PortSummary } from "@intentic/sandbox-contract";
import { explorerColorClass, iconForEntry, useExplorerStyle } from "@intentic/ui";
import { basename } from "@intentic/ui/path";
import { z } from "zod";
import { useVocabulary } from "../../core-views/vocabulary";
import { useAgents } from "../../features/agents/fleet/useAgents";
import { loopbackPreviewTarget } from "../../features/preview/previewModel";
import { markPreviewOpened, openPreview, PREVIEW_SIDE_VIEW, previewSelectedId, selectPreviewTarget } from "../../features/preview/previewSurface";
import { openInWorkspace } from "../../features/workspace/files/refs/openFileRef";
import { PORTS } from "../../lib/queryKeys";
import { queryClient } from "../../lib/queryPersistence";
import { router } from "../../router";
import { handOffToMainWindow } from "../window/mainWindow";
import { previewSlot } from "../window/panelSlots";
import { FILE_SIDE_VIEW, FileSideInputSchema } from "./sideFileInput";
import { registerSideView } from "./sideViews";

// What the preview's tab names it by: the app, server or page it shows, read off the target's id, since the live target
// list is the panel's to fetch. `app:shop/web` is `web`, `repo:shop` is `shop`, `port:5173` is `:5173`.
const targetName = (id: string | undefined): string | undefined => {
    if (id === undefined) {
        return undefined;
    }
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

// What a claimed link hands the preview: the target it names, which the one tab then shows.
const PreviewInputSchema = z.object({ target: z.string().min(1).optional() });

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

    // One tab, since a window draws one preview panel: its own picker says which app it shows.
    const preview = registerSideView({
        id: PREVIEW_SIDE_VIEW,
        owner: `builtin`,
        get label() {
            return words.value.preview;
        },
        describe: () => {
            const name = targetName(previewSelectedId.value);
            return { title: name === undefined ? words.value.preview : `${words.value.preview} · ${name}`, icon: `eye`, tip: { title: words.value.preview, note: name } };
        },
        // From a popped-out chat, the app's own window goes to its Preview; this one has no section to go to.
        home: () => ({
            label: words.value.preview,
            open: () => {
                if (!handOffToMainWindow({ kind: `route`, path: `/preview` })) {
                    openPreview(router);
                }
            },
        }),
        claim: (url) => {
            const target = loopbackPreviewTarget(url, heldPorts());
            return target === undefined ? undefined : { target };
        },
        // Selects the target a claimed link named, and keeps the one tab a window's one preview panel has.
        kept: true,
        opening: (input) => {
            const target = PreviewInputSchema.safeParse(input).data?.target;
            if (target !== undefined) {
                selectPreviewTarget(target);
            }
            markPreviewOpened();
            return {};
        },
        component: async () => (await import(`./SidePreview.vue`)).default,
        // Standing on /preview, the section draws the one preview panel; the tab steps aside until the reader leaves.
        lent: () => previewSlot.value !== null,
    });

    return [file, preview];
};
