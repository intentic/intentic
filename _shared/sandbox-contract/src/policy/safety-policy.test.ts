import { describe, expect, test } from "vitest";
import { COMMAND_CLASS_LABELS, COMMAND_CLASS_PATTERNS } from "./command-classes.js";
import { COMMAND_RULE_CATALOG, DEFAULT_SAFETY_POLICY, hardRuleClasses } from "./safety-policy.js";
import { CommandClassSchema, CommandLocusSchema } from "../schemas/agent.js";

/* THE HARD RULE IS THE ONE THING ON THIS PAGE NOBODY CAN ARGUE WITH, so what is in it is worth pinning rather
 * than trusting to review: a class added here is a class an owner can never decide about for themselves, and
 * the argument for keeping the sandbox's set short only holds if something notices when it grows. */
describe("hardRuleClasses", () => {
    test("the sandbox holds one class, and the file argues for keeping it that way", () => {
        expect([...hardRuleClasses("sandbox")]).toEqual(["system.destructive"]);
    });

    /* A DEVICE HOLDS MORE, AND CHEAPLY. Out there the hard rule is friction over the machine's own scope
     * switches rather than standing in for them, so breadth costs a card and buys the "ask me" answer a scope
     * switch cannot express. It must stay a superset of the sandbox's: a rule the container will not waive and
     * a laptop will would be the wrong way round. */
    test("a device holds everything the sandbox does, and more", () => {
        for (const commandClass of hardRuleClasses("sandbox")) {
            expect(hardRuleClasses("device").has(commandClass), commandClass).toBe(true);
        }
        expect(hardRuleClasses("device").size).toBeGreaterThan(hardRuleClasses("sandbox").size);
    });

    test("every hard-ruled class is a real class", () => {
        for (const locus of CommandLocusSchema.options) {
            for (const commandClass of hardRuleClasses(locus)) {
                expect(CommandClassSchema.options, `${locus}/${commandClass}`).toContain(commandClass);
            }
        }
    });

    /* THE GAP THIS CHANGE CLOSED, kept closed. The shipped policy told owners the hard rule was two things
     * while the code enforced the whole of system.destructive — including every docker volume command — so a
     * reader following the document could not predict the card they got. The document is what an owner reads
     * and the judge is prompted with, so a divergence here is not a doc bug, it is the judge being briefed
     * against the rule it is working under. */
    test("the shipped policy names the sandbox's hard rule as the code holds it", () => {
        const hardRule = DEFAULT_SAFETY_POLICY.slice(DEFAULT_SAFETY_POLICY.indexOf("## The hard rule"));
        // Both loci, because they differ and a paragraph naming one of them reads as naming both.
        expect(hardRule).toContain("In this sandbox:");
        expect(hardRule).toContain("On my devices:");
        // The sandbox's three, as hardRuleClasses("sandbox") + command-classes.ts SANDBOX_ROOTS hold them.
        expect(hardRule).toContain("block device");
        expect(hardRule).toContain("/history");
        /* AND WHAT IT NO LONGER CLAIMS. The paragraph used to promise a rule the code did not implement; the
         * one thing it must not do again is describe the sandbox's floor as covering container volumes, which
         * is now the judge's call here and is said so in the sandbox section instead. */
        expect(DEFAULT_SAFETY_POLICY.slice(0, DEFAULT_SAFETY_POLICY.indexOf("## On my devices"))).toContain("docker volume rm");
    });
});

/* THE CATALOG THE SAFETY PAGE RENDERS. It exists so an owner can see what will interrupt them without reading
 * the source, which only works if it cannot fall behind the source. */
describe("COMMAND_RULE_CATALOG", () => {
    /* EXACTLY ONCE, and this is the claim the catalog was reshaped to make true. While it was a list per locus
     * the panel had to slice it by tier to be readable, and a class hard on a laptop and judged in the container
     * came out under both headings with the same patterns under it — three of the seven did. One entry per
     * class, carrying both machines' answers, is what leaves the duplication nowhere to come from. */
    test("every class appears exactly once", () => {
        expect(COMMAND_RULE_CATALOG.map((rule) => rule.commandClass).sort()).toEqual([...CommandClassSchema.options].sort());
    });

    // The tier is the whole reason a reader opens the panel, so it has to be the gate's own answer rather than
    // a second opinion about it.
    test("each rule's tier is what the hard rule actually says, at each machine", () => {
        for (const rule of COMMAND_RULE_CATALOG) {
            for (const locus of CommandLocusSchema.options) {
                expect(rule.tiers[locus], `${locus}/${rule.commandClass}`).toBe(hardRuleClasses(locus).has(rule.commandClass) ? "hard" : "judged");
            }
        }
    });

    /* THE READING ORDER IS THE ANSWER TO "CAN I CHANGE THIS?", now that the tier is no longer an axis the list
     * is split on. Most-locked first, so somebody about to write a policy line meets the rules no line can
     * reach before they spend time on one. */
    test("the rules nobody can waive come first", () => {
        const locked = COMMAND_RULE_CATALOG.map((rule) => CommandLocusSchema.options.filter((locus) => rule.tiers[locus] === "hard").length);
        expect(locked).toEqual([...locked].sort((left, right) => right - left));
    });

    /* A CLASS ADDED TO THE ENUM WITHOUT A LINE FOR A PERSON FAILS HERE, which is the point of pinning it: the
     * failure mode without this is a new rule that silently interrupts people with nothing on the page saying
     * it exists. */
    test("every class says what it is and roughly what fires it", () => {
        for (const commandClass of CommandClassSchema.options) {
            expect(COMMAND_CLASS_LABELS[commandClass], commandClass).not.toBe("");
            expect(COMMAND_CLASS_PATTERNS[commandClass].length, commandClass).toBeGreaterThan(0);
        }
    });

    /* THE FRAGMENT IS CODE AND THE QUALIFIER IS PROSE, and the page hands only the first half to a syntax
     * highlighter. A sentence smuggled into `code` gets tokenized as shell — `rm -rf aimed at a root directory`
     * colours `aimed`, `at` and `a` as arguments — which is exactly the mush this split exists to end, and it
     * would go unnoticed because it still renders. A shell fragment is short and has no prose tail: nothing
     * here needs an article. */
    test("the highlightable half carries no prose", () => {
        /* Asked of WHOLE SHELL WORDS rather than of substrings, because the discriminator really is the word
         * boundary a shell uses: `of=/dev/…` is dd's output operand and `of` inside it is not the preposition,
         * while `aimed at a root directory` is four bare words in a row. Splitting on whitespace is how a shell
         * itself tells those apart. */
        const PROSE = new Set(["a", "an", "the", "in", "to", "of", "with", "and", "or", "aimed", "reference", "any", "when"]);
        for (const commandClass of CommandClassSchema.options) {
            for (const pattern of COMMAND_CLASS_PATTERNS[commandClass]) {
                const prose = pattern.code.split(/\s+/).filter((word) => PROSE.has(word.toLowerCase()));
                expect(prose, `${commandClass}: ${pattern.code}`).toEqual([]);
                expect(pattern.qualifier ?? "x", `${commandClass}: ${pattern.code}`).not.toBe("");
            }
        }
    });

    // The two machines differ, and the panel draws both answers side by side: a catalog that answered the same
    // at each locus would mean the split had been undone somewhere.
    test("the two machines do not describe the same rule set", () => {
        const tiers = (locus: "sandbox" | "device") => COMMAND_RULE_CATALOG.map((rule) => rule.tiers[locus]).join(",");
        expect(tiers("sandbox")).not.toBe(tiers("device"));
    });
});
