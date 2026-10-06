// Pins what an extension manifest may name, where each finding points, and that the list is the linter's own.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ALLOWED, BUILD_ONLY, CONSUMERS, consumerFindings, manifestFindings, SHIPPED, specifierFindings } from "./lib/extension-deps.mjs";
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

// Outside _extensions, only the web app and the files sidecar may name an extension, the sidecar only ONLYOFFICE.
test("a package outside _extensions may name an extension only as CONSUMERS allows it", () => {
    const named = (name, dependencies) => JSON.stringify({ name, dependencies }, null, 4);
    assert.deepEqual(consumerFindings("_editor/web/package.json", named("@intentic/web", { "@intentic/ext-activity": "workspace:*" })), []);
    assert.deepEqual(
        consumerFindings(
            "_devices/local-files/package.json",
            named("@intentic/local-files", { "@intentic/ext-onlyoffice": "workspace:*", "@intentic/ext-viewers": "workspace:*" }),
        ),
        ["_devices/local-files/package.json:5 @intentic/local-files names the extension @intentic/ext-viewers in dependencies"],
    );
    assert.deepEqual(
        consumerFindings(
            "_sandbox/sandbox/package.json",
            named("@intentic/sandbox", { "@intentic/ext-onlyoffice": "workspace:*", "@intentic/extension-api": "workspace:*" }),
        ),
        ["_sandbox/sandbox/package.json:4 @intentic/sandbox names the extension @intentic/ext-onlyoffice in dependencies"],
    );
});

test("the files sidecar reaches ONLYOFFICE through its local-office entry alone", () => {
    const { specifiers } = CONSUMERS.get("_devices/local-files");
    const source = [
        `import type { LocalOffice } from "@intentic/ext-onlyoffice/local-office";`,
        `import { NAMESPACE } from "@intentic/ext-onlyoffice";`,
        `const late = await import("@intentic/ext-onlyoffice/src/server/bundle.js");`,
    ].join("\n");
    assert.deepEqual(specifierFindings("_devices/local-files/src/x.ts", source, specifiers), [
        "_devices/local-files/src/x.ts:2 imports @intentic/ext-onlyoffice",
        "_devices/local-files/src/x.ts:3 imports @intentic/ext-onlyoffice/src/server/bundle.js",
    ]);
});
