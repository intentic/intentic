import type { ExtensionManifest } from "@intentic/extension-api";

/* WHAT AN EXTENSION GIVES YOU — the manifest's `contributes` said in the reader's words instead of the
 * schema's keys.
 *
 * The Extensions tab used to print the keys themselves ("views (2) · files (1) · commands (1) · agent · bin"),
 * which is a count of things the reader cannot see and a vocabulary only this repo uses. Sixteen rows of it is
 * sixteen rows of nothing: it never answers "which one of these puts the Documentation tile in my rail?". A
 * facet answers that — `rail tile` names the PLACE the contribution shows up, and carries the real names behind
 * it (view labels, command titles, connector catalog names) for the row's expanded breakdown.
 *
 * COMPLETE BY CONSTRUCTION, still. The old summary was written by walking `contributes` rather than enumerating
 * the kinds, precisely because the enumerated version it replaced had silently omitted six of them. That
 * property is kept here: `take()` records every kind this file has been taught, and the trailing loop emits a
 * plain `kind (n)` facet for every key it hasn't — so a contribution point added to the schema tomorrow shows
 * up on the row the moment an extension declares it, phrased badly rather than not at all. */

type Contributes = NonNullable<ExtensionManifest["contributes"]>;

export interface ExtensionFacet {
    /** The `contributes` key it came from — the row's stable v-for key, and what a filter matches on. */
    readonly kind: string;
    /** The one-line strip's noun, counted: "2 rail tiles", "9 connectors", "agent CLI". */
    readonly label: string;
    /** The real names behind the noun, for the expanded breakdown — view labels, providers, file extensions. */
    readonly names: readonly string[];
    /**
     * Whether the collapsed row carries it. False for wiring with no place of its own: watched files exist so a
     * view refreshes, and settings are rendered as their own form right below the breakdown.
     */
    readonly surface: boolean;
}

const counted = (count: number, noun: string, plural = `${noun}s`): string => (count === 1 ? noun : `${count} ${plural}`);

// The three sidebar families a view can claim, named after where the user finds them rather than after the
// enum. `directory` is the per-repo panel in the Workspace tree; `sandbox` is a tab on this very hub.
const VIEW_SURFACES = {
    rail: { noun: `rail tile`, plural: `rail tiles` },
    sandbox: { noun: `sandbox tab`, plural: `sandbox tabs` },
    directory: { noun: `workspace panel`, plural: `workspace panels` },
} as const;

export const facetsOf = (manifest: ExtensionManifest): ExtensionFacet[] => {
    const contributes: Contributes = manifest.contributes ?? {};
    const facets: ExtensionFacet[] = [];
    const taught = new Set<string>();
    // Describes one kind, and marks it taught even when this manifest doesn't declare it — an absent kind still
    // must not fall through to the generic loop below.
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
    take(`commands`, (commands) => [
        { kind: `commands`, label: counted(commands.length, `command`), names: commands.map((command) => command.title), surface: true },
    ]);
    take(`connectors`, (connectors) => [
        {
            kind: `connectors`,
            label: counted(connectors.length, `connector`),
            names: connectors.map((connector) => connector.catalog.name),
            surface: true,
        },
    ]);
    // The provider rides the label rather than the names: "discord listener" is the fact, and the event types
    // are the detail underneath it.
    take(`listener`, (listener) => [{ kind: `listener`, label: `${listener.provider} listener`, names: [...listener.eventTypes], surface: true }]);
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
        { kind: `environment`, label: `image layer`, names: [`${environment.fragment} — applied at the next environment rebuild`], surface: true },
    ]);
    take(`settings`, (settings) => [
        { kind: `settings`, label: counted(settings.length, `setting`), names: settings.map((setting) => setting.title), surface: true },
    ]);
    // Not a place — it is why a view refreshes without polling. Worth stating once the row is open, never on it.
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

// Everything a reader could reasonably type into the filter to mean THIS extension: its id, the places it shows
// up, and the real names inside them — so "github" finds the connectors extension and ".docx" finds viewers.
export const searchTextOf = (manifest: ExtensionManifest, facets: readonly ExtensionFacet[]): string =>
    [`${manifest.publisher}.${manifest.name}`, ...facets.flatMap((facet) => [facet.kind, facet.label, ...facet.names])].join(` `).toLowerCase();
