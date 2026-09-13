import { STATE_DIR } from "@intentic/constants";
import type { ManifestProblemReport } from "@intentic/sandbox-contract";
import { describe, expect, test } from "vitest";
import { manifestNotices } from "./manifestNotice";

// Pins the wording rules for manifest notices (title, impact tag, per-problem lines and repairs).

const settings = `${STATE_DIR}/config/settings.json`;
const report = (...problems: ManifestProblemReport[`problems`]): ManifestProblemReport[] => [{ path: settings, problems }];

test(`a row is titled with the file's name and opens its full path`, () => {
    const [notice] = manifestNotices(report({ kind: `unknownKey`, detail: `skils` }));
    expect(notice?.file).toBe(`settings.json`);
    expect(notice?.path).toBe(settings);
});

describe(`a file the sandbox cannot read at all`, () => {
    test(`says how much stopped applying, not how many complaints there are`, () => {
        const [notice] = manifestNotices(report({ kind: `unreadable`, detail: `the file is not valid JSON` }));
        expect(notice?.impact).toBe(`using defaults`);
    });

    test(`stands the daemon's fragment up as its own sentence, stopped exactly once`, () => {
        const [notice] = manifestNotices(report({ kind: `unreadable`, detail: `the file is not valid JSON` }));
        expect(notice?.lines).toEqual([{ text: `The file is not valid JSON.`, repairs: [] }]);
    });

    test(`carries a remedy, on its own, apart from the cause`, () => {
        const [notice] = manifestNotices(report({ kind: `unreadable`, detail: `the file is not valid JSON` }));
        expect(notice?.fix).toBe(`Fix the file and it applies again.`);
        expect(notice?.lines.map((line) => line.text).join(` `)).not.toContain(`Fix the file`);
    });

    test(`prefers the daemon's own remedy when it knows one this side could not guess`, () => {
        const [notice] = manifestNotices(
            report({
                kind: `unreadable`,
                detail: `it was written by intentic 1.233.0, newer than this sandbox (1.199.0)`,
                fix: `Update the sandbox — the file itself is probably fine.`,
            }),
        );
        expect(notice?.fix).toBe(`Update the sandbox — the file itself is probably fine.`);
        expect(notice?.lines).toEqual([{ text: `It was written by intentic 1.233.0, newer than this sandbox (1.199.0).`, repairs: [] }]);
    });
});

describe(`keys this build does not know`, () => {
    test(`says the key and the guess, and nothing the tag has already said`, () => {
        const [notice] = manifestNotices(report({ kind: `unknownKey`, detail: `skils`, suggestion: `skills` }));
        expect(notice?.lines.map((line) => line.text)).toEqual([`"skils" — did you mean "skills"?`]);
    });

    test(`guesses nothing when nothing was close enough`, () => {
        const [notice] = manifestNotices(report({ kind: `unknownKey`, detail: `nonsense` }));
        expect(notice?.lines.map((line) => line.text)).toEqual([`"nonsense" — no setting by that name.`]);
    });

    test(`counts them in the tag, and adds no remedy the lines already carry`, () => {
        const [notice] = manifestNotices(
            report(
                { kind: `unknownKey`, detail: `skils`, suggestion: `skills` },
                { kind: `unknownKey`, detail: `hashlineEdit`, suggestion: `hashlineEdits` },
            ),
        );
        expect(notice?.impact).toBe(`2 settings ignored`);
        expect(notice?.fix).toBeUndefined();
    });

    test(`stays singular for one`, () => {
        expect(manifestNotices(report({ kind: `unknownKey`, detail: `skils` }))[0]?.impact).toBe(`1 setting ignored`);
    });

    test(`offers to take it out, because nothing is lost by taking it out`, () => {
        const [notice] = manifestNotices(report({ kind: `unknownKey`, detail: `contextShelf` }));
        expect(notice?.lines[0]?.repairs).toEqual([{ key: `contextShelf`, label: `Remove it`, spoken: `Remove "contextShelf"` }]);
    });

    test(`offers the guess as an action, and never applies it`, () => {
        const [notice] = manifestNotices(report({ kind: `unknownKey`, detail: `skils`, suggestion: `skills` }));
        expect(notice?.lines[0]?.text).toBe(`"skils" — did you mean "skills"?`);
        expect(notice?.lines[0]?.repairs[0]).toEqual({ key: `skils`, to: `skills`, label: `Rename it`, spoken: `Rename "skils" to "skills"` });
    });

    test(`still offers removal when it has guessed, because the guess can be wrong`, () => {
        const [notice] = manifestNotices(report({ kind: `unknownKey`, detail: `skils`, suggestion: `skills` }));
        expect(notice?.lines[0]?.repairs.map((repair) => repair.label)).toEqual([`Rename it`, `Remove it`]);
    });

    test(`leans on the line for the eye, and repeats itself for everyone else`, () => {
        const [notice] = manifestNotices(report({ kind: `unknownKey`, detail: `dependencyFreshnes`, suggestion: `dependencyFreshness` }));
        expect(notice?.lines[0]?.repairs.map((repair) => repair.label)).toEqual([`Rename it`, `Remove it`]);
        expect(notice?.lines[0]?.repairs.map((repair) => repair.spoken)).toEqual([
            `Rename "dependencyFreshnes" to "dependencyFreshness"`,
            `Remove "dependencyFreshnes"`,
        ]);
    });

    test(`keeps each key's actions on that key's own line`, () => {
        const [notice] = manifestNotices(
            report({ kind: `unknownKey`, detail: `skils`, suggestion: `skills` }, { kind: `unknownKey`, detail: `contextShelf` }),
        );
        expect(notice?.lines.map((line) => line.repairs.map((repair) => repair.key))).toEqual([[`skils`, `skils`], [`contextShelf`]]);
    });
});

describe(`what the card refuses to do for you`, () => {
    test(`will not drop an entry somebody wrote`, () => {
        const [notice] = manifestNotices(report({ kind: `invalidEntry`, detail: `capability 3 has no id` }));
        expect(notice?.lines[0]?.repairs).toEqual([]);
    });

    test(`will not offer to repair a file it cannot read`, () => {
        const [notice] = manifestNotices(report({ kind: `unreadable`, detail: `the file is not valid JSON` }));
        expect(notice?.lines[0]?.repairs).toEqual([]);
    });
});

describe(`entries skipped out of a list`, () => {
    test(`is scoped to the entry, in the tag and in the line`, () => {
        const [notice] = manifestNotices(report({ kind: `invalidEntry`, detail: `capability 3 has no id` }));
        expect(notice?.impact).toBe(`1 entry skipped`);
        expect(notice?.lines).toEqual([{ text: `Capability 3 has no id.`, repairs: [] }]);
    });

    test(`pluralises`, () => {
        const problems = [
            { kind: `invalidEntry`, detail: `capability 3 has no id` },
            { kind: `invalidEntry`, detail: `capability 4 has no id` },
        ] as const;
        expect(manifestNotices(report(...problems))[0]?.impact).toBe(`2 entries skipped`);
    });
});

test(`an ignored file outranks anything else wrong with it`, () => {
    // Can't happen today (an unparseable file has no keys to check), kept as a safeguard on the tag's precedence.
    const [notice] = manifestNotices(report({ kind: `unknownKey`, detail: `skils` }, { kind: `unreadable`, detail: `the file is not valid JSON` }));
    expect(notice?.impact).toBe(`using defaults`);
});

test(`each file is its own row, in the order the daemon reported them`, () => {
    const notices = manifestNotices([
        { path: settings, problems: [{ kind: `unknownKey`, detail: `skils` }] },
        { path: `${STATE_DIR}/config/personas.json`, problems: [{ kind: `unreadable`, detail: `the file is not valid JSON` }] },
    ]);
    expect(notices.map((notice) => notice.file)).toEqual([`settings.json`, `personas.json`]);
});
