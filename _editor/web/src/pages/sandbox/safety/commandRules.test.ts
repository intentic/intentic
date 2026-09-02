// THE CLAIM THIS PAGE RESTS ON: what the control offers is what the gate actually does. `commandRules` is
// enforced in sandbox/src/guard/actions.ts `commandRun`, and the two facts that decide are not in the schema —
// they are `rule === undefined` branches inside that function. A picker that folded absence into "allow" would
// be a control that quietly disarmed two floors while claiming to change nothing, and nothing in the type
// system would have noticed.
//
// So what is pinned here is the mapping in both directions, plus the parts of `commandRun` this module's prose
// makes promises about. The prose is the product here: a wrong sentence under a row is the failure mode, not a
// crash, and the only way to catch one is to check it against the enum and the floor set the daemon reads.
//
// A plain module test, no mount: the mapping is the subject and it is pure. The components on top of it are
// markup over these four functions.
import { CommandClassSchema, FLOOR_CLASSES, type AdmissionRule, type CommandClass } from "@intentic/sandbox-contract";
import { SandboxSettingsSchema } from "@intentic-app/api-contract";
import { expect, test } from "vitest";
import { COMMAND_RULE_ROWS, postureNote, postureOf, postureOptions, withPosture } from "./commandRules";

// EVERY class gets a row, and no row invents one. A class added to the contract without a row here would be a
// rule the daemon enforces and this page silently omits, which is the specific way a safety page goes stale.
test(`covers exactly the contract's command classes`, () => {
    expect(COMMAND_RULE_ROWS.map((row) => row.commandClass).sort()).toEqual([...CommandClassSchema.options].sort());
});

// The absent key is its own posture. Folding it into `allow` is the bug this module exists to prevent.
test(`an unset class reads as Default, never as allow`, () => {
    expect(postureOf({}, `files.destructive`)).toBe(`default`);
    expect(postureOf(undefined, `system.destructive`)).toBe(`default`);
    expect(postureOf({ "files.destructive": `allow` }, `files.destructive`)).toBe(`allow`);
});

// …and the write side of the same fact: choosing Default DELETES the key. Storing a fourth value would be a
// verdict the schema rejects; storing `allow` would disarm the floors below while the row read "Default".
test(`Default deletes the key rather than storing a verdict`, () => {
    const rules = withPosture({ "files.destructive": `hold`, "git.destructive": `deny` }, `files.destructive`, `default`);
    expect(rules).toEqual({ "git.destructive": `deny` });
    expect(`files.destructive` in rules).toBe(false);
    // What is written is still a valid rulebook: the daemon parses our POST against its own copy of the schema,
    // and a key it cannot parse is dropped in silence.
    expect(SandboxSettingsSchema.parse({ commandRules: rules }).commandRules).toEqual({ "git.destructive": `deny` });
});

test(`setting a posture leaves every other class alone`, () => {
    expect(withPosture({ "git.destructive": `deny` }, `network.outbound`, `hold`)).toEqual({
        "git.destructive": `deny`,
        "network.outbound": `hold`,
    });
});

// Each verdict the picker offers is one the schema takes. A label the daemon would reject is a control that
// looks like it works and is undone by the next reconcile.
test(`every non-default option is a verdict the schema accepts`, () => {
    const offered = postureOptions(COMMAND_RULE_ROWS[0]!)
        .map((option) => option.value)
        .filter((value): value is AdmissionRule => value !== `default`);
    expect(offered).toEqual([`allow`, `hold`, `deny`]);
    for (const rule of offered) {
        expect(SandboxSettingsSchema.parse({ commandRules: { "git.destructive": rule } }).commandRules).toEqual({ "git.destructive": rule });
    }
});

// The Default option is not one sentence: it is the row's own, because the branch it describes differs per
// class. A shared string here would be right on three rows and wrong on three.
test(`the Default option wears each row's own resolution`, () => {
    for (const row of COMMAND_RULE_ROWS) {
        expect(postureOptions(row).find((option) => option.value === `default`)?.hint).toBe(row.whenDefault);
    }
});

/* THE FLOOR CLASS SAYS IT ASKS. `system.destructive` is held where the owner wrote nothing (contract
 * FLOOR_CLASSES, read by `commandRun`), so its Default sentence is the one that must not say "runs" — a green
 * reading of a gate that is closed sends someone to set a rule they already have. Asserted against the contract's
 * own set rather than against the string `system.destructive`, so promoting a second class to the floor fails
 * here instead of shipping a row that lies about it. */
test(`a floor class's Default sentence says it asks`, () => {
    const floored = COMMAND_RULE_ROWS.filter((row) => FLOOR_CLASSES.has(row.commandClass));
    expect(floored.length).toBe(FLOOR_CLASSES.size);
    for (const row of floored) {
        expect(row.whenDefault).toMatch(/asks/i);
        // Nothing is given up by allowing it beyond the floor itself, which the picker's own `allow` hint says.
        expect(row.allowCost).toBeUndefined();
    }
});

/* THE TAINT CLASSES CARRY A COST FOR LEAVING DEFAULT, and they are the only ones that do. `commandRun`'s taint
 * floor is `files.destructive` OR (`secrets.access` AND the command also leaves), both written
 * `rule === undefined && …`, so an explicit `allow` on either switches a hold off. This is the single fact on
 * the page that a user cannot recover from anywhere else in the product, so it is pinned as an exact set:
 * a row that grows a floor without growing a sentence, or keeps a sentence after losing its floor, fails here. */
const TAINTED: readonly CommandClass[] = [`files.destructive`, `secrets.access`];

test(`only the taint-floor classes warn about what Always allow gives up`, () => {
    expect(COMMAND_RULE_ROWS.filter((row) => row.allowCost !== undefined).map((row) => row.commandClass)).toEqual(TAINTED);
});

test(`choosing Always allow on a taint class raises a warning note, and elsewhere raises nothing`, () => {
    for (const row of COMMAND_RULE_ROWS) {
        const note = postureNote(row, `allow`);
        expect(note === undefined).toBe(!TAINTED.includes(row.commandClass));
        expect(note?.warn ?? true).toBe(true);
    }
});

// Default always explains itself, and does it quietly: it is the row's state, not a fault.
test(`Default always shows its resolution, in mute ink`, () => {
    for (const row of COMMAND_RULE_ROWS) {
        expect(postureNote(row, `default`)).toEqual({ text: row.whenDefault, warn: false });
    }
});

// Ask and Never say themselves — the pill IS the whole story — so they add no line. Six rows that each grew a
// paragraph would be the thing that stops this page being scannable.
test(`Ask me and Never add no line under the row`, () => {
    for (const row of COMMAND_RULE_ROWS) {
        expect(postureNote(row, `hold`)).toBeUndefined();
        expect(postureNote(row, `deny`)).toBeUndefined();
    }
});
