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
    // Boot's own marker of what a prewarm left behind, read once by the next boot.
    "system/boot/prewarm.ts",
];

test("no module outside the store opens a file without the document that describes it", () => {
    expect(calling(/\b(jsonFile|jsonEntries|jsonDir|idListFile)\s*(<[^>]*>)?\(/).filter((module) => !module.startsWith("store/"))).toEqual([]);
});

// Caches kept outside a runtime, each an answer the daemon fetches or measures again whenever the file is gone or
// unreadable.
const CACHES_OUTSIDE_RUNTIMES = [
    // A custom endpoint's last discovered model list, standing in while its server is down.
    "endpoints/endpoint-catalog.ts",
    // A geo exit provider's relay or server catalog, refreshed past its TTL.
    "exit/exit-catalog.ts",
    // The last finished disk scan, shown until the next scan replaces it; one this build cannot read is no scan yet.
    "system/resources/storage/disk-storage.ts",
];

test("a file no document describes is a cache, kept by a runtime or one of the few named above", () => {
    const caches = calling(/\bcacheFile\s*(<[^>]*>)?\(/).filter((module) => module !== "store/open-document.ts");
    expect(caches.filter((module) => !module.startsWith("runtimes/"))).toEqual(CACHES_OUTSIDE_RUNTIMES);
    // Guards the pattern: a rename of the opener would otherwise make this pass on nothing.
    expect(caches.length).toBeGreaterThan(3);
});

test("the files kept by hand beside the document layer are exactly the ones named above", () => {
    expect(calling(/\bwriteJsonFile\(/).filter((module) => !module.startsWith("store/"))).toEqual(HAND_KEPT);
});

// The text between the parentheses of every call to `callee` (a pattern) in a module, matched by depth, so a call
// spread over lines is read whole and whatever follows the call is not.
const callArguments = (text: string, callee: string): string[] =>
    [...text.matchAll(new RegExp(`\\b${callee}\\s*\\(`, "g"))].map((match) => {
        const start = match.index + match[0].length;
        let depth = 1;
        let end = start;
        for (; end < text.length && depth > 0; end++) {
            depth += text[end] === "(" ? 1 : text[end] === ")" ? -1 : 0;
        }
        return text.slice(start, end - 1);
    });

// JSON written whole through the atomic writer by hand, past every document: what the shape check and the conversions
// cannot see, each named with why it stands. The list only shrinks.
const RAW_JSON_WRITERS = [
    // What a conversation was last told, overwritten every turn; one an older shape wrote reads as none.
    "agent/prompt/prompt-record.ts",
    // Claude Code's own settings.json: one key merged into a file whose shape another program owns.
    "sessions/session-store.ts",
    // Written synchronously as a failed boot exits, where no store's write queue can be waited on.
    "system/boot/boot-failure.ts",
    // The exit marker, written synchronously from the exit hook for the next boot to read.
    "system/boot/boot-marker.ts",
];

test("JSON written whole outside the store goes through a document, or is one of the few named above", () => {
    const writers = modules
        .filter(
            ({ module, text }) =>
                !module.startsWith("store/") && callArguments(text, "writeFileAtomic(?:Sync)?").some((args) => args.includes("JSON.stringify")),
        )
        .map(({ module }) => module)
        .toSorted();
    expect(writers).toEqual(RAW_JSON_WRITERS);
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
