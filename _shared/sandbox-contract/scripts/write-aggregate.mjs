#!/usr/bin/env node
// The `sandboxContract` aggregate in src/index.ts, derived from src/contracts/*.contract.ts: each `<subject>.contract.ts`
// exporting `<subject>Contract` is mounted under `<subject>`, apart from the contracts served the other way round.
//
//   node scripts/write-aggregate.mjs --check   exit 1 when index.ts mounts a different set of contracts
//   node scripts/write-aggregate.mjs           rewrite index.ts's contract imports and the aggregate, in name order
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SOURCE = new URL("../src/", import.meta.url);
const INDEX = new URL("index.ts", SOURCE);

// Served by a machine, the browser extension, the phone app and a runner, with the daemon as the client.
export const INVERSE = new Set(["device", "phone", "runner", "webext"]);

const IMPORT = /^import \{ (\w+) \} from "\.\/contracts\/([\w-]+)\.contract\.js";\n/gm;
const AGGREGATE = /^export const sandboxContract = \{\n([\s\S]*?)^\};\n/m;
const ENTRY = /^ {4}([\w$]+): (\w+),$/gm;

const camel = (stem) => stem.replace(/-(\w)/g, (_, letter) => letter.toUpperCase());

// Every subject the aggregate mounts, in name order.
export const subjects = (contracts = join(fileURLToPath(SOURCE), "contracts")) =>
    readdirSync(contracts)
        .filter((name) => name.endsWith(".contract.ts"))
        .map((name) => name.slice(0, -".contract.ts".length))
        .filter((stem) => !INVERSE.has(stem))
        .toSorted();

// What index.ts mounts today: each key with the binding it names, and each contract it imports.
export const mounted = (text) => {
    const body = AGGREGATE.exec(text)?.[1];
    if (body === undefined) {
        throw new Error("src/index.ts has no `export const sandboxContract = {…};` block");
    }
    return {
        entries: [...body.matchAll(ENTRY)].map(([, key, binding]) => `${key}: ${binding}`).toSorted(),
        imports: [...text.matchAll(IMPORT)].map(([, binding, stem]) => `${binding} ${stem}`).toSorted(),
    };
};

// What the aggregate should mount, in the same form as `mounted`.
export const expected = (stems) => ({
    entries: stems.map((stem) => `${camel(stem)}: ${camel(stem)}Contract`).toSorted(),
    imports: stems.map((stem) => `${camel(stem)}Contract ${stem}`).toSorted(),
});

// index.ts with its contract imports in one sorted run where the first stood, and the aggregate's entries sorted.
export const rewritten = (text, stems) => {
    const imports = stems.map((stem) => `import { ${camel(stem)}Contract } from "./contracts/${stem}.contract.js";\n`).join("");
    const first = text.search(IMPORT);
    const without = text.replace(IMPORT, "");
    const placed = first === -1 ? `${imports}${without}` : `${without.slice(0, first)}${imports}${without.slice(first)}`;
    const entries = stems.map((stem) => `    ${camel(stem)}: ${camel(stem)}Contract,\n`).join("");
    return placed.replace(AGGREGATE, `export const sandboxContract = {\n${entries}};\n`);
};

const differences = (have, want) => [
    ...want.filter((line) => !have.includes(line)).map((line) => `missing  ${line}`),
    ...have.filter((line) => !want.includes(line)).map((line) => `extra    ${line}`),
];

// Each line by which index.ts's aggregate departs from the contracts directory; none when it mounts exactly them.
export const departures = (text, stems) => {
    const have = mounted(text);
    const want = expected(stems);
    return [...differences(have.entries, want.entries), ...differences(have.imports, want.imports)];
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const text = readFileSync(INDEX, "utf8");
    const stems = subjects();
    if (process.argv.includes("--check")) {
        const found = departures(text, stems);
        if (found.length > 0) {
            console.error(`src/index.ts's sandboxContract does not mount src/contracts/*.contract.ts:\n  ${found.join("\n  ")}`);
            process.exitCode = 1;
        } else {
            console.log(`sandboxContract mounts all ${stems.length} contracts (${INVERSE.size} served the other way left out)`);
        }
    } else {
        writeFileSync(INDEX, rewritten(text, stems));
        console.log(`src/index.ts: sandboxContract mounts ${stems.length} contracts`);
    }
}
