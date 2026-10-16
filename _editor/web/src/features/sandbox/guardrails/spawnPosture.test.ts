// Pins that the posture (`agents.spawn`) writes into the shared `actionRules` record without clobbering other keys
// (the outbound gates' `<service>.<action>` rules, which Guardrails sets beside it), and what each posture means.
import { postureOf, postures, SPAWN_KEY, withPosture } from "./spawnPosture";

// Checked directly against `withPosture`, not through <Picker>: jsdom never opens the overlay to click through.

test("writing the posture keeps every other action rule", () => {
    // `slack.message` stands in for the outbound sniffer's own keys, sharing the same `actionRules` record.
    expect(withPosture({ "slack.message": `hold` }, `deny`)).toEqual({ "slack.message": `hold`, "agents.spawn": `deny` });
});

test("returning to Default removes the rule instead of writing one", () => {
    const rules = withPosture({ "agents.spawn": `deny`, "slack.message": `hold` }, `default`);

    expect(rules).toEqual({ "slack.message": `hold` });
    expect(SPAWN_KEY in rules).toBe(false);
});

test("an absent rule reads back as Default, not as allow", () => {
    expect(postureOf({})).toBe(`default`);
    expect(postureOf({ "agents.spawn": `allow` })).toBe(`allow`);
});

// Checked against the exported `postures()` list, not the rendered row: <Picker> draws options into an overlay
// jsdom never opens.
test("offers exactly the four postures, and Default is one of them", () => {
    expect(postures().map((option) => option.value)).toEqual([`default`, `allow`, `hold`, `deny`]);
});

test("puts Default first and says what it actually does", () => {
    const fallback = postures()[0];

    expect(fallback?.value).toBe(`default`);
    // Guards that the outside-content nuance is described on this option, not filed elsewhere.
    expect(fallback?.description).toContain(`outside content`);
});

test("every posture round-trips through the write", () => {
    for (const option of postures()) {
        const rules = withPosture({}, option.value);
        expect(postureOf(rules), option.value).toBe(option.value);
    }
});

test("leaves the rules it was given alone", () => {
    const before = { "agents.spawn": `hold` } as const;
    withPosture(before, `deny`);

    expect(before).toEqual({ "agents.spawn": `hold` });
});
