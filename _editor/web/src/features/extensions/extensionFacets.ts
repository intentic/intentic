import type { ExtensionManifest } from "@intentic/extension-manifest";
import { t } from "@intentic/ui/i18n";

// Manifest `contributes` entries in the reader's words, not raw schema keys: a facet names where a contribution shows
// up (e.g. `rail tile`) and carries the real names for the row's breakdown. `take()` marks every kind known; anything
// else still emits a plain `kind (n)` facet.

type Contributes = NonNullable<ExtensionManifest["contributes"]>;

export interface ExtensionFacet {
    /** The `contributes` key it came from, the row's stable v-for key, and what a filter matches on. */
    readonly kind: string;
    /** The one-line strip's noun, counted: "2 rail tiles", "9 capability cards", "agent CLI". */
    readonly label: string;
    /** The real names behind the noun, for the expanded breakdown, view labels, providers, file extensions. */
    readonly names: readonly string[];
    /** Whether the collapsed row shows it; false for wiring with no place of its own (watched files, settings). */
    readonly surface: boolean;
    /** Where on screen, when a kind lands in more than one place: a view's surface (`rail`, `sandbox`, `directory`). */
    readonly place?: string;
}

// An unknown contribution kind is named by its schema key, so it is counted the same way in every language.
const counted = (count: number, noun: string): string => (count === 1 ? noun : `${count} ${noun}`);

// Sidebar families a view can claim, named for where the user finds it, not the enum. Functions, so the words are
// built in the language active when the row renders.
const VIEW_SURFACES = {
    rail: (count: number): string => t(`extensions.extensionFacets.railTiles`, { count }, count),
    sandbox: (count: number): string => t(`extensions.extensionFacets.sandboxTabs`, { count }, count),
    directory: (count: number): string => t(`extensions.extensionFacets.workspacePanels`, { count }, count),
} as const;

export const facetsOf = (manifest: ExtensionManifest): ExtensionFacet[] => {
    const contributes: Contributes = manifest.contributes ?? {};
    const facets: ExtensionFacet[] = [];
    const taught = new Set<string>();
    // Marks a kind taught even when absent, so it never falls through to the generic loop below.
    const take = <K extends keyof Contributes>(kind: K, describe: (value: NonNullable<Contributes[K]>) => ExtensionFacet[]): void => {
        taught.add(kind);
        const value = contributes[kind];
        if (value !== undefined && !(Array.isArray(value) && value.length === 0)) {
            facets.push(...describe(value as NonNullable<Contributes[K]>));
        }
    };

    // One facet of a kind, which is what every kind but `views` yields.
    const one = (kind: string, label: string, names: readonly string[], surface = true): ExtensionFacet[] => [{ kind, label, names, surface }];

    // Ordered by how visible the contribution is: what the reader can point at first, plumbing last.
    take(`views`, (views) =>
        Object.entries(VIEW_SURFACES).flatMap(([surface, label]) => {
            const matching = views.filter((view) => view.surface === surface);
            if (matching.length === 0) {
                return [];
            }
            return [{ kind: `views`, label: label(matching.length), names: matching.map((view) => view.label), surface: true, place: surface }];
        }),
    );
    take(`viewers`, (viewers) =>
        one(
            `viewers`,
            t(`extensions.extensionFacets.fileViewers`, { count: viewers.length }, viewers.length),
            viewers.flatMap((viewer) => viewer.extensions.map((extension) => `.${extension}`)),
        ),
    );
    // Named for the folder, not the tab: the reader notices an icon on directories in their file tree.
    take(`documents`, (documents) =>
        one(
            `documents`,
            t(`extensions.extensionFacets.folderDocuments`, { count: documents.length }, documents.length),
            documents.map((document) => document.label),
        ),
    );
    take(`sideViews`, (views) =>
        one(
            `sideViews`,
            t(`extensions.extensionFacets.sideViews`, { count: views.length }, views.length),
            views.map((view) => view.label),
        ),
    );
    take(`commands`, (commands) =>
        one(
            `commands`,
            t(`extensions.extensionFacets.commands`, { count: commands.length }, commands.length),
            commands.map((command) => command.title),
        ),
    );
    take(`capabilities`, (cards) =>
        one(
            `capabilities`,
            t(`extensions.extensionFacets.capabilityCards`, { count: cards.length }, cards.length),
            cards.map((card) => card.catalog.name),
        ),
    );
    take(`automationTemplates`, (templates) =>
        one(
            `automationTemplates`,
            t(`extensions.extensionFacets.automationTemplates`, { count: templates.length }, templates.length),
            templates.map((template) => template.title),
        ),
    );
    // Provider rides the label; event types are the detail underneath, not part of the name.
    take(`listener`, (listener) =>
        one(
            `listener`,
            t(`extensions.extensionFacets.listener`, { provider: listener.provider }),
            listener.events.map((event) => event.type),
        ),
    );
    take(`processes`, (processes) =>
        one(
            `processes`,
            t(`extensions.extensionFacets.backgroundServices`, { count: processes.length }, processes.length),
            processes.map((process) => process.name),
        ),
    );
    take(`agent`, () => one(`agent`, t(`extensions.extensionFacets.agentPlugin`), [t(`extensions.extensionFacets.agentPluginNames`)]));
    take(`bin`, (bin) => one(`bin`, t(`extensions.extensionFacets.agentCli`), [t(`extensions.extensionFacets.binNames`, { dir: bin })]));
    take(`tools`, () => one(`tools`, t(`extensions.extensionFacets.agentTools`), []));
    take(`environment`, (environment) =>
        one(`environment`, t(`extensions.extensionFacets.imageLayer`), [
            t(`extensions.extensionFacets.environmentNames`, { fragment: environment.fragment }),
        ]),
    );
    take(`settings`, (settings) =>
        one(
            `settings`,
            t(`extensions.extensionFacets.settings`, { count: settings.length }, settings.length),
            settings.map((setting) => setting.title),
        ),
    );
    // Not a place; explains why a view refreshes without polling. Worth stating once the row is open, not on it.
    take(`files`, (files) =>
        one(
            `files`,
            t(`extensions.extensionFacets.watchedFiles`),
            files.map((file) => file.path),
            false,
        ),
    );

    for (const [kind, value] of Object.entries(contributes)) {
        if (taught.has(kind) || value === undefined) {
            continue;
        }
        const count = Array.isArray(value) ? value.length : 1;
        if (count > 0) {
            facets.push({ kind, label: counted(count, kind), names: [], surface: true });
        }
    }
    return facets;
};

// Every string a reader might filter by for this extension: its id, where it shows up, and the real names inside those
// places.
export const searchTextOf = (manifest: ExtensionManifest, facets: readonly ExtensionFacet[]): string =>
    [`${manifest.publisher}.${manifest.name}`, ...facets.flatMap((facet) => [facet.kind, facet.label, ...facet.names])].join(` `).toLowerCase();
