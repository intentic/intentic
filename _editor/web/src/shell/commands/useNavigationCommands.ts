import type { Disposable } from "@intentic/extension-api";
import { computed, onMounted, onUnmounted, watch, type WatchStopHandle } from "vue";
import { useRouter } from "vue-router";
import { detectActivations, extensionPath } from "../../workbench/views/registry";
import { useVocabulary } from "../../workbench/views/vocabulary";
import { useCapabilities } from "../../models/capabilities/useCapabilities";
import { usePanels } from "../../models/extensions/usePanels";
import { openBrowsers, openPreview } from "../../workbench/browsers/browsersSurface";
import { browsersPath } from "../../workbench/browsers/browsersPaths";
import { here, page, toHome } from "../../lib/routes/links";
import { sandboxKeyAllowed, sandboxSectionPath, sandboxSections } from "../../models/sandbox/sandboxNav";
import { useHeldDoor } from "../../components/heldPlace";
import { useRole } from "../../client/sandbox/useRole";
import { useAccess } from "../../client/sandbox/access/useAccess";
import { useOrgPolicy } from "../../features/organisations/useOrgPolicy";
import { useHostedPlan } from "../../models/hosted-plan/useHostedPlan";
import { settingsDestinations } from "../../features/settings/settingsNav";
import { GO_TO, SANDBOX, SETTINGS } from "../../workbench/commands/categories";
import { registerCommand } from "../../workbench/commands/useCommands";
import { t } from "@intentic/ui/i18n";
import { useRequestAddSandbox } from "../../models/sandbox/addSandbox";

// Every place the shell can take you, as a command. Derived from the same tables the rail and the two hubs draw
// themselves from, never a second list, so a section or an extension area is reachable by name the moment it is
// reachable by click. Gated exactly as those surfaces gate their rows: a destination this reader's grant or plan
// hides is not offered, since the hub would only bounce them back off it.

interface NavCommand {
    readonly command: string;
    readonly title: string;
    readonly category: string;
    readonly icon?: string | undefined;
    /** Where it goes, in the frame the reader is in (lib/routes/links.ts `here`). */
    readonly to: string;
    /** How it goes, for a destination that has to be opened rather than navigated to. */
    readonly run?: () => void;
}

// A maintainer's page: below that it is no destination (components/heldPlace.ts).
const capabilitiesCommand = (): NavCommand => ({ command: `view.capabilities`, title: t(`shared.capabilities`), category: GO_TO, icon: `plus`, to: here(page.capabilities()) });

// What a palette row shows: a command is registered again only when one of these changes, not on every navigation.
const rowsOf = (list: readonly NavCommand[]): string =>
    list.map(({ command, title, category, icon }) => [command, title, category, icon ?? ``].join(`\t`)).join(`\n`);

// One destination's palette command, or none for a colliding third-party id: the tile still works, but that palette row
// is lost, not every other destination's command.
const registered = (destination: NavCommand, go: () => void): readonly Disposable[] => {
    try {
        return [
            registerCommand({
                owner: `builtin`,
                command: destination.command,
                title: destination.title,
                category: destination.category,
                ...(destination.icon === undefined ? {} : { icon: destination.icon }),
                handler: destination.run ?? go,
            }),
        ];
    } catch (error) {
        console.error(`command ${destination.command}: already registered`, error);
        return [];
    }
};

export function useNavigationCommands(): void {
    const router = useRouter();
    const { panels } = usePanels();
    const { capabilities } = useCapabilities();
    // Maintainer-and-up rows: the sandbox hub hides the rest, and the daemon refuses them anyway. A guest keeps the two
    // tiles its rail has, and a home-only guest neither: its one conversation is the master view's.
    const { canShip, isGuest, homeOnly } = useRole();
    const { offered: planOffered } = useHostedPlan();
    const { hidden: orgHidden } = useOrgPolicy();
    const requestAddSandbox = useRequestAddSandbox();
    const words = useVocabulary();
    const capabilitiesDoor = useHeldDoor(`capabilities.list`);
    // Shell routes named as the rail names them, including the two the maker's vocabulary renames.
    const shellSections = computed<readonly NavCommand[]>(() => [
        { command: `view.chat`, title: t(`shared.chat`), category: GO_TO, icon: `comments`, to: here(page.chat()) },
        { command: `view.agents`, title: useVocabulary().value.agents, category: GO_TO, icon: `robot`, to: here(page.agents()) },
        ...(isGuest.value ? [] : guestless.value),
    ]);
    const guestless = computed<readonly NavCommand[]>(() => [
        { command: `view.workspace`, title: words.value.workspace, category: GO_TO, icon: `file-tree`, to: here(page.workspace()) },
        // The live app is a tab of Browsers now; this lands on the one most worth seeing, opening the view on the way, which
        // a bare push would not.
        { command: `view.preview`, title: words.value.preview, category: GO_TO, icon: `eye`, to: browsersPath(), run: () => openPreview(router) },
        { command: `view.browsers`, title: t(`shared.browsers`), category: GO_TO, icon: `browsers`, to: browsersPath(), run: () => openBrowsers(router) },
        ...(capabilitiesDoor.value ? [capabilitiesCommand()] : []),
        // A rail view of its own since it left the sandbox hub; maintainer and up, as its tile is.
        ...(canShip.value ? [{ command: `view.devices`, title: t(`sandbox.words.devicesSection`), category: GO_TO, icon: `desktop`, to: here(page.devices()) }] : []),
        // The account's deleted sandboxes, a page of the account's rather than of this sandbox: the restore is the account's own.
        { command: `view.deletedSandboxes`, title: t(`sandbox.recentlyDeleted.paletteTitle`), category: GO_TO, icon: `trash`, to: here(page.deletedSandboxes()) },
        // The daemon lets only a maintainer open the sandbox's desktop, since driving it is operating the sandbox.
        ...(canShip.value
            ? [
                  {
                      command: `view.desktop`,
                      title: t(`shared.desktop`),
                      category: GO_TO,
                      icon: `screen`,
                      to: browsersPath({ kind: `desktop` }),
                      run: () => openBrowsers(router, { kind: `desktop` }),
                  },
              ]
            : []),
    ]);

    // One command per rail-surface activation (not per view); the id carries the activation key unless it is a
    // singleton (`view.<id>`), so an extension with several tiles gets several rows.
    const extensionSections = computed<readonly NavCommand[]>(() =>
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
    // collides with a built-in section (Activity's, whose turns are the Activity extension's view drawn inside it, among
    // them) is dropped here too rather than registering a row that opens something else.
    const sandboxDestinations = computed<readonly NavCommand[]>(() => [
        ...sandboxSections(canShip.value, isGuest.value, orgHidden.value, useAccess().holds).map((section) => ({
            command: `view.sandbox.${section.slug}`,
            title: section.label,
            category: SANDBOX,
            icon: section.icon,
            to: sandboxSectionPath(section.slug),
        })),
        ...detectActivations(panels.value, capabilities.value)
            .filter(({ extension, activation }) => extension.surface === `sandbox` && sandboxKeyAllowed(activation.key))
            .map(({ activation }) => ({
                command: `view.sandbox.${activation.key}`,
                title: activation.title,
                category: SANDBOX,
                icon: activation.icon,
                to: sandboxSectionPath(activation.key),
            })),
        // The same add action as the switcher: a dialog here, with sign-in first only when needed.
        { command: `sandbox.add`, title: t(`shell.useNavigationCommands.add`), category: SANDBOX, icon: `plus`, to: toHome(), run: requestAddSandbox },
    ]);

    const settingsPlaces = computed<readonly NavCommand[]>(() =>
        settingsDestinations(planOffered.value).map((place) => ({
            command: `view.settings.${place.slug}`,
            title: place.label,
            category: SETTINGS,
            icon: place.icon,
            to: place.path,
        })),
    );

    const destinations = computed<readonly NavCommand[]>(() => [
        ...(homeOnly.value ? [] : shellSections.value),
        ...extensionSections.value,
        ...sandboxDestinations.value,
        ...settingsPlaces.value,
    ]);

    // Every address is in the frame the reader is in, so the list is made again on each navigation. A command is
    // registered again only when its row changes (rowsOf), and goes where its row says at the moment it runs.
    const whereNow = (destination: NavCommand): string =>
        destinations.value.find((current) => current.command === destination.command)?.to ?? destination.to;

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
        disposables = list.flatMap((destination) => registered(destination, (): void => void router.push(whereNow(destination))));
    };

    // Registered from onMounted, not setup, since WorkspaceShell may discard an instance before it ever mounts.
    let stop: WatchStopHandle | undefined;

    onMounted(() => {
        stop = watch(() => rowsOf(destinations.value), () => sync(destinations.value), { immediate: true });
    });

    onUnmounted(() => {
        stop?.();
        stop = undefined;
        release();
    });
}
