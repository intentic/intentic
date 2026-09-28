// Pins what an extension manifest may name, where each finding points, and that the list is the linter's own.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ALLOWED, BUILD_ONLY, manifestFindings, SHIPPED } from "./lib/extension-deps.mjs";
import { root } from "./lib/repo.mjs";

const manifest = (fields) => JSON.stringify({ name: "@intentic/ext-probe", ...fields }, null, 4);

test("the SDK, the contract and base pass in every field, the build kit in devDependencies", () => {
    const text = manifest({
        dependencies: { "@intentic/base": "workspace:*", "@intentic/extension-api": "workspace:*", "left-pad": "1.0.0" },
        peerDependencies: { "@intentic/sandbox-contract": "workspace:*" },
        devDependencies: { "@intentic/testing": "workspace:*", "@intentic/tsconfig": "workspace:*", "@intentic/extension-ui": "workspace:*" },
    });
    assert.deepEqual(manifestFindings("_extensions/probe/package.json", text), []);
});

test("an app or engine package is refused in any field, and the build kit outside devDependencies", () => {
    const text = manifest({
        dependencies: { "@intentic/web": "workspace:*", "@intentic/testing": "workspace:*" },
        peerDependencies: { "@intentic/sandbox": "workspace:*" },
        optionalDependencies: { "@intentic/tsconfig": "workspace:*" },
        devDependencies: { "@intentic/ui": "workspace:*" },
    });
    assert.deepEqual(manifestFindings("_extensions/probe/package.json", text), [
        "_extensions/probe/package.json:5 @intentic/ext-probe names @intentic/testing in dependencies",
        "_extensions/probe/package.json:4 @intentic/ext-probe names @intentic/web in dependencies",
        "_extensions/probe/package.json:8 @intentic/ext-probe names @intentic/sandbox in peerDependencies",
        "_extensions/probe/package.json:11 @intentic/ext-probe names @intentic/tsconfig in optionalDependencies",
        "_extensions/probe/package.json:14 @intentic/ext-probe names @intentic/ui in devDependencies",
    ]);
});

test("a name that only starts like an allowed one is refused", () => {
    const text = manifest({ dependencies: { "@intentic/extension-apix": "1.0.0" } });
    assert.deepEqual(manifestFindings("_extensions/probe/package.json", text), [
        "_extensions/probe/package.json:4 @intentic/ext-probe names @intentic/extension-apix in dependencies",
    ]);
});

// The linter's `_extensions/**` override and its test-file twin allow each name bare and with a subpath; the manifests
// are held to the same names, so a package added to one list and not the other fails here.
const allowedByLinter = (filesLine) => {
    const config = readFileSync(join(root, ".oxlintrc.json"), "utf8");
    const at = config.indexOf(filesLine);
    assert.notEqual(at, -1, `.oxlintrc.json has no override ${filesLine}`);
    const group = /"group":\s*\[([^\]]*)\]/.exec(config.slice(at))[1];
    const negated = [...group.matchAll(/"!(@intentic\/[^"]+)"/g)].map((match) => match[1]);
    const bare = negated.filter((name) => !name.endsWith("/**")).sort();
    assert.deepEqual(
        negated
            .filter((name) => name.endsWith("/**"))
            .map((name) => name.slice(0, -3))
            .sort(),
        bare,
        "each allowed name is allowed with its subpaths too",
    );
    return bare;
};

test("the manifests' list is the linter's", () => {
    assert.deepEqual(allowedByLinter(`"files": ["_extensions/**"]`), [...SHIPPED].sort());
    assert.deepEqual(allowedByLinter(`"files": ["_extensions/**/*.test.ts"`), [...SHIPPED, "@intentic/testing"].sort());
    assert.deepEqual([...ALLOWED.devDependencies].sort(), [...SHIPPED, ...BUILD_ONLY].sort());
});
