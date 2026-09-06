import { describe, expect, it } from "vitest";
import { mergeMemory } from "./memoryImport";

const START = `<!-- intentic:imported-memory:start -->`;
const END = `<!-- intentic:imported-memory:end -->`;

describe(`mergeMemory`, () => {
    it(`writes a single block into an empty file`, () => {
        const result = mergeMemory(``, `I prefer TypeScript.`);
        expect(result).toBe(`${START}\n## Imported memory\n\nI prefer TypeScript.\n${END}\n`);
    });

    it(`appends the block below existing content, preserving it`, () => {
        const result = mergeMemory(`# Project notes\n\nBuild with pnpm.`, `I prefer TypeScript.`);
        expect(result).toBe(`# Project notes\n\nBuild with pnpm.\n\n${START}\n## Imported memory\n\nI prefer TypeScript.\n${END}\n`);
    });

    it(`replaces an existing block instead of duplicating it (idempotent re-import)`, () => {
        const first = mergeMemory(`# Notes\n`, `Old memory.`);
        const second = mergeMemory(first, `New memory.`);
        expect(second.match(new RegExp(START, `g`))).toHaveLength(1);
        expect(second).toContain(`New memory.`);
        expect(second).not.toContain(`Old memory.`);
        expect(second).toContain(`# Notes`);
    });

    it(`replaces from the start marker to EOF when the block is unterminated`, () => {
        const corrupted = `# Notes\n\n${START}\n## Imported memory\n\nhalf-written`;
        const result = mergeMemory(corrupted, `Recovered.`);
        expect(result).toBe(`# Notes\n\n${START}\n## Imported memory\n\nRecovered.\n${END}`);
        expect(result).not.toContain(`half-written`);
    });
});
