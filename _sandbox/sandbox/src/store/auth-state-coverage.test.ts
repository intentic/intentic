import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { packageRoot } from "@intentic/constants/node";
import { AUTH_STATE_FILES } from "@intentic/sandbox-contract/state/auth-state";
import { stateFileFor } from "@intentic/sandbox-contract/state/state-portability";
import { stateDocuments } from "../bootstrap/state-registry.js";
import { BROKER_KEY_FILE } from "../capabilities/broker/broker-slice.js";
import { SSH_KEYS_DIR } from "../capabilities/ssh-key-store.js";
import { ORG_POLICY_FILE } from "../org/org-policy.js";
import { RELEASED_VALUES_FILE } from "../secrets/device/keyring-stores.js";

// The auth root's twin of history-state-coverage: every path the daemon builds under the auth root is read off the
// source (a literal `join(<…authRoot>, "a", "b")`), the registry (each stored document names its path once) and the
// few constants a store names its file by. A FILE among them must be claimed by AUTH_STATE_FILES, so a new key, vault
// or ledger says whether it travels; a directory may fall to the table's default, `secret`, which is what a provider's
// own home is. And every entry must be built somewhere, so one left behind by a deleted store is noticed.

// Matched by expression: `authRoot` under any owner (`input.authRoot`, `services.authRoot`), and the boot step's
// `roots.auth`.
const ROOT_EXPRESSION = /^(?:[A-Za-z_]+\.)?authRoot$|^roots\.auth$/u;

const SOURCE_ROOT = join(packageRoot(import.meta.url), "src");

const sourceFiles = async (dir: string): Promise<string[]> => {
    const entries = await readdir(dir, { withFileTypes: true });
    const found = await Promise.all(
        entries.map(async (entry) => {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) {
                return sourceFiles(path);
            }
            return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".testing.ts") ? [path] : [];
        }),
    );
    return found.flat();
};

// Matches `join(<root>, "a", "b")`; the lookahead lets a computed final segment still contribute its literal prefix.
const AUTH_JOIN = /join\(\s*([A-Za-z_.]+)\s*,\s*((?:"[^"]+"\s*,\s*)*"[^"]+"\s*)(?=[,)])/g;

interface Built {
    readonly path: string;
    readonly source: string;
    // A directory may be left to the default; a file may not.
    readonly file: boolean;
}

const builtPaths = async (): Promise<Built[]> => {
    const found: Built[] = [];
    for (const file of await sourceFiles(SOURCE_ROOT)) {
        const text = await readFile(file, "utf8");
        for (const match of text.matchAll(AUTH_JOIN)) {
            const [, rootExpression = "", rest = ""] = match;
            if (!ROOT_EXPRESSION.test(rootExpression)) {
                continue;
            }
            const segments = [...rest.matchAll(/"([^"]+)"/g)].map(([, segment]) => segment ?? "");
            const last = segments.at(-1) ?? "";
            found.push({ path: segments.join("/"), source: file.slice(SOURCE_ROOT.length + 1), file: last.includes(".") });
        }
    }
    for (const spec of stateDocuments().filter((candidate) => candidate.root === "auth")) {
        found.push({ path: spec.directory ? `${spec.path}/` : spec.path, source: "bootstrap/state-registry.ts", file: !spec.directory });
    }
    for (const name of [BROKER_KEY_FILE, ORG_POLICY_FILE, RELEASED_VALUES_FILE]) {
        found.push({ path: name, source: "a named constant", file: true });
    }
    found.push({ path: `${SSH_KEYS_DIR}/`, source: "capabilities/ssh-key-store.ts", file: false });
    return found;
};

const covers = (path: string, entry: string): boolean => path === entry || path.startsWith(entry) || `${path}/` === entry;

test("every file the daemon keeps in the auth root is declared in AUTH_STATE_FILES", async () => {
    const built = await builtPaths();
    // Guards against the pattern matching nothing, which would make this test pass vacuously.
    expect(built.filter((path) => path.source !== "bootstrap/state-registry.ts").length).toBeGreaterThan(10);

    const undeclared = built
        .filter(({ path, file }) => file && stateFileFor(path, AUTH_STATE_FILES) === undefined)
        .map(({ path, source }) => `${path} (${source})`);

    expect(
        [...new Set(undeclared)].toSorted(),
        "Add these to AUTH_STATE_FILES in @intentic/sandbox-contract, each saying whether it travels in an environment bundle.",
    ).toEqual([]);
});

test("every declared auth entry is actually built somewhere in the daemon", async () => {
    const built = await builtPaths();
    const unused = AUTH_STATE_FILES.filter((entry) => !built.some(({ path }) => covers(path, entry.path))).map((entry) => entry.path);

    expect(unused.toSorted(), "These are declared but no daemon source builds them — drop them or fix the path.").toEqual([]);
});
