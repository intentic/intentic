import { describe, expect, test } from "vitest";
import { COMMAND_CLASS_LABELS, COMMAND_CLASS_PATTERNS } from "./command-classes.js";
import { COMMAND_RULE_CATALOG, DEFAULT_SAFETY_POLICY, hardRuleClasses } from "./safety-policy.js";
import { CommandClassSchema, CommandLocusSchema } from "../schemas/agent.js";

// The hard rule is the one thing on this page nobody can argue with, so it's pinned here rather than trusted to review:
// a class added silently is one an owner can never decide about for themselves.
describe("hardRuleClasses", () => {
    test("the sandbox holds one class, and the file argues for keeping it that way", () => {
        expect([...hardRuleClasses("sandbox")]).toEqual(["system.destructive"]);
    });

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

    test("the shipped policy names the sandbox's hard rule as the code holds it", () => {
        const hardRule = DEFAULT_SAFETY_POLICY.slice(DEFAULT_SAFETY_POLICY.indexOf("## The hard rule"));
        // Both loci, since they differ and a paragraph naming one reads as naming both.
        expect(hardRule).toContain("In this sandbox:");
        expect(hardRule).toContain("On my devices:");
        // The sandbox's three, as hardRuleClasses("sandbox") plus command-classes.ts's SANDBOX_ROOTS hold them.
        expect(hardRule).toContain("block device");
        expect(hardRule).toContain("/history");
        // And what it no longer claims: the sandbox floor no longer covers container volumes, now the judge's call.
        expect(DEFAULT_SAFETY_POLICY.slice(0, DEFAULT_SAFETY_POLICY.indexOf("## On my devices"))).toContain("docker volume rm");
    });
});

// The catalog the Safety page renders, so an owner can see what will interrupt them without reading the source; it only
// works if it can't fall behind the source.
describe("COMMAND_RULE_CATALOG", () => {
    test("every class appears exactly once", () => {
        expect(COMMAND_RULE_CATALOG.map((rule) => rule.commandClass).sort()).toEqual([...CommandClassSchema.options].sort());
    });

    test("each rule's tier is what the hard rule actually says, at each machine", () => {
        for (const rule of COMMAND_RULE_CATALOG) {
            for (const locus of CommandLocusSchema.options) {
                expect(rule.tiers[locus], `${locus}/${rule.commandClass}`).toBe(hardRuleClasses(locus).has(rule.commandClass) ? "hard" : "judged");
            }
        }
    });

    test("the rules nobody can waive come first", () => {
        const locked = COMMAND_RULE_CATALOG.map((rule) => CommandLocusSchema.options.filter((locus) => rule.tiers[locus] === "hard").length);
        expect(locked).toEqual([...locked].sort((left, right) => right - left));
    });

    test("every class says what it is and roughly what fires it", () => {
        for (const commandClass of CommandClassSchema.options) {
            expect(COMMAND_CLASS_LABELS[commandClass], commandClass).not.toBe("");
            expect(COMMAND_CLASS_PATTERNS[commandClass].length, commandClass).toBeGreaterThan(0);
        }
    });

    test("the highlightable half carries no prose", () => {
        // Whole shell words, not substrings: a shell's own word boundary is the discriminator (dd's of= isn't "of").
        const PROSE = new Set(["a", "an", "the", "in", "to", "of", "with", "and", "or", "aimed", "reference", "any", "when"]);
        for (const commandClass of CommandClassSchema.options) {
            for (const pattern of COMMAND_CLASS_PATTERNS[commandClass]) {
                const prose = pattern.code.split(/\s+/).filter((word) => PROSE.has(word.toLowerCase()));
                expect(prose, `${commandClass}: ${pattern.code}`).toEqual([]);
                expect(pattern.qualifier ?? "x", `${commandClass}: ${pattern.code}`).not.toBe("");
            }
        }
    });

    test("the two machines do not describe the same rule set", () => {
        const tiers = (locus: "sandbox" | "device") => COMMAND_RULE_CATALOG.map((rule) => rule.tiers[locus]).join(",");
        expect(tiers("sandbox")).not.toBe(tiers("device"));
    });
});
