import type { Rule } from "@intentic/sandbox-contract";
import { describe, expect, test } from "vitest";
import { conditionHolds, landingVerdict, matching } from "./rules.js";

const rule = (over: Partial<Rule> & Pick<Rule, "id" | "moment" | "action">): Rule => ({
    label: over.id,
    enabled: true,
    ...over,
});

const command = (id: string, over: Partial<Rule> = {}): Rule =>
    rule({ id, moment: "push.starting", action: { kind: "command", command: `run ${id}`, timeoutMs: 900_000 }, ...over });

const verdict = (id: string, v: "allow" | "hold", over: Partial<Rule> = {}): Rule =>
    rule({ id, moment: "agent.finished", action: { kind: "verdict", verdict: v }, ...over });

describe(`conditions`, () => {
    test(`no condition matches anything, which is what the three replaced settings each did`, () => {
        expect(conditionHolds(undefined, {})).toBe(true);
        expect(conditionHolds({}, { repos: [`root`], paths: [`a.ts`], outcome: `clean` })).toBe(true);
    });

    test(`a condition naming a fact the moment does not carry does NOT match`, () => {
        // The alternative is the dangerous one: a rule written to narrow silently widening to "always" at the
        // one moment that knows least about itself.
        expect(conditionHolds({ repo: `api` }, {})).toBe(false);
        expect(conditionHolds({ outcome: [`error`] }, { repos: [`api`] })).toBe(false);
        expect(conditionHolds({ paths: [`docs/**`] }, {})).toBe(false);
    });

    test(`paths match on the search box's own glob dialect`, () => {
        expect(conditionHolds({ paths: [`docs/**`] }, { paths: [`docs/guide/intro.md`] })).toBe(true);
        expect(conditionHolds({ paths: [`docs/**`] }, { paths: [`src/docs.ts`] })).toBe(false);
        // One touched path is enough: a change that grazes the guarded area is in scope.
        expect(conditionHolds({ paths: [`**/*.sql`] }, { paths: [`README.md`, `db/0001.sql`] })).toBe(true);
    });

    test(`repo and outcome narrow independently, and a repo matches anywhere in the span`, () => {
        const facts = { repos: [`web`, `api`], outcome: `error` as const };
        expect(conditionHolds({ repo: `api`, outcome: [`error`, `conflict`] }, facts)).toBe(true);
        expect(conditionHolds({ repo: `docs`, outcome: [`error`] }, facts)).toBe(false);
        expect(conditionHolds({ repo: `api`, outcome: [`clean`] }, facts)).toBe(false);
    });
});

describe(`matching`, () => {
    test(`a moment that DOES things runs everything that matches, in the owner's order`, () => {
        const rules = [command(`lint`), command(`test`)];
        expect(matching(rules, `push.starting`).map((r) => r.id)).toEqual([`lint`, `test`]);
    });

    test(`a moment that DECIDES stops at the first match, so a narrow rule above a broad one means something`, () => {
        const rules = [verdict(`docs`, `allow`, { when: { paths: [`docs/**`] } }), verdict(`everything-else`, `hold`)];
        expect(matching(rules, `agent.finished`, { paths: [`docs/x.md`] }).map((r) => r.id)).toEqual([`docs`]);
        expect(matching(rules, `agent.finished`, { paths: [`src/x.ts`] }).map((r) => r.id)).toEqual([`everything-else`]);
    });

    test(`disabled rules and rules for another moment are not consulted`, () => {
        const rules = [command(`off`, { enabled: false }), verdict(`elsewhere`, `allow`), command(`on`)];
        expect(matching(rules, `push.starting`).map((r) => r.id)).toEqual([`on`]);
    });

    test(`an empty command is OFF, not a no-op run: the pre-push row has no second switch to disagree with`, () => {
        const rules = [rule({ id: `blank`, moment: `push.starting`, action: { kind: `command`, command: `   `, timeoutMs: 900_000 } })];
        expect(matching(rules, `push.starting`)).toEqual([]);
    });
});

describe(`the landing verdict`, () => {
    test(`nothing matched ⇒ hold, which IS the old auto-land-off default rather than a restatement of it`, () => {
        expect(landingVerdict([], {}, undefined).land).toBe(false);
    });

    test(`an allow rule lands the work and says which rule decided`, () => {
        const rules = [verdict(`land-everything`, `allow`)];
        const decided = landingVerdict(rules, {}, undefined);
        expect(decided.land).toBe(true);
        expect(decided.rule?.id).toBe(`land-everything`);
    });

    test(`the per-agent override beats the table, and reports no rule because none decided`, () => {
        const rules = [verdict(`land-everything`, `allow`)];
        expect(landingVerdict(rules, {}, false)).toEqual({ land: false });
        expect(landingVerdict([verdict(`hold-all`, `hold`)], {}, true)).toEqual({ land: true });
    });

    test(`conditions narrow landing: docs land by themselves, migrations wait`, () => {
        const rules = [verdict(`hold-migrations`, `hold`, { when: { paths: [`**/migrations/**`] } }), verdict(`land-rest`, `allow`)];
        expect(landingVerdict(rules, { paths: [`db/migrations/0001.sql`] }, undefined).land).toBe(false);
        expect(landingVerdict(rules, { paths: [`docs/intro.md`] }, undefined).land).toBe(true);
    });

    /* A red check holds against everything that was decided before the check ran: the unconditional allow rule,
     * and the owner's own press on the card. The one thing written ABOUT red work is a rule naming it. */
    test(`a turn whose own check failed is held, whatever an unconditional rule or the override says`, () => {
        const facts = { outcome: `checks-failed` as const };
        expect(landingVerdict([verdict(`land-everything`, `allow`)], facts, undefined)).toEqual({ land: false, held: `checks-failed` });
        expect(landingVerdict([verdict(`land-everything`, `allow`)], facts, true)).toEqual({ land: false, held: `checks-failed` });
        expect(landingVerdict([], facts, true)).toEqual({ land: false, held: `checks-failed` });
    });

    test(`a rule that names checks-failed decides red work, either way`, () => {
        const facts = { outcome: `checks-failed` as const, repos: [`docs`] };
        const lands = verdict(`land-red-docs`, `allow`, { when: { outcome: [`checks-failed`], repo: `docs` } });
        expect(landingVerdict([verdict(`land-everything`, `allow`), lands], facts, undefined)).toEqual({ land: true, rule: lands });
        // Named but for another repo: not a decision about this work.
        expect(landingVerdict([lands], { ...facts, repos: [`api`] }, undefined)).toEqual({ land: false, held: `checks-failed` });
        const holds = verdict(`hold-red`, `hold`, { when: { outcome: [`checks-failed`] } });
        expect(landingVerdict([holds], facts, true)).toEqual({ land: false, rule: holds });
    });

    test(`a clean turn is decided exactly as before`, () => {
        expect(landingVerdict([verdict(`land-everything`, `allow`)], { outcome: `clean` }, undefined).land).toBe(true);
        expect(landingVerdict([verdict(`land-everything`, `allow`)], { outcome: `clean` }, false).land).toBe(false);
    });
});
