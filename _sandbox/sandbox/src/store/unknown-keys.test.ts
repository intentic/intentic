import { z } from "zod";
import type { ManifestProblem } from "./manifest-problems.js";
import { nearestKey, objectParse, unknownKeyProblems } from "./unknown-keys.js";

const SETTINGS = [`stableSystemPrompt`, `skills`, `hashlineEdits`, `iqSearch`, `iqSearchHoldout`, `systemPromptMode`];

test("nearestKey finds a close match for a typo", () => {
    expect(nearestKey(`hashlineEdit`, SETTINGS)).toBe(`hashlineEdits`);
    expect(nearestKey(`HashlineEdits`, SETTINGS)).toBe(`hashlineEdits`);
});

test("nearestKey prefers the closer key when two are near", () => {
    expect(nearestKey(`hashlineEdi`, [`hashlineEdits`, `outputHoldout`])).toBe(`hashlineEdits`);
    expect(nearestKey(`iqSearchHoldou`, [`iqSearchHoldout`, `outputHoldout`])).toBe(`iqSearchHoldout`);
});

test("unknownKeyProblems is empty for a clean object", () => {
    expect(unknownKeyProblems({ hashlineEdits: true, skills: [`lsp`] }, SETTINGS)).toEqual([]);
});

test("unknownKeyProblems names a typo and its nearest key", () => {
    expect(unknownKeyProblems({ hashlineEdit: true }, SETTINGS)).toEqual([
        { kind: `unknownKey`, detail: `hashlineEdit`, suggestion: `hashlineEdits` },
    ]);
});

test("objectParse accepts known keys", () => {
    const Schema = z.object({ hashlineEdits: z.boolean().default(false), skills: z.array(z.string()).default([]) });
    const problems: ManifestProblem[] = [];
    const value = objectParse(Schema)({ hashlineEdits: true }, (problem) => problems.push(problem));
    expect(value).toEqual({ hashlineEdits: true, skills: [] });
    expect(problems).toEqual([]);
});

test("objectParse drops unknown keys and reports them", () => {
    const Schema = z.object({ hashlineEdits: z.boolean().default(false), skills: z.array(z.string()).default([]) });
    const problems: ManifestProblem[] = [];
    const value = objectParse(Schema)({ hashlineEdits: true, hashlineEdit: false }, (problem) => problems.push(problem));
    expect(value).toEqual({ hashlineEdits: true, skills: [] });
    expect(problems).toEqual([{ kind: `unknownKey`, detail: `hashlineEdit`, suggestion: `hashlineEdits` }]);
});

test("objectParse rejects a value of the wrong type", () => {
    const Schema = z.object({ hashlineEdits: z.boolean().default(false), skills: z.array(z.string()).default([]) });
    expect(objectParse(Schema)({ hashlineEdits: `not a boolean` }, () => {})).toBeUndefined();
});
