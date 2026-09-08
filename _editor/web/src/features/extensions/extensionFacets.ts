import type { ExtensionManifest } from "@intentic/extension-manifest";

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
}

const counted = (count: number, noun: string, plural = `${noun}s`): string => (count === 1 ? noun : `${count} ${plural}`);

// Sidebar families a view can claim, named for where the user finds it, not the enum.
const VIEW_SURFACES = {
    rail: { noun: `rail tile`, plural: `rail tiles` },
    sandbox: { noun: `sandbox tab`, plural: `sandbox tabs` },
    directory: { noun: `workspace panel`, plural: `workspace panels` },
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

    // Ordered by how visible the contribution is: what the reader can point at first, plumbing last.
    take(`views`, (views) =>
        Object.entries(VIEW_SURFACES).flatMap(([surface, { noun, plural }]) => {
            const matching = views.filter((view) => view.surface === surface);
            if (matching.length === 0) {
                return [];
            }
            return [{ kind: `views`, label: counted(matching.length, noun, plural), names: matching.map((view) => view.label), surface: true }];
        }),
    );
    take(`viewers`, (viewers) => [
        {
            kind: `viewers`,
            label: counted(viewers.length, `file viewer`),
            names: viewers.flatMap((viewer) => viewer.extensions.map((extension) => `.${extension}`)),
            surface: true,
        },
    ]);
    // Named for the folder, not the tab: the reader notices an icon on directories in their file tree.
    take(`documents`, (documents) => [
        {
            kind: `documents`,
            label: counted(documents.length, `folder document`),
            names: documents.map((document) => document.label),
            surface: true,
        },
    ]);
    take(`commands`, (commands) => [
        { kind: `commands`, label: counted(commands.length, `command`), names: commands.map((command) => command.title), surface: true },
    ]);
    take(`capabilities`, (capabilities) => [
        {
            kind: `capabilities`,
            label: counted(capabilities.length, `capability card`),
            names: capabilities.map((contribution) => contribution.catalog.name),
            surface: true,
        },
    ]);
    // Provider rides the label; event types are the detail underneath, not part of the name.
    take(`listener`, (listener) => [
        { kind: `listener`, label: `${listener.provider} listener`, names: listener.events.map((event) => event.type), surface: true },
    ]);
    take(`processes`, (processes) => [
        {
            kind: `processes`,
            label: counted(processes.length, `background service`),
            names: processes.map((process) => process.name),
            surface: true,
        },
    ]);
    take(`agent`, () => [
        { kind: `agent`, label: `agent plugin`, names: [`skills, subagents, hooks and MCP servers, loaded each turn`], surface: true },
    ]);
    take(`bin`, (bin) => [{ kind: `bin`, label: `agent CLI`, names: [`executables from ${bin}/, on the agent's PATH`], surface: true }]);
    take(`environment`, (environment) => [
        { kind: `environment`, label: `image layer`, names: [`${environment.fragment}, applied at the next environment rebuild`], surface: true },
    ]);
    take(`settings`, (settings) => [
        { kind: `settings`, label: counted(settings.length, `setting`), names: settings.map((setting) => setting.title), surface: true },
    ]);
    // Not a place; explains why a view refreshes without polling. Worth stating once the row is open, not on it.
    take(`files`, (files) => [{ kind: `files`, label: `watched files`, names: files.map((file) => file.path), surface: false }]);

    for (const [kind, value] of Object.entries(contributes)) {
        if (taught.has(kind) || value === undefined) {
            continue;
        }
        const count = Array.isArray(value) ? value.length : 1;
        if (count > 0) {
            facets.push({ kind, label: counted(count, kind, kind), names: [], surface: true });
        }
    }
    return facets;
};

// Every string a reader might filter by for this extension: its id, where it shows up, and the real names inside those
// places.
export const searchTextOf = (manifest: ExtensionManifest, facets: readonly ExtensionFacet[]): string =>
    [`${manifest.publisher}.${manifest.name}`, ...facets.flatMap((facet) => [facet.kind, facet.label, ...facet.names])].join(` `).toLowerCase();
