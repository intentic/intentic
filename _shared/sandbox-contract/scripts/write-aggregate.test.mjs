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
            `export const sandboxContract: {`,
            `    agents: typeof agentsContract;`,
            `    localModels: typeof localModelsContract;`,
            `    usage: typeof usageContract;`,
            `} = {`,
            `    agents: agentsContract,`,
            `    localModels: localModelsContract,`,
            `    usage: usageContract,`,
            `};`,
            ``,
        ].join("\n"),
    );
    assert.deepEqual(departures(written, stems), []);
});

test("updates the annotation and value together when a typed aggregate adds and removes contracts", () => {
    const text = [
        `import { usageContract } from "./contracts/usage.contract.js";`,
        ``,
        `export const sandboxContract: {`,
        `    usage: typeof usageContract;`,
        `} = {`,
        `    usage: usageContract,`,
        `};`,
        ``,
        `export const untouched = true;`,
        ``,
    ].join("\n");
    const stems = ["agents"];
    assert.deepEqual(departures(text, stems), [
        "missing  agents: agentsContract",
        "extra    usage: usageContract",
        "missing  agentsContract agents",
        "extra    usageContract usage",
    ]);
    const written = rewritten(text, stems);
    assert.equal(
        written,
        [
            `import { agentsContract } from "./contracts/agents.contract.js";`,
            ``,
            `export const sandboxContract: {`,
            `    agents: typeof agentsContract;`,
            `} = {`,
            `    agents: agentsContract,`,
            `};`,
            ``,
            `export const untouched = true;`,
            ``,
        ].join("\n"),
    );
    assert.deepEqual(departures(written, stems), []);
    assert.equal(rewritten(written, stems), written);
});
