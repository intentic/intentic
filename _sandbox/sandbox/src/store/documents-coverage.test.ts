import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { packageRoot } from "@intentic/constants/node";
import { stateDocuments } from "../bootstrap/state-registry.js";
import { documentKey } from "./evolution/documents.js";

// Every file a store keeps is a document: opened through the spec that describes it (store/open-document.ts), so its
// schema is the one its reads run, its conversions run on every read, its shape is frozen, and the contract's
// state-file tables say whether it travels. What would open a file no spec describes is fenced here by name.

const SOURCE = join(packageRoot(import.meta.url), "src");

const sourceFiles = async (dir: string): Promise<string[]> => {
    const entries = await readdir(dir, { withFileTypes: true });
    const nested = await Promise.all(
        entries.map(async (entry) => {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) {
                return entry.name === "generated" ? [] : sourceFiles(path);
            }
            return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".testing.ts") ? [path] : [];
        }),
    );
    return nested.flat();
};

// Off the assertion clock: every shipped module, by its path under src/.
const modules = await Promise.all(
    (await sourceFiles(SOURCE)).map(async (file) => ({ module: relative(SOURCE, file).split("\\").join("/"), text: await readFile(file, "utf8") })),
);
const calling = (pattern: RegExp): string[] =>
    modules
        .filter(({ text }) => pattern.test(text))
        .map(({ module }) => module)
        .toSorted();

// Files kept by hand beside the document layer, each read and written by its own module. Each one here is a store the
// shape check and the conversions cannot see; the list only shrinks.
const HAND_KEPT = [
    // One file per connected AI account, each its own credential envelope.
    "agent/providers/accounts/account-files.ts",
    // The exit node's live state, rewritten on every poll; nothing reads it across a restart but the next poll.
    "exit/exit-state.ts",
    // The owner's credential gates, a policy file read through its own refusing parse.
    "secrets/credential-gates.ts",
    // Boot's own marker of what a prewarm left behind, read once by the next boot.
    "system/boot/prewarm.ts",
];

test("no module outside the store opens a file without the document that describes it", () => {
    expect(calling(/\b(jsonFile|jsonEntries|jsonDir|idListFile)\s*(<[^>]*>)?\(/).filter((module) => !module.startsWith("store/"))).toEqual([]);
});

test("a file no document describes is a runtime's cache, and only a runtime keeps one", () => {
    const caches = calling(/\bcacheFile\s*(<[^>]*>)?\(/).filter((module) => module !== "store/open-document.ts");
    expect(caches.filter((module) => !module.startsWith("runtimes/"))).toEqual([]);
    // Guards the pattern: a rename of the opener would otherwise make this pass on nothing.
    expect(caches.length).toBeGreaterThan(3);
});

test("the files kept by hand beside the document layer are exactly the ones named above", () => {
    expect(calling(/\bwriteJsonFile\(/).filter((module) => !module.startsWith("store/"))).toEqual(HAND_KEPT);
});

test("every document the daemon keeps on the workspace or /history is one the contract's state-file tables describe", () => {
    // Interchange formats a person or another sandbox hands in, read by their own parser: not state this sandbox keeps.
    const INTERCHANGE = ["workspace:intentic-bundle.json", "workspace:sandbox.toml"];
    const undescribed = stateDocuments()
        .filter((spec) => spec.root !== "auth" && spec.stateFile === undefined)
        .map(documentKey)
        .toSorted();
    expect(undescribed).toEqual(INTERCHANGE);
});
