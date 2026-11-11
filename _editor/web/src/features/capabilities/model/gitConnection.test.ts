import { CAPABILITY_CATALOG } from "@intentic/capability-catalog";
import type { CapabilitySummary } from "@intentic/sandbox-contract/schemas/capabilities";
import { chosenConnection, offeredConnections, ownToken, readsWithConnection } from "./gitConnection";

// The install form names the GitHub or GitLab card that will read a private repository, and sends it by id: the first
// for the host unless the reader picked another, and none once a token of the install's own stands in for them all.

const card = (id: string, config: CapabilitySummary["config"]): CapabilitySummary => ({ id, kind: `cli`, status: { state: `active` }, config, secrets: [`token`] });
const CARDS = [
    card(`github-zed`, { provider: `github`, git: `on` }),
    card(`github-ada`, { provider: `github`, git: `on` }),
    card(`work`, { provider: `gitlab`, url: `https://git.example.test`, git: `on` }),
];

const tile = (id: string) => {
    const entry = CAPABILITY_CATALOG.find((candidate) => candidate.id === id);
    if (entry === undefined) {
        throw new Error(`no ${id} tile`);
    }
    return entry;
};

test(`only an install's gitConnection field is drawn as the card that reads it`, () => {
    for (const id of [`plugin`, `extension`]) {
        const entry = tile(id);
        expect(entry.fields.filter((field) => readsWithConnection(entry, field)).map((field) => field.key)).toEqual([`gitConnection`]);
    }
    const fleet = tile(`fleet`);
    expect(fleet.fields.some((field) => readsWithConnection(fleet, field))).toBe(false);
});

test(`the cards offered are the host's, first by id`, () => {
    expect(offeredConnections(CARDS, `https://github.com/o/plugin`).map((connection) => connection.id)).toEqual([`github-ada`, `github-zed`]);
    expect(offeredConnections(CARDS, `https://git.example.test/team/ext.git`).map((connection) => connection.id)).toEqual([`work`]);
    expect(offeredConnections(CARDS, `https://bitbucket.org/o/plugin`)).toEqual([]);
});

test(`the choice sent: the reader's pick while it is offered, else the first; nothing beside a token of its own`, () => {
    const offered = offeredConnections(CARDS, `https://github.com/o/plugin`);
    expect(chosenConnection(offered, undefined, false)).toBe(`github-ada`);
    expect(chosenConnection(offered, `github-zed`, false)).toBe(`github-zed`);
    // A card removed since, or one for another host, falls back to the first rather than naming nothing that exists.
    expect(chosenConnection(offered, `work`, false)).toBe(`github-ada`);
    expect(chosenConnection(offered, `github-zed`, true)).toBe(``);
    expect(chosenConnection([], `github-zed`, false)).toBe(``);
});

test(`a token of the install's own is one typed, or one an edit keeps`, () => {
    expect(ownToken({ token: `  ` }, new Set())).toBe(false);
    expect(ownToken({ token: `ghp_x` }, new Set())).toBe(true);
    expect(ownToken({}, new Set([`token`]))).toBe(true);
});
