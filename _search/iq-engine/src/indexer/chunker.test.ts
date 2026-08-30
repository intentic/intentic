import { expect, test } from "vitest";
import { extractSymbols } from "./symbols.js";
import { chunkFile } from "./chunker.js";

const TS = `// Builds one widget.
export const createWidget = (name: string): { name: string } => ({ name });

export function reset(): void {}
`;

test("symbol-aligned chunks carry path § name prefix and the preceding doc line", () => {
    const symbols = extractSymbols("a/widget.ts", "ts", TS);
    const chunks = chunkFile("a/widget.ts", symbols, TS);
    const create = chunks.find((chunk) => chunk.text.includes("§ createWidget"));
    expect(create!.text).toContain("// Builds one widget.");
    expect(create!.startLine).toBe(1);
});

test("symbol-less files fall back to overlapping windows", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1} of documentation`).join("\n");
    const chunks = chunkFile("docs/guide.md", [], lines);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[0]!.startLine).toBe(1);
    expect(chunks[0]!.endLine - chunks[0]!.startLine).toBeLessThan(41);
    // Overlap: the second window starts before the first ends.
    expect(chunks[1]!.startLine).toBeLessThanOrEqual(chunks[0]!.endLine);
});

test("chunk hashes are stable across recomputation (embedding-reuse key)", () => {
    const symbols = extractSymbols("a/widget.ts", "ts", TS);
    const a = chunkFile("a/widget.ts", symbols, TS).map((chunk) => chunk.hash);
    const b = chunkFile("a/widget.ts", symbols, TS).map((chunk) => chunk.hash);
    expect(a).toEqual(b);
});

test("oversized symbol bodies split into bounded windows", () => {
    const body = `export function big(): void {\n${Array.from({ length: 300 }, (_, i) => `    const x${i} = ${i};`).join("\n")}\n}`;
    const symbols = extractSymbols("a/big.ts", "ts", body);
    const chunks = chunkFile("a/big.ts", symbols, body).filter((chunk) => chunk.text.includes("§ big"));
    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk fits the char cap (no oversized chunk).
    expect(chunks.every((chunk) => chunk.text.length <= 1200)).toBe(true);
});

test("a distinctive line deep inside a long function is present in some chunk's TEXT (no truncation loss)", () => {
    // Regression: a long body used to become ONE chunk truncated at 1200 chars, silently dropping, and leaving
    // unindexed: everything past ~25 lines. A marker at line ~60 must survive in an actual chunk body.
    const before = Array.from({ length: 55 }, (_, i) => `    const setup${i} = ${i};`).join("\n");
    const after = Array.from({ length: 40 }, (_, i) => `    const tail${i} = ${i};`).join("\n");
    const body = `export function big(): void {\n${before}\n    const NEEDLE_DEEP_IN_BODY = true;\n${after}\n}`;
    const symbols = extractSymbols("a/big.ts", "ts", body);
    const chunks = chunkFile("a/big.ts", symbols, body);
    expect(chunks.some((chunk) => chunk.text.includes("NEEDLE_DEEP_IN_BODY"))).toBe(true);
});
