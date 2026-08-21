import type { CapabilitySummary } from "@intentic-app/api-contract";
import type { CapabilityCatalogEntry } from "@intentic-app/capability-catalog";
import type { ExtensionSummary } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { cardHaystack, contributedCards, entryIcon, instancesOf, suggestName, withIdentityPicker } from "./cards";

/* The join between a card and the connections it is answerable for. Every case here is one somebody hit: a card
 * that owns two providers, two extensions declaring the same connector, a repeat add that must not overwrite the
 * connection it is standing beside. */

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

// The card that owns two providers is the one a per-kind match gets wrong: it would claim every cli capability
// in the sandbox, including the ones the GitHub card is answerable for.
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

// A card that pins its discriminator to one value, and a single-card kind that has no discriminator at all.
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

/* THE SILENT-OVERWRITE TRAP. Adding a second Reddit account has to suggest a free name: a suggestion that
 * collides upserts the connection the user is looking at, with no warning that it did. */
test(`suggests the first free name so a repeat add is an add`, () => {
    const reddit = card({ id: `reddit`, kind: `browser` });

    expect(suggestName(reddit, [])).toBe(`reddit`);
    expect(suggestName(reddit, [instance(`reddit`, `browser`)])).toBe(`reddit-2`);
    expect(suggestName(reddit, [instance(`reddit`, `browser`), instance(`reddit-2`, `browser`)])).toBe(`reddit-3`);
});

// A one-per-sandbox card is the opposite case: the id IS the instance, so re-picking the card must land on what
// exists rather than mint a second opinion about the same dockerd.
test(`never bumps the name of a one-per-sandbox card`, () => {
    const docker = card({ id: `docker`, kind: `docker`, singleton: true });

    expect(suggestName(docker, [instance(`docker`, `docker`)])).toBe(`docker`);
});

/* The identity picker exists because the manifest cannot know instance state. With no identities the field is
 * not an empty picker but no field at all: a free-text id there would only mint a dangling reference. */
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

// First declaration of a kind+id wins: the daemon contributionRegistry's precedent. Two extensions shipping a
// `github` connector must not produce two GitHub cards.
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

/* A card is never drawn as its initials: the KIND is always known, and "some connector" as a bolt beats it as two
 * letters. The card's own icon wins, then the per-kind fallback, then the bolt. */
test(`falls to the kind's glyph, and to the bolt for a kind with none`, () => {
    expect(entryIcon(card({ icon: `database` }))).toBe(`database`);
    expect(entryIcon(card({ kind: `browser` }))).toBe(`globe`);
    expect(entryIcon(card({ kind: `cli` }))).toBe(`bolt`);
});

// The kind and the hint are searched alongside the visible words: "mcp" and "ssh" are the names of the things,
// and the words that identify a card ("botfather") live in prose the tile no longer prints.
test(`searches the kind and the hint, not only what the tile shows`, () => {
    const haystack = cardHaystack(card({ name: `Telegram`, description: `Send messages.`, kind: `mcp`, hint: `Made with BotFather.` }));

    expect(haystack).toContain(`mcp`);
    expect(haystack).toContain(`botfather`);
});
