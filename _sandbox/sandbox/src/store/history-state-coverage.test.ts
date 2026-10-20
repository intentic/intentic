import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { packageRoot } from "@intentic/constants/node";
import { stateFileFor } from "@intentic/sandbox-contract/state/state-portability";
import { stateDocuments } from "../bootstrap/state-registry.js";
import { HISTORY_DOCUMENT_FILES } from "./evolution/history-documents.generated.js";
import { HISTORY_FILES_WITHOUT_DOCUMENT, HISTORY_STATE_FILES } from "./evolution/history-state.js";

// Same guard as workspace-state-coverage but for /history. A stored document declares its own portability on its
// definition, and the generated table is held here to what the loaded documents say; every other path the daemon source
// builds under historyRoot must be claimed by HISTORY_FILES_WITHOUT_DOCUMENT, and every entry there by something.

// Matched by expression, not string, so a `join(someOtherRoot, …)` call is excluded by construction.
const ROOT_EXPRESSIONS = new Set(["historyRoot", "config.historyRoot"]);

const SOURCE_ROOT = join(packageRoot(import.meta.url), "src");

const sourceFiles = async (dir: string): Promise<string[]> => {
    const entries = await readdir(dir, { withFileTypes: true });
    const found = await Promise.all(
        entries.map(async (entry) => {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) {
                return sourceFiles(path);
            }
            return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
        }),
    );
    return found.flat();
};

// Matches `join(<root>, "a", "b")`; the lookahead lets a computed final segment still contribute its literal prefix.
const HISTORY_JOIN = /join\(\s*([A-Za-z_.]+)\s*,\s*((?:"[^"]+"\s*,\s*)*"[^"]+"\s*)(?=[,)])/g;

const historyDocuments = stateDocuments().filter((spec) => spec.root === "history");
const pathOf = (spec: { readonly path: string; readonly directory: boolean }): string => (spec.directory ? `${spec.path}/` : spec.path);

test("the generated table is exactly what every loaded history document declares of itself", () => {
    // A history document defined any way the source scan cannot read (through a helper, a computed path) is missing
    // from the generated table, and fails here rather than going unclassified.
    expect(historyDocuments.length).toBeGreaterThan(50);
    const declared = historyDocuments.flatMap((spec) => (spec.stateFile === undefined ? [] : [{ ...spec.stateFile, path: pathOf(spec) }]));
    expect(declared).toHaveLength(historyDocuments.length);
    expect(HISTORY_DOCUMENT_FILES).toEqual(declared.toSorted((a, b) => a.path.localeCompare(b.path)));
});

test("a history document inside a directory the hand-kept list claims declares the directory's own class", () => {
    const disagreeing = HISTORY_DOCUMENT_FILES.flatMap((file) => {
        const directory = stateFileFor(file.path, HISTORY_FILES_WITHOUT_DOCUMENT);
        return directory === undefined || directory.portability === file.portability ? [] : [`${file.path} ${file.portability} under ${directory.path} ${directory.portability}`];
    });
    expect(disagreeing).toEqual([]);
    expect(HISTORY_STATE_FILES.map((file) => file.path)).not.toContain("audit/checkpoint.json");
    expect(HISTORY_STATE_FILES.map((file) => file.path)).toContain("identity/owner.json");
});

const declaredPaths = async (): Promise<{ path: string; source: string }[]> => {
    const files = await sourceFiles(SOURCE_ROOT);
    const found: { path: string; source: string }[] = [];
    for (const file of files) {
        const text = await readFile(file, "utf8");
        for (const match of text.matchAll(HISTORY_JOIN)) {
            const [, rootExpression = "", rest = ""] = match;
            if (!ROOT_EXPRESSIONS.has(rootExpression)) {
                continue;
            }
            const segments = [...rest.matchAll(/"([^"]+)"/g)].map(([, segment]) => segment);
            if (segments.length === 0) {
                continue;
            }
            found.push({ path: segments.join("/"), source: file.slice(SOURCE_ROOT.length + 1) });
        }
    }
    return found;
};

const covers = (path: string, entry: string): boolean => path === entry || path.startsWith(entry) || `${path}/` === entry;

test("every /history path the daemon builds outside a document is declared in HISTORY_FILES_WITHOUT_DOCUMENT", async () => {
    const used = await declaredPaths();
    // Guards against the regex matching nothing, which would make this test pass vacuously.
    expect(used.length).toBeGreaterThan(10);

    const undeclared = used
        .filter(({ path }) => !historyDocuments.some((spec) => covers(path, pathOf(spec))))
        .filter(({ path }) => !HISTORY_FILES_WITHOUT_DOCUMENT.some((file) => covers(path, file.path)))
        .map(({ path, source }) => `${path} (${source})`);

    expect(
        [...new Set(undeclared)].toSorted(),
        "Add these to HISTORY_FILES_WITHOUT_DOCUMENT (store/evolution/history-state.ts), each saying whether it travels in an environment bundle, or give them a defineDocument that says so.",
    ).toEqual([]);
});

// Entries on /history something other than the daemon writes, each with what writes it: the source scan cannot see them.
const WRITTEN_BESIDE_THE_DAEMON = new Map([
    ["shell/", "docker-entrypoint.sh and the image's HISTFILE"],
    [".ic/", "ic's sandbox/mirror.rs"],
    [".pnpm-store/", "pnpm, at the top of the mount an install runs on"],
]);

test("every declared entry is actually built somewhere in the daemon", async () => {
    // Catches an entry left behind after its store was deleted.
    const used = [
        ...(await declaredPaths()),
        ...historyDocuments.map((spec) => ({ path: pathOf(spec), source: "bootstrap/state-registry.ts" })),
        ...[...WRITTEN_BESIDE_THE_DAEMON].map(([path, source]) => ({ path, source })),
    ];
    const unused = HISTORY_FILES_WITHOUT_DOCUMENT.filter((file) => !used.some(({ path }) => covers(path, file.path))).map((file) => file.path);

    expect(unused.toSorted(), "These are declared but no daemon source builds them — drop them or fix the path.").toEqual([]);
});
