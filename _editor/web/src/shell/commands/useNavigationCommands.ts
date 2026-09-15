import type { Disposable } from "@intentic/extension-api";
import { computed, onMounted, onUnmounted, watch, type WatchStopHandle } from "vue";
import { useRouter } from "vue-router";
import { detectActivations, extensionPath } from "../../core-views/registry";
import { useVocabulary } from "../../core-views/vocabulary";
import { useCapabilities } from "../../features/capabilities/connect/useCapabilities";
import { usePanels } from "../../features/extensions/usePanels";
import { openPreview } from "../../features/preview/previewSurface";
import { SANDBOX_BUILT_IN_SLUGS, sandboxSectionPath, sandboxSections } from "../../features/sandbox/sandboxNav";
import { useRole } from "../../features/sandbox/secrets/useRole";
import { useHostedPlan } from "../../features/settings/hosted-plan/useHostedPlan";
import { settingsSectionPath, settingsSections } from "../../features/settings/settingsNav";
import { GO_TO, SANDBOX, SETTINGS } from "./categories";
import { registerCommand } from "./useCommands";

// Every place the shell can take you, as a command. Derived from the same tables the rail and the two hubs draw
// themselves from, never a second list, so a section or an extension area is reachable by name the moment it is
// reachable by click. Gated exactly as those surfaces gate their rows: a destination this reader's grant or plan
// hides is not offered, since the hub would only bounce them back off it.

interface NavCommand {
    readonly command: string;
    readonly title: string;
    readonly category: string;
    readonly icon?: string | undefined;
    /** Where it goes. */
    readonly to: string;
    /** How it goes, for the one destination that has to be opened rather than navigated to. */
    readonly run?: () => void;
}

export function useNavigationCommands(): void {
    const router = useRouter();
    const { panels } = usePanels();
    const { capabilities } = useCapabilities();
    // Maintainer-and-up rows: the sandbox hub hides the rest, and the daemon refuses them anyway.
    const { canShip } = useRole();
    const { offered: planOffered } = useHostedPlan();
    const words = useVocabulary();

    // The rail's own seats, which are shell routes rather than registered views, so no detect() reports them. Named as
    // the rail names them, including the two the maker's vocabulary renames.
    const shellAreas = computed<readonly NavCommand[]>(() => [
        { command: `view.chat`, title: `Chat`, category: GO_TO, icon: `comments`, to: `/chat` },
        { command: `view.agents`, title: `Agents`, category: GO_TO, icon: `robot`, to: `/agents` },
        { command: `view.workspace`, title: words.value.workspace, category: GO_TO, icon: `file-tree`, to: `/workspace` },
        // Marks the preview as opened on the way, which a bare push would not.
        { command: `view.preview`, title: words.value.preview, category: GO_TO, icon: `eye`, to: `/preview`, run: () => openPreview(router) },
        // Both tiles leave the rail when nothing is running; the palette is how you get back to a finished session.
        { command: `view.browsers`, title: `Browsers`, category: GO_TO, icon: `desktop`, to: `/browsers` },
        { command: `view.subagents`, title: `Subagents`, category: GO_TO, icon: `users`, to: `/subagents` },
        { command: `view.capabilities`, title: `Capabilities`, category: GO_TO, icon: `plus`, to: `/capabilities` },
    ]);

    // One command per rail-surface activation (not per view); the id carries the activation key unless it is a
    // singleton (`view.<id>`), so an extension with several tiles gets several rows.
    const extensionAreas = computed<readonly NavCommand[]>(() =>
        detectActivations(panels.value, capabilities.value)
            .filter(({ extension }) => extension.surface === `rail`)
            .map(({ extension, activation }) => ({
                command: activation.key === extension.id ? `view.${extension.id}` : `view.${extension.id}.${activation.key}`,
                title: activation.title,
                category: GO_TO,
                icon: activation.icon,
                to: extensionPath(extension, activation),
            })),
    );

    // The sandbox hub's sections, plus the ones extensions add to it — the same filter the hub applies, so a key that
    // collides with a built-in section is dropped here too rather than registering a row that opens something else.
    const sandboxDestinations = computed<readonly NavCommand[]>(() => [
        ...sandboxSections(canShip.value).map((section) => ({
            command: `view.sandbox.${section.slug}`,
            title: section.label,
            category: SANDBOX,
            icon: section.icon,
            to: sandboxSectionPath(section.slug),
        })),
        ...detectActivations(panels.value, capabilities.value)
            .filter(({ extension, activation }) => extension.surface === `sandbox` && !SANDBOX_BUILT_IN_SLUGS.has(activation.key))
            .map(({ activation }) => ({
                command: `view.sandbox.${activation.key}`,
                title: activation.title,
                category: SANDBOX,
                icon: activation.icon,
                to: sandboxSectionPath(activation.key),
            })),
        // The one sandbox errand that is a place rather than a section: where the switcher's "Add sandbox" goes.
        { command: `sandbox.add`, title: `Add…`, category: SANDBOX, icon: `plus`, to: `/setup` },
    ]);

    const settingsDestinations = computed<readonly NavCommand[]>(() =>
        settingsSections(planOffered.value).map((section) => ({
            command: `view.settings.${section.slug}`,
            title: section.label,
            category: SETTINGS,
            icon: section.icon,
            to: settingsSectionPath(section.slug),
        })),
    );

    const destinations = computed<readonly NavCommand[]>(() => [
        ...shellAreas.value,
        ...extensionAreas.value,
        ...sandboxDestinations.value,
        ...settingsDestinations.value,
    ]);

    let disposables: readonly Disposable[] = [];
    const release = (): void => {
        for (const disposable of disposables) {
            disposable.dispose();
        }
        disposables = [];
    };

    const sync = (list: readonly NavCommand[]): void => {
        // Release before re-registering, so a hot-reloaded view isn't refused as duplicate of its own previous command.
        release();
        disposables = list.flatMap((destination) => {
            try {
                return [
                    registerCommand({
                        owner: `builtin`,
                        command: destination.command,
                        title: destination.title,
                        category: destination.category,
                        ...(destination.icon === undefined ? {} : { icon: destination.icon }),
                        handler: destination.run ?? ((): void => void router.push(destination.to)),
                    }),
                ];
            } catch (error) {
                // A colliding third-party id: the tile still works, but the palette row is lost, not every other
                // destination's command.
                console.error(`command ${destination.command}: already registered`, error);
                return [];
            }
        });
    };

    // Registered from onMounted, not setup, since WorkspaceShell may discard an instance before it ever mounts.
    let stop: WatchStopHandle | undefined;

    onMounted(() => {
        stop = watch(destinations, sync, { immediate: true });
    });

    onUnmounted(() => {
        stop?.();
        stop = undefined;
        release();
    });
}
