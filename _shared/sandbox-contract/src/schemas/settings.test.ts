import { convertDocument } from "../documents/conversions.js";
import type { ModelRole } from "../models/model-roles.js";
import { rolePins } from "../models/model-setups.js";
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

    test(`there is no push moment: nothing runs on the way to a push, CI checks what was pushed`, () => {
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

    // `land` is retired: it runs nothing, so a file written while it ran reads however it spelled one.
    test(`a retired land check still reads, however many a file names and whatever paths it gives`, () => {
        const file = (checks: unknown[]) => RepoChecksFileSchema.safeParse({ checks }).success;
        expect(
            file([
                { when: `land`, run: `pnpm verify` },
                { when: `land`, run: `pnpm test` },
            ]),
        ).toBe(true);
        expect(file([{ when: `land`, run: `pnpm verify`, paths: [`src/**`] }])).toBe(true);
    });
});

// Only the checks a repository declares run when a turn ends, and the daemon adds them to a turn's rules without saving
// them. An owner's rule there from before still reads, its conversion drops it, and no save may stand a new one there.
describe(`an owner's rule at the turn.ending moment`, () => {
    const look = { id: `verify-ui-edits`, label: `Look at what changed`, moment: `turn.ending`, action: { kind: `builtin`, name: `verify-ui-edits` } };
    const land = { id: `auto-land`, label: `land`, moment: `agent.finished`, action: { kind: `verdict`, verdict: `allow` } };

    test(`still reads, so an older file parses`, () => {
        expect(SandboxSettingsSchema.safeParse({ rules: [look, land] }).success).toBe(true);
    });

    test(`is refused on a save`, () => {
        const saved = SandboxSettingsWriteSchema.safeParse(SandboxSettingsSchema.parse({ rules: [look, land] }));
        expect(saved.error?.issues.map(({ message, path }) => ({ message, path }))).toEqual([
            { message: `turn.ending runs only the checks a repository declares in its own .intentic/checks.json, so a rule cannot stand there`, path: [`rules`] },
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

// keep-warm's four top-level settings became one object on 2026-09-26; a stored file keeps what its owner picked.
describe(`the folded keep-warm settings`, () => {
    test(`fold into one object, keeping each value and the key's place`, () => {
        const stored = { timezone: `Europe/Warsaw`, keepWarm: true, keepWarmHours: 6, keepWarmMinTokens: 50_000, keepWarmReserve: 20, iqSearch: true };
        const converted = convertDocument(SETTINGS_HISTORY, `object`, stored, true);
        expect(converted.value).toEqual({ timezone: `Europe/Warsaw`, keepWarm: { auto: true, hours: 6, minTokens: 50_000, reserve: 20 }, iqSearch: true });
        expect(JSON.stringify(converted.value)).toBe(
            `{"timezone":"Europe/Warsaw","keepWarm":{"auto":true,"hours":6,"minTokens":50000,"reserve":20},"iqSearch":true}`,
        );
        expect(SandboxSettingsSchema.parse(converted.value).keepWarm).toEqual({ auto: true, hours: 6, minTokens: 50_000, reserve: 20 });
    });

    test(`fold a file that set only some, leaving the rest to the defaults`, () => {
        const converted = convertDocument(SETTINGS_HISTORY, `object`, { keepWarmReserve: 30 }, true);
        expect(converted.value).toEqual({ keepWarm: { reserve: 30 } });
        expect(SandboxSettingsSchema.parse(converted.value).keepWarm).toEqual({ auto: false, hours: 4, minTokens: 100_000, reserve: 30 });
    });

    test(`leave a file already in the new shape alone`, () => {
        const current = { keepWarm: { auto: true, hours: 2 } };
        expect(convertDocument(SETTINGS_HISTORY, `object`, current, true).changes).toEqual([]);
    });
});

// Tool-result clearing lost its A/B and was removed (2026-10-12); a file that still switches it on reads, without it.
test(`a stored tool-result clearing switch is dropped, and the rest of the file kept`, () => {
    const converted = convertDocument(SETTINGS_HISTORY, `object`, { iqSearch: true, toolResultClearing: true, toolResultClearingHoldout: 0.5 }, true);
    expect(converted.value).toEqual({ iqSearch: true });
    expect(SandboxSettingsSchema.parse(converted.value).iqSearch).toBe(true);
});

// What a job runs on, read the way every reader reads it, over a sandbox with nothing connected: the setups a stored
// file converts into are judged by what they make each job run on, not by their shape.
const runsOn = (stored: unknown, role: ModelRole): readonly unknown[] => {
    const converted = convertDocument(SETTINGS_HISTORY, `object`, stored, true);
    return rolePins(SandboxSettingsSchema.parse(converted.value), role, []);
};

// The pre-push fix's model list went with the fix a refused push used to offer (2026-09-28). A settings file that still
// names it must read, since an unknown role refuses the whole file, and every other job's list stays as its owner set it.
describe(`the retired pre-push fix role`, () => {
    const pin = { provider: `claude`, model: `claude-opus-5-5` };

    test(`is dropped from a stored file, leaving every other job's list, and the file reads`, () => {
        const stored = { modelRoles: { "pipeline-fix": [pin], "pre-push-fix": [pin] } };
        expect(SandboxSettingsSchema.safeParse({ roleSetups: { "pre-push-fix": `high` } }).success).toBe(false);
        expect(runsOn(stored, `pipeline-fix`)).toEqual([pin]);
    });
});

// The Refactors job arrived on 2026-10-09; a file from before it carries the owner's Maintenance chores list over, so a
// refactor started from Health opens on a model they chose rather than on an empty job.
describe(`the new Refactors job`, () => {
    const opus = { provider: `claude`, model: `claude-opus-5-5` };
    const sol = { provider: `codex`, model: `gpt-sol-6.1` };

    test(`takes the Maintenance chores list in a file from before it, and every other list stays`, () => {
        const stored = { modelRoles: { "maintenance-chore": [opus, sol], "pipeline-fix": [sol] } };
        expect(runsOn(stored, `refactor-run`)).toEqual([opus, sol]);
        expect(runsOn(stored, `pipeline-fix`)).toEqual([sol]);
    });

    test(`leaves a list the owner set, even an emptied one`, () => {
        expect(runsOn({ modelRoles: { "maintenance-chore": [opus], "refactor-run": [sol] } }, `refactor-run`)).toEqual([sol]);
        expect(runsOn({ modelRoles: { "maintenance-chore": [opus], "refactor-run": [] } }, `refactor-run`)).toEqual([]);
    });
});

// Setups (2026-10-12): per-job lists and the default list become named setups that jobs share.
describe(`per-job model lists`, () => {
    const opus = { provider: `claude`, model: `claude-opus-5-5`, effort: `high` };
    const haiku = { provider: `claude`, model: `claude-haiku-4-5` };
    const sol = { provider: `codex`, model: `gpt-sol-6.1` };

    test(`become setups that every job runs exactly as before on`, () => {
        const cases = [
            [`commit-message`, [haiku]],
            [`session-title`, [haiku]],
            [`pipeline-fix`, [opus, sol]],
            [`refactor-run`, [opus, sol]],
            [`handoff-summary`, [sol, haiku]],
            [`safety-judge`, []],
        ] as const satisfies readonly (readonly [ModelRole, readonly unknown[]])[];
        for (const [role, pins] of cases) {
            expect(runsOn({ modelRoles: Object.fromEntries(cases) }, role)).toEqual(pins);
        }
    });

    test(`share a setup where they held one list, which becomes the preset most of them suit`, () => {
        const converted = convertDocument(SETTINGS_HISTORY, `object`, { modelRoles: { "commit-message": [haiku], "session-title": [haiku], "pipeline-fix": [opus], "handoff-summary": [sol] } }, true);
        expect(converted.value).toEqual({
            modelSetups: [
                { id: `low`, pins: [haiku] },
                { id: `setup-1`, name: `Setup 1`, pins: [sol] },
                { id: `high`, pins: [opus] },
            ],
            roleSetups: { "commit-message": `low`, "session-title": `low`, "handoff-summary": `setup-1`, "pipeline-fix": `high` },
        });
    });

    test(`carry the default list to every job that had none of its own`, () => {
        const stored = { modelDefault: [sol], modelRoles: { "pipeline-fix": [opus] } };
        expect(runsOn(stored, `commit-message`)).toEqual([sol]);
        expect(runsOn(stored, `loop-iteration`)).toEqual([sol]);
        expect(runsOn(stored, `pipeline-fix`)).toEqual([opus]);
    });

    test(`leave a job that never had a list on none, running exactly as before`, () => {
        const converted = convertDocument(SETTINGS_HISTORY, `object`, { modelRoles: {} }, true);
        expect(converted.value).toEqual({ modelSetups: [], roleSetups: {} });
        expect(runsOn({ modelRoles: {} }, `safety-judge`)).toEqual([]);
    });

    test(`read once, and a file already in setups is left alone`, () => {
        expect(convertDocument(SETTINGS_HISTORY, `object`, { modelSetups: [{ id: `low`, pins: [haiku] }], roleSetups: {} }, true).changes).toEqual([]);
    });
});

test("disk retention defaults bound checkouts and restore points while preserving explicit zero", () => {
    const defaults = SandboxSettingsSchema.parse({});
    expect(defaults.agentRetentionDays).toBe(3);
    expect(defaults.heldCheckoutDays).toBe(14);
    expect(defaults.retention.restorePointDays).toBe(30);
    const existing = SandboxSettingsSchema.parse({ heldCheckoutDays: 0, retention: { restorePointDays: 0 } });
    expect(existing.heldCheckoutDays).toBe(0);
    expect(existing.retention.restorePointDays).toBe(0);
});
