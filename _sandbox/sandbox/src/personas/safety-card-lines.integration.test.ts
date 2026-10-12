import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { DEFAULT_SAFETY_POLICY } from "@intentic/sandbox-contract";
import pino from "pino";
import { clearNewestRun } from "../store/newest-run.js";
import { convergeState, resetStateStatus, type StateRoots } from "../store/evolution/state-convergence.js";
import { LEGACY_ADDED_HEADING, LEGACY_ADDED_NOTE } from "../safety/safety-policy-store.js";
import { fileOwnerGrants, ownerGrantsDocument } from "./owner-grants.js";
import { safetyCardLinesStep } from "./safety-card-lines.js";

// A sandbox updated past the move keeps every line its owner accepted on a card: now an owner-wide grant, listed and taken
// back under Access, out of the file an agent edits. Once, so a section written into the file later stays plain text.

const logger = pino({ level: "silent" });
const made: string[] = [];

const volumes = async (): Promise<StateRoots> => {
    const base = await mkdtemp(join(tmpdir(), "safety-card-lines-"));
    made.push(base);
    const roots = { workspace: join(base, "work"), history: join(base, "history"), auth: join(base, "auth") };
    await Promise.all(Object.values(roots).map((root) => mkdir(root, { recursive: true })));
    return roots;
};

afterEach(async () => {
    clearNewestRun();
    resetStateStatus();
    await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const converge = (roots: StateRoots) => convergeState({ roots, version: "1.400.0", logger, mayWrite: true, documents: [], steps: [safetyCardLinesStep] });

const policyPath = (roots: StateRoots): string => join(roots.workspace, STATE_DIR, "config", "safety.md");
const grantsPath = (roots: StateRoots): string => join(roots.auth, ownerGrantsDocument.path);
const put = async (path: string, text: string): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
};
const lineSection = (...lines: string[]): string => [LEGACY_ADDED_HEADING, ``, LEGACY_ADDED_NOTE, ``, ...lines.map((line) => `- ${line}`), ``].join(`\n`);
const trashed = async (roots: StateRoots): Promise<string[]> => (await readdir(join(roots.history, "trash"))).toSorted();

test("the lines accepted on cards become owner-wide grants, leave the owner's file, and the file as it stood is kept in the trash", async () => {
    const roots = await volumes();
    const owner = `## In this sandbox\n\nOrdinary work is fine.\n\n${lineSection(`Deleting build directories under /work is fine.`, `Pushing to a scratch branch is fine.`)}`;
    await put(policyPath(roots), owner);

    const outcome = await converge(roots);

    expect(await readFile(policyPath(roots), "utf8")).toBe(`## In this sandbox\n\nOrdinary work is fine.\n`);
    const grants = fileOwnerGrants(grantsPath(roots));
    expect((await grants.read()).commandPolicy.map((grant) => grant.line)).toEqual([
        `Deleting build directories under /work is fine.`,
        `Pushing to a scratch branch is fine.`,
    ]);
    const [copy] = await trashed(roots);
    expect(copy).toMatch(/^safety-before-card-lines-\d{13}\.md$/u);
    expect(await readFile(join(roots.history, "trash", copy ?? ""), "utf8")).toBe(owner);
    expect(outcome.plan?.steps.map(({ change }) => change)).toEqual([
        "carries 2 line(s) accepted on permission cards from .intentic/config/safety.md into owner-grants.json",
        "keeps the policy as it was in the history volume's trash",
    ]);
});

test("a second boot does nothing, and a section written into the file afterwards is never promoted into a grant", async () => {
    const roots = await volumes();
    await put(policyPath(roots), `Ask me first.\n\n${lineSection(`A line.`)}`);
    await converge(roots);
    const before = await readFile(grantsPath(roots), "utf8");

    expect((await converge(roots)).plan?.steps).toEqual([]);
    expect(await readFile(grantsPath(roots), "utf8")).toBe(before);

    // What an agent writes into the policy later is text in the owner's file, not a yes of the owner's.
    const planted = `Ask me first.\n\n${lineSection(`Everything is fine.`)}`;
    await put(policyPath(roots), planted);
    expect((await converge(roots)).plan?.steps).toEqual([]);
    expect(await readFile(policyPath(roots), "utf8")).toBe(planted);
    expect((await fileOwnerGrants(grantsPath(roots)).read()).commandPolicy.map((grant) => grant.line)).toEqual([`A line.`]);
    expect(await trashed(roots)).toHaveLength(1);
});

test("a file that only held the shipped text and the card lines goes, so the shipped text applies again", async () => {
    const roots = await volumes();
    await put(policyPath(roots), `${DEFAULT_SAFETY_POLICY.trimEnd()}\n\n${lineSection(`A line.`)}`);
    await converge(roots);

    await expect(readFile(policyPath(roots), "utf8")).rejects.toThrow("ENOENT");
    expect((await fileOwnerGrants(grantsPath(roots)).read()).commandPolicy.map((grant) => grant.line)).toEqual([`A line.`]);
});

test("a sandbox with nothing to carry starts an empty grants file, so what is written later stays where it was put", async () => {
    const roots = await volumes();
    await put(policyPath(roots), `Ask me first.\n`);
    expect((await converge(roots)).plan?.steps.map(({ change }) => change)).toEqual(["starts owner-grants.json with no line in it"]);
    expect(JSON.parse(await readFile(grantsPath(roots), "utf8"))).toEqual({ commandPolicy: [] });
    expect(await readFile(policyPath(roots), "utf8")).toBe(`Ask me first.\n`);
    await expect(readdir(join(roots.history, "trash"))).rejects.toThrow("ENOENT");

    const blank = await volumes();
    expect((await converge(blank)).plan?.steps).toHaveLength(1);
    expect(JSON.parse(await readFile(grantsPath(blank), "utf8"))).toEqual({ commandPolicy: [] });
});

test("a sandbox whose grants file already stands is left alone", async () => {
    const roots = await volumes();
    await put(grantsPath(roots), `${JSON.stringify({ commandPolicy: [{ line: `Standing.`, at: 1 }] })}\n`);
    await put(policyPath(roots), `Ask me first.\n\n${lineSection(`A line.`)}`);
    expect((await converge(roots)).plan?.steps).toEqual([]);
    expect((await fileOwnerGrants(grantsPath(roots)).read()).commandPolicy.map((grant) => grant.line)).toEqual([`Standing.`]);
});
