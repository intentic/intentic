// Inputs generated from a fixed seed, so a scenario's input is identical on every host and never tracks the checkout.

/** mulberry32: a uniform [0, 1) stream that is a pure function of `seed`. */
export const seeded = (seed: number): (() => number) => {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let mixed = state;
        mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
        mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
        return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
    };
};

export const pick = <T>(next: () => number, items: readonly T[]): T => items[Math.floor(next() * items.length)]!;

const WORDS = `agent sandbox turn record window stream frame session worktree branch review change path file tree index token
budget cursor event patch row tool call result state queue watch store cache digest range offset limit layer
scope route panel card`.split(/\s+/u);

export const words = (next: () => number, count: number): string => Array.from({ length: count }, () => pick(next, WORDS)).join(" ");

const camel = (next: () => number, parts: number): string =>
    Array.from({ length: parts }, (_, index) => {
        const word = pick(next, WORDS);
        return index === 0 ? word : `${word[0]!.toUpperCase()}${word.slice(1)}`;
    }).join("");

const GROUPS = ["_sandbox", "_editor", "_shared", "_tools", "_search", "_deploy", "_devices", "_platform", "_site", "_extensions"] as const;
const LEAVES = ["src", "src/lib", "src/features", "src/composables", "test", "scripts", "docs"] as const;
const EXTENSIONS = [".ts", ".ts", ".ts", ".vue", ".test.ts", ".md", ".json", ".mjs", ".css", ".d.ts"] as const;
// Directories a workspace walk meets and its ignore rules must answer for.
const NOISE = ["node_modules/.pnpm/zod@4.5.4/node_modules/zod", "dist", ".cache", ".turbo", "coverage", "out-tsc"] as const;

/** Root-relative, forward-slash file paths shaped like a monorepo, one in eight under a build or dependency directory. */
export const repoPaths = (seed: number, count: number): string[] => {
    const next = seeded(seed);
    return Array.from({ length: count }, (_, index) => {
        const pkg = `${pick(next, GROUPS)}/${pick(next, WORDS)}-${pick(next, WORDS)}`;
        const dir = next() < 0.125 ? pick(next, NOISE) : `${pick(next, LEAVES)}/${pick(next, WORDS)}`;
        return `${pkg}/${dir}/${camel(next, 2 + Math.floor(next() * 2))}-${index % 97}${pick(next, EXTENSIONS)}`;
    });
};

/** A TypeScript module of roughly `functions` exported functions, with the comment and literal forms a tokenizer walks. */
export const typescriptModule = (seed: number, functions: number): string => {
    const next = seeded(seed);
    const lines = ['import { readFile } from "node:fs/promises";', 'import type { Row } from "./rows.js";', ""];
    for (let index = 0; index < functions; index++) {
        const name = camel(next, 3);
        lines.push(`/** ${words(next, 8)}. */`);
        if (next() < 0.3) {
            lines.push(
                `export interface ${name[0]!.toUpperCase()}${name.slice(1)}Options {`,
                `    readonly ${camel(next, 2)}: number;`,
                `    readonly ${camel(next, 2)}?: string;`,
                "}",
            );
        }
        lines.push(`export const ${name} = async (rows: readonly Row[], limit = ${Math.floor(next() * 500)}): Promise<string[]> => {`);
        lines.push(`    // ${words(next, 10)}`);
        lines.push(`    const pattern = /^(?<head>[a-z]+)-(\\d{2,4})$/u;`);
        lines.push(`    const text = await readFile(\`\${rows.length}/${pick(next, WORDS)}.json\`, "utf8");`);
        lines.push(`    const out = rows.filter((row) => pattern.test(row.${camel(next, 2)}) && row.size < limit);`);
        if (next() < 0.4) {
            lines.push("    /*", `     * ${words(next, 12)}`, `     * ${words(next, 9)}`, "     */");
        }
        lines.push(`    return out.map((row) => \`\${row.id}: \${text.slice(0, ${Math.floor(next() * 80)})}\`); // ${words(next, 4)}`);
        lines.push("};", "");
    }
    return lines.join("\n");
};

/** `text` after a review-sized edit: every seventh function body gains a line, every eleventh comment is dropped. */
export const edited = (text: string): string =>
    text
        .split("\n")
        .flatMap((line, index) => {
            if (line.startsWith("    // ") && index % 11 === 0) {
                return [];
            }
            if (line.startsWith("    const out = ") && index % 7 === 0) {
                return [line, "    out.sort((left, right) => left.size - right.size); // stable order for the reader"];
            }
            return [line];
        })
        .join("\n");
