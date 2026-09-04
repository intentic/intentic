#!/usr/bin/env node
/* `node _tools/nav/gate.mjs` — THE PROOF THAT A REFACTOR SLICE CHANGED NOTHING.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not typecheck, lint or run tests. `pnpm verify:turn` already
 * does all three over the affected closure and does them better than a second implementation would. Running
 * them again from here would be a slower copy that drifts.
 *
 * WHAT IT DOES INSTEAD is the half a test suite structurally cannot catch. A test suite proves that the code
 * paths it exercises still work. It says nothing about a public export that no in-tree caller uses — and
 * during a decomposition, "no in-tree caller" is exactly the signal a sweep uses to decide something is dead.
 * That is not a hypothetical failure mode: in the campaign this harness reproduces, about twenty public names
 * were deleted for having no in-tree callers, a wheel shipped missing seventeen modules, and none of it was
 * caught by a green suite. It was caught by people reading the diff, twice, over two days.
 *
 * So this gate asserts two things a green suite cannot:
 *
 *   1. THE PUBLIC SURFACE DID NOT SHRINK. Every exported name that existed before still exists somewhere.
 *      Deliberately location-independent: moving a definition between files is the entire point of the
 *      exercise and must be free. Removing one must be loud.
 *   2. THE FROZEN FILES ARE BYTE-IDENTICAL. Wire contracts, schemas, SQL, and anything else whose content IS
 *      the behavior. A refactor has no business touching these, so any change is a finding, not a diff to
 *      skim past.
 *
 * ADDITIONS ARE REPORTED, NOT FAILED. A decomposition legitimately adds exports: a helper lifted out of a god
 * function has to be exported to be imported by its new siblings. Growth is normal; shrinkage is the bug.
 *
 * Usage:
 *   gate.mjs snapshot --ref main --out _tools/nav/baselines/surface.json    before you start
 *   gate.mjs check _tools/nav/baselines/surface.json                        after every slice
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { repoRoot } from "../constants/src/node.mjs";
import { listTracked, readAt } from "./lib/files.mjs";
import { estimateTokens } from "./lib/tokens.mjs";
import { resolveSpecifier } from "./lib/resolve.mjs";
import { buildTree } from "./lib/tree.mjs";

const root = repoRoot(import.meta.url);

const arg = (name, fallback) => {
    const index = process.argv.indexOf(`--${name}`);
    return index === -1 || index === process.argv.length - 1 ? fallback : process.argv[index + 1];
};

/* FILES WHOSE CONTENT IS THE BEHAVIOR. Kept as an explicit list rather than inferred, because the cost of
 * forgetting one is a silent wire-format change and the cost of an extra one is a moment spent explaining a
 * legitimate edit. Add to it freely; that direction is safe. */
const FROZEN = [
    /\.sql$/,
    /\.prisma$/,
    /(^|\/)migrations?\//,
    /(^|\/)locales?\//,
    /\.schema\.json$/,
    /(^|\/)openapi[^/]*\.(json|ya?ml)$/,
    /(^|\/)_platform\/api-contract\/src\//,
    /(^|\/)_sandbox\/sandbox-contract\/src\//,
];

const sha = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/* One package entry point's export surface, following re-export edges. This is the set an external consumer
 * can see, which is a stricter thing than "names declared in the package" and the one that actually breaks
 * somebody when it shrinks. */
const entrySurface = (tree, entry, depth = 0, seen = new Set()) => {
    if (depth > 10 || seen.has(entry)) {
        return new Set();
    }
    seen.add(entry);
    const facts = tree.facts.get(entry);
    if (!facts) {
        return new Set();
    }
    const names = new Set(facts.localExports);
    for (const reexport of facts.reexports) {
        names.add(reexport.name);
    }
    for (const star of facts.stars) {
        const target = resolveSpecifier(entry, star, tree.known, tree.packages);
        if (target) {
            for (const name of entrySurface(tree, target, depth + 1, seen)) {
                names.add(name);
            }
        }
    }
    return names;
};

const snapshotOf = (ref) => {
    const tree = buildTree(root, ref, estimateTokens);

    // 1. Every exported name anywhere in the tree, without its location.
    const treeExports = new Set();
    for (const path of tree.source) {
        for (const declaration of tree.files.get(path)?.declarations ?? []) {
            if (declaration.exported) {
                treeExports.add(declaration.name);
            }
        }
        for (const name of tree.facts.get(path)?.localExports ?? []) {
            treeExports.add(name);
        }
        for (const reexport of tree.facts.get(path)?.reexports ?? []) {
            treeExports.add(reexport.name);
        }
    }

    // 2. Per-package entry surfaces.
    const packages = {};
    for (const [name] of tree.packages) {
        const entry = resolveSpecifier("package.json", name, tree.known, tree.packages);
        if (!entry) {
            continue;
        }
        packages[name] = [...entrySurface(tree, entry)].sort();
    }

    // 3. Frozen file hashes.
    const frozen = {};
    for (const path of listTracked(root, ref)) {
        if (path.includes("node_modules/") || !FROZEN.some((pattern) => pattern.test(path))) {
            continue;
        }
        frozen[path] = sha(readAt(root, path, ref));
    }

    return {
        generatedAt: new Date().toISOString(),
        ref: ref ?? "(working tree)",
        treeExports: [...treeExports].sort(),
        packages,
        frozen,
    };
};

const snapshot = () => {
    const ref = arg("ref", undefined);
    const out = arg("out", join(root, "_tools/nav/baselines/surface.json"));
    const result = snapshotOf(ref);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
    console.log(
        `surface snapshot of ${result.ref}: ${result.treeExports.length} exported names, ` +
            `${Object.keys(result.packages).length} package entry points, ${Object.keys(result.frozen).length} frozen files`,
    );
    console.log(`written to ${out}`);
};

const check = () => {
    const baselinePath = process.argv[3];
    if (!baselinePath) {
        console.error("usage: gate.mjs check <surface-baseline.json>");
        process.exit(2);
    }
    const before = JSON.parse(readFileSync(baselinePath, "utf8"));
    const after = snapshotOf(arg("ref", undefined));

    const findings = [];

    const afterExports = new Set(after.treeExports);
    const vanished = before.treeExports.filter((name) => !afterExports.has(name));
    if (vanished.length > 0) {
        findings.push({
            kind: "exports-removed",
            detail: `${vanished.length} exported name(s) no longer exist anywhere in the tree`,
            names: vanished.slice(0, 60),
        });
    }

    for (const [name, names] of Object.entries(before.packages)) {
        const now = new Set(after.packages[name] ?? []);
        const lost = names.filter((exported) => !now.has(exported));
        if (lost.length > 0) {
            findings.push({
                kind: "package-surface-shrank",
                detail: `${name} no longer exports ${lost.length} name(s) from its entry point`,
                names: lost.slice(0, 40),
            });
        }
    }

    for (const [path, hash] of Object.entries(before.frozen)) {
        const now = after.frozen[path];
        if (now === undefined) {
            findings.push({ kind: "frozen-file-deleted", detail: path, names: [] });
        } else if (now !== hash) {
            findings.push({ kind: "frozen-file-changed", detail: path, names: [] });
        }
    }

    const added = after.treeExports.length - before.treeExports.length;
    const note = added >= 0 ? "growth is expected and fine" : "a net drop — the removals are listed below";
    console.log(`\nsurface check: ${before.ref} → ${after.ref}`);
    console.log(`  exported names ${before.treeExports.length} → ${after.treeExports.length} (${added >= 0 ? "+" : ""}${added}; ${note})`);

    if (findings.length === 0) {
        console.log("  ✓ nothing removed, nothing frozen moved\n");
        process.exit(0);
    }

    console.log("");
    for (const finding of findings) {
        console.log(`  ✗ ${finding.kind}: ${finding.detail}`);
        if (finding.names.length > 0) {
            console.log(`      ${finding.names.join(", ")}`);
        }
    }
    console.log(
        "\n  Each of these is either a real regression or a deliberate removal you can name. " +
            "If deliberate, re-snapshot the baseline in the same commit that removes it, so the next slice starts from the truth.\n",
    );
    process.exit(1);
};

const verb = process.argv[2] ?? "check";
const verbs = { snapshot, check };
if (!verbs[verb]) {
    console.error(`unknown verb '${verb}'. one of: ${Object.keys(verbs).join(", ")}`);
    process.exit(2);
}
verbs[verb]();
