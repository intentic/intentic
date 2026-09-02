// What the control offers has to be what the gate does. The two facts that decide are not in the schema: they
// are `rule === undefined` branches in sandbox/src/guard/actions.ts, so a picker that folded absence into
// "allow" would disarm two floors while claiming to change nothing, and no type would have caught it.
import { CommandClassSchema, FLOOR_CLASSES, type AdmissionRule } from "@intentic/sandbox-contract";
import { SandboxSettingsSchema } from "@intentic-app/api-contract";
import { expect, test } from "vitest";
import { COMMAND_RULE_ROWS, postureOf, postureOptions, withPosture } from "./commandRules";

// A class added to the contract without a row here is a rule the daemon enforces and this page omits.
test(`covers exactly the contract's command classes`, () => {
    expect(COMMAND_RULE_ROWS.map((row) => row.commandClass).sort()).toEqual([...CommandClassSchema.options].sort());
});

test(`an unset class reads as Default, never as allow`, () => {
    expect(postureOf({}, `files.destructive`)).toBe(`default`);
    expect(postureOf(undefined, `system.destructive`)).toBe(`default`);
    expect(postureOf({ "files.destructive": `allow` }, `files.destructive`)).toBe(`allow`);
});

test(`Default deletes the key rather than storing a verdict`, () => {
    const rules = withPosture({ "files.destructive": `hold`, "git.destructive": `deny` }, `files.destructive`, `default`);
    expect(rules).toEqual({ "git.destructive": `deny` });
    // Still a rulebook the daemon parses: it validates our POST against its own copy and drops what it can't.
    expect(SandboxSettingsSchema.parse({ commandRules: rules }).commandRules).toEqual({ "git.destructive": `deny` });
});

test(`setting a posture leaves every other class alone`, () => {
    expect(withPosture({ "git.destructive": `deny` }, `network.outbound`, `hold`)).toEqual({
        "git.destructive": `deny`,
        "network.outbound": `hold`,
    });
});

// A label the daemon would reject is a control that looks live and is undone by the next reconcile.
test(`every non-default option is a verdict the schema accepts`, () => {
    const offered = postureOptions(COMMAND_RULE_ROWS[0]!)
        .map((option) => option.value)
        .filter((value): value is AdmissionRule => value !== `default`);
    expect(offered).toEqual([`allow`, `hold`, `deny`]);
    for (const rule of offered) {
        expect(SandboxSettingsSchema.parse({ commandRules: { "git.destructive": rule } }).commandRules).toEqual({ "git.destructive": rule });
    }
});

// Default is annotated per row, because the branch it describes differs per row.
test(`Default is annotated with the row's own resolution`, () => {
    for (const row of COMMAND_RULE_ROWS) {
        expect(postureOptions(row).find((option) => option.value === `default`)?.description).toBe(row.whenDefault);
    }
});

/* The floor class is held where the owner wrote nothing, so its annotation must not read "runs". Asserted
 * against the contract's own set, so promoting a second class to the floor fails here rather than shipping a
 * row that lies about it. */
test(`a floor class's Default annotation says it asks`, () => {
    const floored = COMMAND_RULE_ROWS.filter((row) => FLOOR_CLASSES.has(row.commandClass));
    expect(floored.length).toBe(FLOOR_CLASSES.size);
    for (const row of floored) {
        expect(row.whenDefault).toMatch(/asks/i);
    }
});

// The taint floor holds recursive deletes, and credential reads that also leave, in a turn that has taken in
// outside content — only where no rule is set. Those two rows are the ones whose Default is conditional.
test(`the taint-floor classes say their Default is conditional`, () => {
    for (const row of COMMAND_RULE_ROWS) {
        const conditional = row.commandClass === `files.destructive` || row.commandClass === `secrets.access`;
        expect(row.whenDefault.includes(`asks`) && row.whenDefault.includes(`runs`)).toBe(conditional);
    }
});
