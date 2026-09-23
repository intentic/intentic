import type { CapabilitySummary } from "@intentic/api-contract";
import { CAPABILITY_CATALOG, type CapabilityCatalogEntry, instancesOf } from "@intentic/capability-catalog";
import type { ExtensionSummary } from "@intentic/sandbox-contract";
import { test, expect } from "bun:test";
import { catalogEntries, contributedTiles, entryHaystack, entryIcon, isDefaultName, openingName, suggestName, withIdentityPicker } from "./tiles";

// Join between a tile and the connections it's answerable for. Each case is one somebody hit: a tile owning two
// providers, two extensions declaring the same connector, a repeat add that must not overwrite the connection
// beside it.

const tile = (overrides: Partial<CapabilityCatalogEntry> = {}): CapabilityCatalogEntry => ({
    id: `sql`,
    name: `SQL`,
    kind: `cli`,
    category: `data`,
    description: `Query a database.`,
    fields: [],
    ...overrides,
});

const instance = (id: string, kind: string, config: Record<string, string> = {}): CapabilitySummary =>
    ({ id, kind, status: { state: `active` }, config }) as CapabilitySummary;

const extension = (id: string, capabilities: unknown[]): ExtensionSummary =>
    ({ id, manifest: { contributes: { capabilities } } }) as unknown as ExtensionSummary;

// A per-kind match would wrongly claim every cli capability, including ones the GitHub tile owns.
test(`matches the instances of a tile's own providers, not every instance of its kind`, () => {
    const sql = tile({
        fields: [
            {
                key: `provider`,
                label: `Engine`,
                options: [
                    { value: `postgres`, label: `Postgres` },
                    { value: `mysql`, label: `MySQL` },
                ],
            },
        ],
    });
    const all = [
        instance(`shop`, `cli`, { provider: `postgres` }),
        instance(`legacy`, `cli`, { provider: `mysql` }),
        instance(`gh`, `cli`, { provider: `github` }),
    ];

    expect(instancesOf(sql, all).map((found) => found.id)).toEqual([`shop`, `legacy`]);
});

// A tile pinning its discriminator to one value, and a single-card kind with no discriminator at all.
test(`matches a pinned provider exactly, and everything of a kind that has no discriminator`, () => {
    const reddit = tile({ id: `reddit`, kind: `browser`, fields: [{ key: `platform`, label: `Site`, value: `reddit` }] });
    const ssh = tile({ id: `ssh`, kind: `ssh`, fields: [{ key: `host`, label: `Host` }] });
    const all = [
        instance(`reddit`, `browser`, { platform: `reddit` }),
        instance(`x`, `browser`, { platform: `x` }),
        instance(`ops-box`, `ssh`, { host: `ops.acme.dev` }),
        instance(`build-box`, `ssh`, { host: `build.acme.dev` }),
    ];

    expect(instancesOf(reddit, all).map((found) => found.id)).toEqual([`reddit`]);
    expect(instancesOf(ssh, all).map((found) => found.id)).toEqual([`ops-box`, `build-box`]);
});

// Silent-overwrite trap: a colliding name suggestion would upsert the connection the user is looking at, unwarned.
test(`suggests the first free name so a repeat add is an add`, () => {
    const reddit = tile({ id: `reddit`, kind: `browser` });

    expect(suggestName(reddit, [])).toBe(`reddit`);
    expect(suggestName(reddit, [instance(`reddit`, `browser`)])).toBe(`reddit-2`);
    expect(suggestName(reddit, [instance(`reddit`, `browser`), instance(`reddit-2`, `browser`)])).toBe(`reddit-3`);
});

// Once the service has said whose token it is, a second connection is named for that account rather than counted:
// `github-ada` in a tool prefix says which one, `github-2` does not. The first stays bare, and a taken qualified name
// still bumps rather than overwriting.
test(`names a repeat connection for the account the probe identified`, () => {
    const github = tile({ id: `github`, kind: `cli` });

    expect(suggestName(github, [], `ada`)).toBe(`github`);
    expect(suggestName(github, [instance(`github`, `cli`)], `ada`)).toBe(`github-ada`);
    expect(suggestName(github, [instance(`github`, `cli`)], `Ada Lovelace (Org)`)).toBe(`github-ada-lovelace-org`);
    expect(suggestName(github, [instance(`github`, `cli`), instance(`github-ada`, `cli`)], `ada`)).toBe(`github-ada-2`);
    expect(suggestName(github, [instance(`github`, `cli`)], `···`)).toBe(`github-2`);
});

// The hostname offer is made only to a connection still wearing its tile's name; `rog` was typed, and is left alone.
test(`tells a card-issued name from one the owner chose`, () => {
    expect(isDefaultName(`linux`, `linux`)).toBe(true);
    expect(isDefaultName(`linux`, `linux-3`)).toBe(true);
    expect(isDefaultName(`linux`, `rog`)).toBe(false);
    expect(isDefaultName(`linux`, `linux-rog`)).toBe(false);
});

// A singleton tile is the opposite case: the id is the instance, so re-picking it must land on what exists.
test(`never bumps the name of a one-per-sandbox tile`, () => {
    const docker = tile({ id: `docker`, kind: `docker`, singleton: true });

    expect(suggestName(docker, [instance(`docker`, `docker`)])).toBe(`docker`);
});

// Identity picker exists because the manifest can't know instance state; with none, the field disappears rather
// than inviting a dangling free-text id.
test(`offers the identities that exist, and drops the field entirely when none do`, () => {
    const reddit = tile({
        id: `reddit`,
        kind: `browser`,
        fields: [
            { key: `identity`, label: `Identity` },
            { key: `note`, label: `Note` },
        ],
    });

    expect(withIdentityPicker(reddit, []).fields.map((field) => field.key)).toEqual([`note`]);

    const withOne = withIdentityPicker(reddit, [`ada`]);
    expect(withOne.fields[0]?.options).toEqual([
        { value: ``, label: `Standalone` },
        { value: `ada`, label: `ada` },
    ]);
    // Standalone is the empty value, so a config without an identity carries no key rather than an empty one.
    expect(withOne.fields[0]?.options?.[0]?.value).toBe(``);
    // Every other kind of tile is untouched, including its object identity.
    const cli = tile();
    expect(withIdentityPicker(cli, [`ada`])).toBe(cli);
});

// First declaration of a kind+id wins (contributionRegistry's precedent); two extensions shipping `github` must not
// yield two tiles.
test(`derives one tile per kind+id, whichever extension declared it first`, () => {
    const tiles = contributedTiles([
        extension(`a`, [{ id: `github`, kind: `cli`, catalog: { name: `GitHub`, category: `code`, description: `Issues and PRs.` }, fields: [] }]),
        extension(`b`, [
            { id: `github`, kind: `cli`, catalog: { name: `GitHub (fork)`, category: `code`, description: `A second opinion.` }, fields: [] },
            { id: `gitlab`, kind: `cli`, catalog: { name: `GitLab`, category: `code`, description: `Merge requests.` }, fields: [] },
        ]),
    ]);

    expect(tiles.map((entry) => entry.name)).toEqual([`GitHub`, `GitLab`]);
});

// A tile is never drawn as initials: kind is always known, so its own icon wins, then the kind's fallback, then the
// bolt.
test(`falls to the kind's glyph, and to the bolt for a kind with none`, () => {
    expect(entryIcon(tile({ icon: `database` }))).toBe(`database`);
    expect(entryIcon(tile({ kind: `browser` }))).toBe(`globe`);
    expect(entryIcon(tile({ kind: `cli` }))).toBe(`bolt`);
});

// Kind and hint are searched alongside visible words, since a tile's identifying terms often live in prose the tile
// no longer prints.
test(`searches the kind and the hint, not only what the tile shows`, () => {
    const haystack = entryHaystack(tile({ name: `Telegram`, description: `Send messages.`, kind: `mcp`, hint: `Made with BotFather.` }));

    expect(haystack).toContain(`mcp`);
    expect(haystack).toContain(`botfather`);
});

// Enabled extensions' tiles lead the static catalog, and a browser tile's identity field names only identities that
// exist in this sandbox.
test(`offers the enabled extensions' tiles first, then the core catalog`, () => {
    const entries = catalogEntries(
        [
            extension(`social`, [
                {
                    id: `reddit`,
                    kind: `browser`,
                    catalog: { name: `Reddit`, category: `communication`, description: `Act as you on Reddit.` },
                    fields: [{ key: `identity`, label: `Identity` }],
                },
            ]),
        ],
        [instance(`ada`, `identity`), instance(`ops`, `ssh`)],
    );

    expect(entries.map((entry) => entry.id)).toEqual([`reddit`, ...CAPABILITY_CATALOG.map((entry) => entry.id)]);
    expect(entries[0]?.fields.find((field) => field.key === `identity`)?.options).toEqual([
        { value: ``, label: `Standalone` },
        { value: `ada`, label: `ada` },
    ]);
});

// An edit keeps the connection's name; an add suggests a free one; a machine arriving from desktop sync brings its own,
// chosen, so the two doors fold into one row.
test(`opens the form on the connection's name, a free one, or the arriving machine's`, () => {
    const linux = tile({ id: `linux`, kind: `device` });
    const taken = [instance(`linux`, `device`)];

    expect(openingName(linux, instance(`linux`, `device`), taken, ``)).toEqual({ name: `linux`, chosen: false });
    expect(openingName(linux, undefined, taken, ``)).toEqual({ name: `linux-2`, chosen: false });
    expect(openingName(linux, undefined, taken, `radarsu-rog`)).toEqual({ name: `radarsu-rog`, chosen: true });
    // Editing wins over an arriving machine: the connection being edited keeps its own name.
    expect(openingName(linux, instance(`omen`, `device`), taken, `radarsu-rog`)).toEqual({ name: `omen`, chosen: false });
});
