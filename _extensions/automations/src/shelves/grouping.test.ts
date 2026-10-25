import type { AutomationSummary } from "@intentic/sandbox-contract/schemas/automations";
import { gistOf, isFailing, type ShelfWords, shelfOf, shelvesOf } from "./grouping";

const words: ShelfWords = {
    chores: `Code chores`,
    other: `Other`,
    personaLabel: (id) => ({ marketing: `Marketing`, support: `Support` })[id],
};

const automation = (id: string, extra: Partial<AutomationSummary> = {}): AutomationSummary => ({
    id,
    trigger: { kind: `schedule`, cron: `0 3 * * *` },
    prompt: `Do the thing.`,
    enabled: true,
    runs: [],
    ...extra,
});

test(`a named group wins over the chore flag and the persona, and the remainder is Other`, () => {
    expect(shelfOf(automation(`a`, { group: ` Releases `, chore: true, actsAs: `marketing` }), words)).toEqual({
        key: `releases`,
        label: `Releases`,
        kind: `group`,
    });
    expect(shelfOf(automation(`b`, { chore: true, actsAs: `marketing` }), words).label).toBe(`Code chores`);
    expect(shelfOf(automation(`c`, { actsAs: `marketing` }), words).label).toBe(`Marketing`);
    expect(shelfOf(automation(`d`), words)).toEqual({ key: `other`, label: `Other`, kind: `other` });
});

test(`a persona that is gone still names its shelf, by its id`, () => {
    expect(shelfOf(automation(`a`, { actsAs: `reddit-writer` }), words)).toEqual({
        key: `reddit-writer`,
        label: `reddit-writer`,
        kind: `persona`,
    });
});

test(`a group and a persona of one name share a shelf, spelled as the group was typed, and Other sorts last`, () => {
    const shelves = shelvesOf(
        [
            automation(`other-one`),
            automation(`by-persona`, { actsAs: `marketing` }),
            automation(`by-group`, { group: `MARKETING` }),
            automation(`chore`, { chore: true }),
            automation(`support`, { actsAs: `support` }),
        ],
        words,
    );
    expect(shelves.map((shelf) => [shelf.label, shelf.automations.map((filed) => filed.id)])).toEqual([
        [`Code chores`, [`chore`]],
        [`MARKETING`, [`by-persona`, `by-group`]],
        [`Support`, [`support`]],
        [`Other`, [`other-one`]],
    ]);
});

test(`a shelf counts what is on and what is failing, where failing means switched on with a failed last run`, () => {
    const failed = { at: 1, outcome: `error` as const };
    const [shelf] = shelvesOf(
        [
            automation(`on-failing`, { group: `Ops`, runs: [failed] }),
            automation(`off-failed`, { group: `Ops`, enabled: false, runs: [failed] }),
            automation(`on-fine`, { group: `Ops`, runs: [{ at: 2, outcome: `completed` }, failed] }),
        ],
        words,
    );
    expect(shelf).toMatchObject({ on: 2, failing: 1 });
    expect(isFailing(automation(`x`, { enabled: false, runs: [failed] }))).toBe(false);
});

test(`the gist is the note without the shelf it already sits on, else the prompt's first line`, () => {
    expect(gistOf({ note: `Marketing: one post on X`, prompt: `…` }, `Marketing`)).toBe(`one post on X`);
    expect(gistOf({ note: `marketing — one post on X`, prompt: `…` }, `Marketing`)).toBe(`one post on X`);
    // A persona's label often carries its owner's name beside the role the notes open with.
    expect(gistOf({ note: `Growth: answers mentions`, prompt: `…` }, `Owen · Growth`)).toBe(`answers mentions`);
    expect(gistOf({ note: `Marketing: one post on X`, prompt: `…` }, `Other`)).toBe(`Marketing: one post on X`);
    // A shelf label that is a regular expression's syntax is matched as text, and a colon with no space after it is no lead.
    expect(gistOf({ note: `C++ (nightly): build`, prompt: `…` }, `C++ (nightly)`)).toBe(`build`);
    expect(gistOf({ note: `Releases:v2 notes`, prompt: `…` }, `Releases`)).toBe(`Releases:v2 notes`);
    expect(gistOf({ prompt: `\n\n  First line.\nSecond line.` }, undefined)).toBe(`First line.`);
});

// No accounts named outright is the same choice as naming nobody, so it files with the rest; Full access is a persona
// like any other and gets its own shelf, by the name the page gives it.
test(`files No accounts with the unnamed, and Full access on a shelf of its own`, () => {
    const named = { ...words, personaLabel: (id: string) => (id === `full-access` ? `Full access` : words.personaLabel(id)) };
    expect(shelfOf(automation(`a`, { actsAs: `no-accounts` }), named).kind).toBe(`other`);
    expect(shelfOf(automation(`b`, { actsAs: `full-access` }), named)).toMatchObject({ label: `Full access`, kind: `persona` });
});
