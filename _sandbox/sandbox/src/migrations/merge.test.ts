import { expect, test } from "vitest";
import { mergeFenced } from "./merge.js";

const ID = "intentic:imported-hermes:soul";

test("appends a fenced block to existing text and replaces it in place on re-merge", () => {
    const first = mergeFenced("# My notes\n", ID, "## Imported\n\nold");
    expect(first).toContain("# My notes");
    expect(first).toContain(`<!-- ${ID}:start -->`);
    expect(first).toContain("old");

    const second = mergeFenced(first, ID, "## Imported\n\nnew");
    expect(second).toContain("new");
    expect(second).not.toContain("old");
    // Replace, not append: exactly one fence pair survives.
    expect(second.split(`<!-- ${ID}:start -->`).length).toBe(2);
});

test("an empty file gets just the block, and hand-written text around a block is preserved", () => {
    expect(mergeFenced("", ID, "body")).toBe(`<!-- ${ID}:start -->\nbody\n<!-- ${ID}:end -->\n`);
    const surrounded = `before\n\n<!-- ${ID}:start -->\nx\n<!-- ${ID}:end -->\n\nafter\n`;
    const merged = mergeFenced(surrounded, ID, "y");
    expect(merged).toContain("before");
    expect(merged).toContain("after");
    expect(merged).toContain("y");
    expect(merged).not.toContain("\nx\n");
});

test("two different fence ids live side by side without touching each other", () => {
    const one = mergeFenced("", "intentic:imported-hermes:soul", "soul text");
    const both = mergeFenced(one, "intentic:imported-hermes:memory", "memory text");
    expect(both).toContain("soul text");
    expect(both).toContain("memory text");
    const replaced = mergeFenced(both, "intentic:imported-hermes:soul", "new soul");
    expect(replaced).toContain("new soul");
    expect(replaced).toContain("memory text");
});

test("an unterminated block is replaced to end of file rather than duplicated", () => {
    const corrupted = `notes\n\n<!-- ${ID}:start -->\ndangling`;
    const merged = mergeFenced(corrupted, ID, "fixed");
    expect(merged).toContain("notes");
    expect(merged).toContain("fixed");
    expect(merged).not.toContain("dangling");
    expect(merged).toContain(`<!-- ${ID}:end -->`);
});
