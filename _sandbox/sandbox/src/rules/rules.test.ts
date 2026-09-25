import type { Rule } from "@intentic/sandbox-contract";
import { conditionHolds, landingVerdict, matching, reposOf } from "./rules.js";

const rule = (over: Partial<Rule> & Pick<Rule, "id" | "moment" | "action">): Rule => ({
    label: over.id,
    enabled: true,
    ...over,
});

const command = (id: string, over: Partial<Rule> = {}): Rule =>
    rule({ id, moment: "file.edited", action: { kind: "command", command: `run ${id}`, timeoutMs: 900_000 }, ...over });

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

    test(`a sampled rule fires when the occasion's draw falls under its fraction, and always where nothing is drawn`, () => {
        expect(conditionHolds({ sample: 0.25 }, { draw: 0.1 })).toBe(true);
        expect(conditionHolds({ sample: 0.25 }, { draw: 0.25 })).toBe(false);
        expect(conditionHolds({ sample: 0.25 }, { draw: 0.9 })).toBe(false);
        // A landing decision draws nothing, so a sample there narrows nothing rather than silently switching the rule off.
        expect(conditionHolds({ sample: 0.25 }, {})).toBe(true);
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

describe(`which repositories a change is in`, () => {
    // The moments that know paths but not repositories (an edit) work theirs out here, so `when.repo` means the same
    // thing at every moment rather than only where a repository happens to be handed in.
    test(`a path belongs to the longest repository id that contains it`, () => {
        expect(reposOf([`extensions/logs/src/index.ts`], [`extensions`, `extensions/logs`])).toEqual([`extensions/logs`]);
    });

    test(`a path under no repository belongs to the workspace's own`, () => {
        expect(reposOf([`README.md`], [`intentic`])).toEqual([`root`]);
    });

    test(`one turn can touch several, and each is named once`, () => {
        expect(reposOf([`intentic/a.ts`, `intentic/b.ts`, `docs/c.md`], [`intentic`, `docs`]).toSorted()).toEqual([`docs`, `intentic`]);
    });

    // The guard against a prefix that is not a folder boundary: `intentic-site` is not inside `intentic`.
    test(`a repository's name is not a prefix match`, () => {
        expect(reposOf([`intentic-site/a.ts`], [`intentic`])).toEqual([`root`]);
    });
});

describe(`matching`, () => {
    test(`a moment that DOES things runs everything that matches, in the owner's order`, () => {
        const rules = [command(`lint`), command(`test`)];
        expect(matching(rules, `file.edited`).map((r) => r.id)).toEqual([`lint`, `test`]);
    });

    test(`a moment that DECIDES stops at the first match, so a narrow rule above a broad one means something`, () => {
        const rules = [verdict(`docs`, `allow`, { when: { paths: [`docs/**`] } }), verdict(`everything-else`, `hold`)];
        expect(matching(rules, `agent.finished`, { paths: [`docs/x.md`] }).map((r) => r.id)).toEqual([`docs`]);
        expect(matching(rules, `agent.finished`, { paths: [`src/x.ts`] }).map((r) => r.id)).toEqual([`everything-else`]);
    });

    test(`disabled rules and rules for another moment are not consulted`, () => {
        const rules = [command(`off`, { enabled: false }), verdict(`elsewhere`, `allow`), command(`on`)];
        expect(matching(rules, `file.edited`).map((r) => r.id)).toEqual([`on`]);
    });

    test(`an empty command is OFF, not a no-op run`, () => {
        const rules = [rule({ id: `blank`, moment: `file.edited`, action: { kind: `command`, command: `   `, timeoutMs: 900_000 } })];
        expect(matching(rules, `file.edited`)).toEqual([]);
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

    /* No check takes part in landing: checks run over the main tree after the work lands, and never hold it. A rule
       written while one could may still name the retired `checks-failed` outcome, which no finished turn has now. */
    test(`a rule naming the retired checks-failed outcome never matches, and the rest of the table decides`, () => {
        const holdsRed = verdict(`hold-red`, `hold`, { when: { outcome: [`checks-failed`] } });
        const landsAll = verdict(`land-everything`, `allow`);
        expect(landingVerdict([holdsRed, landsAll], { outcome: `clean` }, undefined)).toEqual({ land: true, rule: landsAll });
        expect(landingVerdict([holdsRed], { outcome: `clean` }, undefined)).toEqual({ land: false });
    });

    test(`nothing outranks the per-agent override any more, not even a rule about red work`, () => {
        const holdsRed = verdict(`hold-red`, `hold`, { when: { outcome: [`checks-failed`] } });
        expect(landingVerdict([holdsRed], { outcome: `clean` }, true)).toEqual({ land: true });
        expect(landingVerdict([verdict(`land-everything`, `allow`)], { outcome: `clean` }, true)).toEqual({ land: true });
    });

    // The outcome type still names it, so a caller's facts may too; they are decided like any others now.
    test(`facts still naming the retired checks-failed outcome are decided by the table and the override like any others`, () => {
        const facts = { outcome: `checks-failed` as const };
        expect(landingVerdict([verdict(`land-everything`, `allow`)], facts, undefined)).toEqual({
            land: true,
            rule: verdict(`land-everything`, `allow`),
        });
        expect(landingVerdict([], facts, true)).toEqual({ land: true });
        expect(landingVerdict([verdict(`hold-red`, `hold`, { when: { outcome: [`checks-failed`] } })], facts, undefined).rule?.id).toBe(`hold-red`);
    });

    test(`a clean turn is decided by the table and the override alone`, () => {
        expect(landingVerdict([verdict(`land-everything`, `allow`)], { outcome: `clean` }, undefined).land).toBe(true);
        expect(landingVerdict([verdict(`land-everything`, `allow`)], { outcome: `clean` }, false).land).toBe(false);
    });
});
