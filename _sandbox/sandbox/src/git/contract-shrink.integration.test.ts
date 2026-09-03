import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitRunner } from "@intentic/scaffold";
import { afterEach, expect, test } from "vitest";
import { lockShrinkage, shrunkSurfaces } from "@intentic/constants/contract-shrink";
import { claimedContractShrink } from "./contract-shrink.js";

/* The gate's own judgments (_tools/checks/contract-shrink.mjs reads the same module): the drafter and the gate must
 * call the same shapes shrunk, or a draft this module declared clean is a push that gate still refuses. */

test("a property removed is named by its dotted path", () => {
    const base = { AgentSchema: { properties: { body: { type: `string` }, id: { type: `string` } } } };
    const head = { AgentSchema: { properties: { id: { type: `string` } } } };
    expect(shrunkSurfaces(base, head)).toEqual([`AgentSchema.properties.body`]);
});

test("growth is not a shrink: new properties, new enum values and new oneOf variants all pass in silence", () => {
    const base = { A: { enum: [`one`], oneOf: [{ kind: `x` }] } };
    const head = { A: { enum: [`one`, `two`], oneOf: [{ kind: `x` }, { kind: `y` }], added: true } };
    expect(shrunkSurfaces(base, head)).toEqual([]);
});

test("a oneOf variant that lost a field reads as removed even when the collection reordered", () => {
    // The lock keeps arrays in declaration order, so position means nothing: the variant must be OFFERED
    // somewhere in head, not sitting at the same index.
    const base = { A: { oneOf: [{ kind: `a` }, { kind: `b`, extra: { type: `boolean` } }] } };
    const head = { A: { oneOf: [{ kind: `b` }, { kind: `a` }] } };
    expect(shrunkSurfaces(base, head)).toEqual([`A.oneOf[1]`]);
});

test("a type that changed reads as removed: the same verdict either way", () => {
    expect(shrunkSurfaces({ A: { type: `string` } }, { A: { type: `number` } })).toEqual([`A.type`]);
});

test("a whole schema gone is one removal, not one per leaf", () => {
    expect(shrunkSurfaces({ A: { type: `string` }, B: { type: `number` } }, { A: { type: `string` } })).toEqual([`B`]);
});

test("re-worded prose is not a shrink: a description that changed, or went entirely, passes in silence", () => {
    expect(shrunkSurfaces({ A: { description: `old wording`, type: `string` } }, { A: { description: `new wording`, type: `string` } })).toEqual([]);
    expect(shrunkSurfaces({ A: { description: `gone`, type: `string` } }, { A: { type: `string` } })).toEqual([]);
    expect(shrunkSurfaces({ A: { properties: { body: { description: `old` } } } }, { A: { properties: { body: { description: `new` } } } })).toEqual([]);
});

test("a FIELD named description is still a surface: prose is skipped only where a key is a keyword", () => {
    const base = { A: { properties: { description: { type: `string` }, title: { type: `string` } }, type: `object` } };
    const head = { A: { properties: { title: { type: `string` } }, type: `object` } };
    expect(shrunkSurfaces(base, head)).toEqual([`A.properties.description`]);
    // …and its own type still counts, reached through the name map rather than skipped as a keyword.
    expect(shrunkSurfaces(base, { A: { properties: { description: { type: `number` }, title: { type: `string` } }, type: `object` } })).toEqual([
        `A.properties.description.type`,
    ]);
});

test("a top-level schema named description is a surface too: the lock's root is a name map", () => {
    expect(shrunkSurfaces({ description: { type: `string` } }, {})).toEqual([`description`]);
});

test("lockShrinkage reads the two texts and never throws on a lock that is not JSON", () => {
    expect(lockShrinkage(`{"A":{"enum":["x","y"]}}`, `{"A":{"enum":["x"]}}`)).toEqual([`A.enum "y"`]);
    expect(lockShrinkage(`not json`, `{}`)).toEqual([]);
    expect(lockShrinkage(`{}`, `not json`)).toEqual([]);
});

const roots: string[] = [];
afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// A fake runner standing in for `git show HEAD:<path>`: the only call the detector makes.
const gitShowing =
    (locks: Record<string, string>): GitRunner =>
    (_dir, args) => {
        const path = String(args[1] ?? ``).replace(/^HEAD:/, ``);
        const lock = locks[path];
        return lock === undefined ? Promise.reject(new Error(`no such blob`)) : Promise.resolve({ stdout: lock, stderr: `` });
    };

test("claimedContractShrink compares only lock files among the claimed paths, worktree against HEAD", async () => {
    const dir = await mkdtemp(join(tmpdir(), `shrink-`));
    roots.push(dir);
    await writeFile(join(dir, `contract.lock.json`), `{"A":{"properties":{"id":{"type":"string"}}}}`);
    const git = gitShowing({ "contract.lock.json": `{"A":{"properties":{"id":{"type":"string"},"body":{"type":"string"}}}}` });
    expect(await claimedContractShrink(dir, [`src/other.ts`, `contract.lock.json`], git)).toEqual([`A.properties.body`]);
});

test("claimedContractShrink stays silent for a lock that is new at HEAD, unreadable, or merely grown", async () => {
    const dir = await mkdtemp(join(tmpdir(), `shrink-`));
    roots.push(dir);
    await writeFile(join(dir, `contract.lock.json`), `{"A":{"type":"string"},"B":{"type":"number"}}`);
    // New at HEAD: `git show` has no blob to offer, so there is nothing a commit could be removing.
    expect(await claimedContractShrink(dir, [`contract.lock.json`], gitShowing({}))).toEqual([]);
    // Grown: HEAD had less, the tree has more.
    expect(await claimedContractShrink(dir, [`contract.lock.json`], gitShowing({ "contract.lock.json": `{"A":{"type":"string"}}` }))).toEqual([]);
    // Claimed but missing from the tree: the contract-lock test's failure to report, not this draft's.
    expect(await claimedContractShrink(dir, [`missing/contract.lock.json`], gitShowing({ "missing/contract.lock.json": `{}` }))).toEqual([]);
});
