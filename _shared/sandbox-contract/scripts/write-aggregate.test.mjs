import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { departures, rewritten, subjects } from "./write-aggregate.mjs";

const INDEX = new URL("../src/index.ts", import.meta.url);

test("index.ts mounts every contract in src/contracts but the ones served the other way", () => {
    assert.deepEqual(departures(readFileSync(INDEX, "utf8"), subjects()), [], "run `node scripts/write-aggregate.mjs` in _shared/sandbox-contract");
});

test("names a contract the aggregate misses, and writes it back in name order", () => {
    const text = [
        `import { z } from "zod";`,
        `import { usageContract } from "./contracts/usage.contract.js";`,
        `import { agentsContract } from "./contracts/agents.contract.js";`,
        ``,
        `export const sandboxContract = {`,
        `    usage: usageContract,`,
        `    agents: agentsContract,`,
        `};`,
        ``,
    ].join("\n");
    const stems = ["agents", "local-models", "usage"];
    assert.deepEqual(departures(text, stems), ["missing  localModels: localModelsContract", "missing  localModelsContract local-models"]);
    const written = rewritten(text, stems);
    assert.equal(
        written,
        [
            `import { z } from "zod";`,
            `import { agentsContract } from "./contracts/agents.contract.js";`,
            `import { localModelsContract } from "./contracts/local-models.contract.js";`,
            `import { usageContract } from "./contracts/usage.contract.js";`,
            ``,
            `export const sandboxContract = {`,
            `    agents: agentsContract,`,
            `    localModels: localModelsContract,`,
            `    usage: usageContract,`,
            `};`,
            ``,
        ].join("\n"),
    );
    assert.deepEqual(departures(written, stems), []);
});
