import { AgentTurnSchema } from "../schemas/agent.js";
import {
    contributedModelRole,
    jobFields,
    CORE_MODEL_ROLES,
    EXTENSION_ROLES_BEFORE_CONTRIBUTIONS,
    ModelRoleSchema,
    PRESET_SETUPS,
    ROLES_BEFORE_CONTRIBUTIONS,
} from "./model-roles.js";

// The catalog draws the settings page directly, so its properties must hold of the table itself, not be remembered by
// whoever adds a row.

test("the page reads one-shots first, then whole sessions, in the table's own order", () => {
    const kinds = CORE_MODEL_ROLES.map((role) => role.kind);

    expect(kinds.indexOf(`run`)).toBe(kinds.lastIndexOf(`helper`) + 1);
});

test("every job is suggested a preset, and the cheap one is never suggested for a whole session", () => {
    expect(CORE_MODEL_ROLES.every((role) => PRESET_SETUPS.includes(role.setup))).toBe(true);
    expect(new Set<string>(CORE_MODEL_ROLES.filter((role) => role.kind === `run`).map((role) => role.setup)).has(`low`)).toBe(false);
});

// (2026-11-26) Six jobs left the table for their extensions' manifests; what a daemon from before served stays readable.
describe(`jobs extensions declare`, () => {
    test(`a job's id is any lowercase dashed word, so an extension's reads wherever a job is named`, () => {
        expect(ModelRoleSchema.safeParse(`pipeline-fix`).success).toBe(true);
        expect(ModelRoleSchema.safeParse(`saldeo-reconcile`).success).toBe(true);
        expect(ModelRoleSchema.safeParse(`Pipeline fix`).success).toBe(false);
        expect(ModelRoleSchema.safeParse(``).success).toBe(false);
    });

    test(`none of the six is the sandbox's own any more, and the table of before still lists every job in its order`, () => {
        const moved: readonly string[] = EXTENSION_ROLES_BEFORE_CONTRIBUTIONS.map((role) => role.id);
        expect(moved).toEqual([`pipeline-fix`, `deployment-fix`, `maintenance-chore`, `refactor-run`, `documentation-run`, `acceptance-run`]);
        expect(CORE_MODEL_ROLES.filter((role) => moved.includes(role.id))).toEqual([]);
        expect(ROLES_BEFORE_CONTRIBUTIONS.map((role) => role.id).toSorted()).toEqual([...CORE_MODEL_ROLES.map((role) => role.id), ...moved].toSorted());
        expect(ROLES_BEFORE_CONTRIBUTIONS.slice(8, 11).map((role) => role.id)).toEqual([`pipeline-fix`, `deployment-fix`, `workflow-fix`]);
    });

    test(`a declaration is served as a whole session, suggested medium and drawn with a wrench unless it says otherwise`, () => {
        expect(contributedModelRole({ id: `nightly-audit`, label: `Nightly audits`, explanation: `The audit run each night.` }, `acme.audit`, false)).toEqual({
            id: `nightly-audit`,
            label: `Nightly audits`,
            blurb: `The audit run each night.`,
            kind: `run`,
            icon: `wrench`,
            setup: `medium`,
            extension: `acme.audit`,
            enabled: false,
        });
    });
});

// `runRole` stays the closed list every daemon reads, so it never shrinks for a far end still reading it; an extension's
// job travels as `job`, which a daemon from before ignores.
describe(`how a turn names its job`, () => {
    test(`one every daemon knows rides as runRole, any other as job`, () => {
        expect(jobFields(`maintenance-chore`)).toEqual({ runRole: `maintenance-chore` });
        expect(jobFields(`loop-iteration`)).toEqual({ runRole: `loop-iteration` });
        expect(jobFields(`nightly-audit`)).toEqual({ job: `nightly-audit` });
    });

    test(`runRole takes only the closed list, job any job's id`, () => {
        expect(AgentTurnSchema.safeParse({ prompt: `go`, runRole: `pipeline-fix` }).success).toBe(true);
        expect(AgentTurnSchema.safeParse({ prompt: `go`, runRole: `nightly-audit` }).success).toBe(false);
        expect(AgentTurnSchema.parse({ prompt: `go`, job: `nightly-audit` }).job).toBe(`nightly-audit`);
        expect(AgentTurnSchema.safeParse({ prompt: `go`, job: `Nightly audit` }).success).toBe(false);
    });
});
