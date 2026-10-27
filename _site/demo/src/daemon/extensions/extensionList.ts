import { builtinModules } from "@intentic/web/builtins";
import type { ExtensionSummary } from "@intentic/sandbox-contract/schemas/extension-updates";
import { deskEdition, enabledExtensions, freshEdition } from "../../mode";
import pins from "../../../vendor/extensions.json";

// The extensions acme-shop has installed, as the daemon's inventory reads them: the shipped connectors, everything
// compiled into this build and the listed ones vendored at their pinned commits. Kept apart from sandbox.ts because the
// lifecycle around them (daemon/extensionLifecycle.ts) adds to and takes from this list.

// The connector extensions as they ship, read from their own manifests in `_extensions/` the way the vendored ones are
// read below, so the catalogue the demo draws is the one the product has rather than a hand-kept subset of it. Plain
// string literals for the same reason as there: Vite reads a glob call statically.
const SHIPPED_MANIFESTS = import.meta.glob<ExtensionSummary["manifest"]>(
    [
        "../../../../../_extensions/connectors/intentic-extension.json",
        "../../../../../_extensions/discord/intentic-extension.json",
        "../../../../../_extensions/slack/intentic-extension.json",
        "../../../../../_extensions/google-workspace/intentic-extension.json",
        "../../../../../_extensions/microsoft-365/intentic-extension.json",
        "../../../../../_extensions/imap/intentic-extension.json",
        "../../../../../_extensions/telegram/intentic-extension.json",
        "../../../../../_extensions/whatsapp/intentic-extension.json",
        "../../../../../_extensions/onlyoffice/intentic-extension.json",
    ],
    { eager: true, import: "default" },
);

// One shipped manifest as the demo installs it: everything but the credential guides, since a recording has no token
// to go and make and the add form reads better without the steps for making one.
const shipped = (folder: string, commit: string): Omit<ExtensionSummary, "enabled">[] =>
    Object.entries(SHIPPED_MANIFESTS)
        .filter(([path]) => path.split(`/`).at(-2) === folder)
        .map(([, manifest]) => ({
            id: `${manifest.publisher}.${manifest.name}`,
            commit,
            source: `builtin`,
            manifest: {
                ...manifest,
                contributes: {
                    ...manifest.contributes,
                    capabilities: manifest.contributes?.capabilities?.map(({ catalog, ...capability }) => {
                        const { guide: _guide, ...shown } = catalog;
                        return { ...capability, catalog: shown };
                    }),
                },
            },
        }));

// No `enabled` here; `demoExtensions()` below applies demo mode's on/off once.
const CONNECTOR_EXTENSIONS: Omit<ExtensionSummary, "enabled">[] = [
    // The Android phone card, copied from `_extensions/phones`, so the demo can open its pairing dialog (the fixture
    // daemon mints a pairing nothing can redeem, and the QR code it draws is a real one).
    {
        id: `intentic.phones`,
        commit: `7d1e2a9`,
        source: `builtin`,
        manifest: {
            publisher: `intentic`,
            name: `phones`,
            version: `1.0.0`,
            engines: { intentic: `^2.0.0` },
            contributes: {
                capabilities: [
                    {
                        id: `android`,
                        kind: `phone`,
                        install: `https://intentic.dev/phone`,
                        catalog: {
                            name: `Android phone`,
                            logo: `android`,
                            description: `Your own Android phone: its screen, the apps you allow, the folders you pick.`,
                            category: `devices`,
                        },
                        fields: [],
                        skill: `skills/android/SKILL.md`,
                    },
                ],
            },
        },
    },
    ...shipped(`connectors`, `9f2c41d`),
    ...shipped(`discord`, `4ab7e10`),
    ...shipped(`slack`, `c3e81f4`),
    ...shipped(`google-workspace`, `5d20a7b`),
    ...shipped(`microsoft-365`, `e17b9c2`),
    ...shipped(`imap`, `0a6f3d8`),
    ...shipped(`telegram`, `b94e215`),
    ...shipped(`whatsapp`, `7c51e0a`),
    // A settings form with a choice that explains each option and a switch, as the Installed page draws them.
    ...shipped(`onlyoffice`, `2e8d5f1`),
];

// One extension installed from a community repository rather than shipped: the storefront kit whose product-copy skill
// the Skills page lists (daemon/skills.ts). Being installed at a pinned commit, it is the row with an update lifecycle
// whether or not the listed extensions were synced into vendor/, and it ships no UI bundle, so nothing loads for it.
const STOREFRONT: Omit<ExtensionSummary, "enabled"> = {
    id: `storefront`,
    commit: `2c7e91b04d5af3e86c1b09d27f4a6e3158bc0d94`,
    source: `installed`,
    manifest: {
        publisher: `shopkit`,
        name: `storefront`,
        version: `1.3.0`,
        category: `Commerce`,
        icon: `shopping-cart`,
        engines: { intentic: `^2.0.0` },
        permissions: { sandbox: [`GET /workspace/file`] },
        contributes: { agent: { path: `plugin` } },
    },
};
const installedFromRepos = (): Omit<ExtensionSummary, "enabled">[] => (deskEdition || freshEdition ? [] : [STOREFRONT]);

// Every first-party extension compiled into this build, read from the app's own registry so it can't drift from what's
// really compiled in. `commit` is `demo`: this recording isn't a real build.
const compiledExtensions = (): Omit<ExtensionSummary, "enabled">[] =>
    [...builtinModules].map(([id, module]) => ({ id, manifest: module.manifest, commit: `demo`, source: `builtin` }));

// The LISTED first-party extensions (acceptance, documentation, maintenance, knowledge, deployments, issues), vendored
// at the registry's pinned commits by scripts/sync-extensions.mjs and read here exactly as an installed checkout: the
// manifest is the row, the bundle is what `GET /extensions/{id}/bundle` serves. A pin the sync has not fetched yet is
// simply not installed in this recording.
// Plain string literals throughout: Vite reads a glob call statically and a template literal in its options is not a
// string to it, which turned `?raw` into a module import of a minified bundle.
const VENDORED_MANIFESTS = import.meta.glob<ExtensionSummary["manifest"]>("../../../vendor/extensions/*/intentic-extension.json", {
    eager: true,
    import: "default",
});
const VENDORED_BUNDLES = import.meta.glob<string>("../../../vendor/extensions/*/extension.js", { eager: true, query: "?raw", import: "default" });
const vendoredIdOf = (path: string): string => path.split(`/`).at(-2) ?? ``;
const vendoredExtensions = (): Omit<ExtensionSummary, "enabled">[] =>
    Object.entries(VENDORED_MANIFESTS).map(([path, manifest]) => {
        const id = vendoredIdOf(path);
        // SAFETY: extensions.json is the sync script's own pin table, one `{ repo, sha }` per listed id.
        return { id, manifest, commit: (pins as Record<string, { sha: string }>)[id]?.sha ?? `pending`, source: `installed` };
    });

// Bundles written in this tab: a workspace extension made from the Extensions tab, or one approved there, is served
// from its own folder with no build step, so its bytes are whatever was written.
const writtenBundles = new Map<string, string>();

/** The code one id's `entry` serves: vendored, or written in this tab. */
export const bundleOf = (id: string): string | undefined =>
    writtenBundles.get(id) ?? Object.entries(VENDORED_BUNDLES).find(([path]) => vendoredIdOf(path) === id)?.[1];

// The bundle bytes for one id, or a 404 in the daemon's own words.
export const vendoredBundle = (id: string): Response => {
    const bytes = bundleOf(id);
    return bytes === undefined
        ? new Response(JSON.stringify({ error: `no bundle vendored for ${id}` }), { status: 404, headers: { "content-type": `application/json` } })
        : new Response(bytes, { headers: { "content-type": `text/javascript` } });
};

// Built once, then live: toggling here persists across reads, like the real daemon.
let extensions: ExtensionSummary[] | undefined;

// Which extensions start on is demo mode's opening position only; every extension stays listed, most switched off, as
// an unset-up workspace really looks.
export const demoExtensions = (): ExtensionSummary[] =>
    (extensions ??= [...compiledExtensions(), ...vendoredExtensions(), ...installedFromRepos(), ...CONNECTOR_EXTENSIONS].map((extension) =>
        // Mutates in place: `setExtensionEnabled` below writes `enabled` straight onto these objects.
        Object.assign(extension, { enabled: enabledExtensions()?.includes(extension.id) ?? true }),
    ));

export const setExtensionEnabled = (id: string, enabled: boolean): void => {
    const extension = demoExtensions().find((candidate) => candidate.id === id);
    if (extension !== undefined) {
        extension.enabled = enabled;
    }
};


// A workspace extension joining the list, with the bytes its `entry` serves; an id already listed is not added twice.
export const addDemoExtension = (extension: ExtensionSummary, bundle: string | undefined): void => {
    if (bundle !== undefined) {
        writtenBundles.set(extension.id, bundle);
    }
    if (!demoExtensions().some((candidate) => candidate.id === extension.id)) {
        demoExtensions().push(extension);
    }
};

// Out of the list for good (until the page reloads), as a removal leaves the daemon's inventory.
export const removeDemoExtension = (id: string): void => {
    const list = demoExtensions();
    const index = list.findIndex((candidate) => candidate.id === id);
    if (index !== -1) {
        list.splice(index, 1);
    }
    writtenBundles.delete(id);
};
