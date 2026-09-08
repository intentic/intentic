import type { CapabilitySummary } from "@intentic/api-contract";
import type { CapabilityCatalogEntry } from "@intentic/capability-catalog";
import type { ExtensionSummary } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { cardHaystack, contributedCards, entryIcon, instancesOf, suggestName, withIdentityPicker } from "./cards";

// Join between a card and the connections it's answerable for. Each case is one somebody hit: a card owning two
// providers, two extensions declaring the same connector, a repeat add that must not overwrite the connection
// beside it.

const card = (overrides: Partial<CapabilityCatalogEntry> = {}): CapabilityCatalogEntry => ({
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

// A per-kind match would wrongly claim every cli capability, including ones the GitHub card owns.
test(`matches the instances of a card's own providers, not every instance of its kind`, () => {
    const sql = card({
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

// A card pinning its discriminator to one value, and a single-card kind with no discriminator at all.
test(`matches a pinned provider exactly, and everything of a kind that has no discriminator`, () => {
    const reddit = card({ id: `reddit`, kind: `browser`, fields: [{ key: `platform`, label: `Site`, value: `reddit` }] });
    const ssh = card({ id: `ssh`, kind: `ssh`, fields: [{ key: `host`, label: `Host` }] });
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
    const reddit = card({ id: `reddit`, kind: `browser` });

    expect(suggestName(reddit, [])).toBe(`reddit`);
    expect(suggestName(reddit, [instance(`reddit`, `browser`)])).toBe(`reddit-2`);
    expect(suggestName(reddit, [instance(`reddit`, `browser`), instance(`reddit-2`, `browser`)])).toBe(`reddit-3`);
});

// A singleton card is the opposite case: the id is the instance, so re-picking it must land on what exists.
test(`never bumps the name of a one-per-sandbox card`, () => {
    const docker = card({ id: `docker`, kind: `docker`, singleton: true });

    expect(suggestName(docker, [instance(`docker`, `docker`)])).toBe(`docker`);
});

// Identity picker exists because the manifest can't know instance state; with none, the field disappears rather
// than inviting a dangling free-text id.
test(`offers the identities that exist, and drops the field entirely when none do`, () => {
    const reddit = card({
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
    // Every other kind of card is untouched, including its object identity.
    const cli = card();
    expect(withIdentityPicker(cli, [`ada`])).toBe(cli);
});

// First declaration of a kind+id wins (contributionRegistry's precedent); two extensions shipping `github` must not
// yield two cards.
test(`derives one card per kind+id, whichever extension declared it first`, () => {
    const cards = contributedCards([
        extension(`a`, [{ id: `github`, kind: `cli`, catalog: { name: `GitHub`, category: `code`, description: `Issues and PRs.` }, fields: [] }]),
        extension(`b`, [
            { id: `github`, kind: `cli`, catalog: { name: `GitHub (fork)`, category: `code`, description: `A second opinion.` }, fields: [] },
            { id: `gitlab`, kind: `cli`, catalog: { name: `GitLab`, category: `code`, description: `Merge requests.` }, fields: [] },
        ]),
    ]);

    expect(cards.map((entry) => entry.name)).toEqual([`GitHub`, `GitLab`]);
});

// A card is never drawn as initials: kind is always known, so its own icon wins, then the kind's fallback, then the
// bolt.
test(`falls to the kind's glyph, and to the bolt for a kind with none`, () => {
    expect(entryIcon(card({ icon: `database` }))).toBe(`database`);
    expect(entryIcon(card({ kind: `browser` }))).toBe(`globe`);
    expect(entryIcon(card({ kind: `cli` }))).toBe(`bolt`);
});

// Kind and hint are searched alongside visible words, since a card's identifying terms often live in prose the tile
// no longer prints.
test(`searches the kind and the hint, not only what the tile shows`, () => {
    const haystack = cardHaystack(card({ name: `Telegram`, description: `Send messages.`, kind: `mcp`, hint: `Made with BotFather.` }));

    expect(haystack).toContain(`mcp`);
    expect(haystack).toContain(`botfather`);
});
