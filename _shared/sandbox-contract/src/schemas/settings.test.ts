import { convertDocument } from "../documents/conversions.js";
import { SETTINGS_HISTORY } from "./settings-history.js";
import { RepoChecksFileSchema, RuleSchema, SandboxSettingsSchema, SandboxSettingsWriteSchema } from "./settings.js";

// A rule that saves cleanly and silently does nothing is the failure this schema exists to refuse: an action, and a
// built-in's name, are checked against the moment they are written at.

const rule = (moment: string, action: unknown) => RuleSchema.safeParse({ id: `r`, label: `r`, moment, action });

describe(`which built-in stands at which moment`, () => {
    test(`the versioner stands at the landed moment and nowhere else`, () => {
        expect(rule(`agent.landed`, { kind: `builtin`, name: `version-landed` }).success).toBe(true);
        expect(rule(`turn.ending`, { kind: `builtin`, name: `version-landed` }).success).toBe(false);
    });

    test(`the look stands at the turn's end and not at the landing`, () => {
        expect(rule(`turn.ending`, { kind: `builtin`, name: `verify-ui-edits` }).success).toBe(true);
        expect(rule(`agent.landed`, { kind: `builtin`, name: `verify-ui-edits` }).success).toBe(false);
    });

    test(`the landed moment takes no verdict and no command: the work is already in the tree`, () => {
        expect(rule(`agent.landed`, { kind: `verdict`, verdict: `allow` }).success).toBe(false);
        expect(rule(`agent.landed`, { kind: `command`, command: `pnpm test` }).success).toBe(false);
    });

    test(`there is no push moment: the repository's own pre-push hook gates a push`, () => {
        expect(rule(`push.starting`, { kind: `command`, command: `pnpm test` }).success).toBe(false);
    });
});

describe(`where a command lives`, () => {
    test(`settings refuse a command rule, since it belongs to the repository it checks`, () => {
        const command = { id: `lint`, label: `lint`, moment: `file.edited`, action: { kind: `command`, command: `oxlint {file}` } };
        expect(SandboxSettingsSchema.safeParse({ rules: [command] }).success).toBe(false);
        const land = { id: `auto-land`, label: `land`, moment: `agent.finished`, action: { kind: `verdict`, verdict: `allow` } };
        expect(SandboxSettingsSchema.safeParse({ rules: [land] }).success).toBe(true);
    });

    test(`a repository declares edit, turn and land checks, and no push check`, () => {
        const file = (checks: unknown[]) => RepoChecksFileSchema.safeParse({ checks }).success;
        expect(
            file([
                { when: `edit`, run: `lint {file}` },
                { when: `turn`, run: `pnpm verify:turn` },
                { when: `land`, run: `pnpm verify` },
            ]),
        ).toBe(true);
        expect(file([{ when: `push`, run: `pnpm verify:push` }])).toBe(false);
    });

    test(`a land check is one per repository and narrows by no path`, () => {
        const file = (checks: unknown[]) => RepoChecksFileSchema.safeParse({ checks }).success;
        expect(
            file([
                { when: `land`, run: `pnpm verify` },
                { when: `land`, run: `pnpm test` },
            ]),
        ).toBe(false);
        expect(file([{ when: `land`, run: `pnpm verify`, paths: [`src/**`] }])).toBe(false);
    });
});

// Nothing runs when a turn ends any more. A file written before still reads, its conversion drops the inert rule, and no
// save may stand a new one there.
describe(`the retired turn.ending moment`, () => {
    const look = { id: `verify-ui-edits`, label: `Look at what changed`, moment: `turn.ending`, action: { kind: `builtin`, name: `verify-ui-edits` } };
    const land = { id: `auto-land`, label: `land`, moment: `agent.finished`, action: { kind: `verdict`, verdict: `allow` } };

    test(`still reads, so an older file parses`, () => {
        expect(SandboxSettingsSchema.safeParse({ rules: [look, land] }).success).toBe(true);
    });

    test(`is refused on a save`, () => {
        const saved = SandboxSettingsWriteSchema.safeParse(SandboxSettingsSchema.parse({ rules: [look, land] }));
        expect(saved.error?.issues.map(({ message, path }) => ({ message, path }))).toEqual([
            { message: `turn.ending is retired: nothing runs when a turn ends any more, so a rule cannot stand there`, path: [`rules`] },
        ]);
        expect(SandboxSettingsWriteSchema.safeParse(SandboxSettingsSchema.parse({ rules: [land] })).success).toBe(true);
    });

    test(`is dropped from a stored file by its conversion, which leaves every other rule and settles`, () => {
        const converted = convertDocument(SETTINGS_HISTORY, `object`, { rules: [look, land] }, true);
        expect(converted.value).toEqual({ rules: [land] });
        expect(converted.changes.map(({ conversion }) => conversion)).toEqual([
            `drops rules at the retired turn.ending moment (and the verify-ui-edits built-in), which run nothing`,
        ]);
    });
});
