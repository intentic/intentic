import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OPTIONS } from "./features.js";
import { manifest, PLUGIN_NAME } from "./manifest.js";

// The committed manifest is what a reviewer reads and what `claude plugin validate` checks, and features.ts is what the
// hooks read back; these hold the two to one table.

const ROOT = join(import.meta.dir, "..");
const read = (path: string): unknown => JSON.parse(readFileSync(join(ROOT, path), "utf8"));

test("the committed plugin.json is the manifest the build would write", () => {
    const { version } = read("package.json") as { version: string };
    expect(read(".claude-plugin/plugin.json")).toEqual(JSON.parse(JSON.stringify(manifest(version))));
});

test("every switch is a /config row Claude Code accepts", () => {
    const config = manifest("1.0.0").userConfig;
    expect(Object.keys(config)).toEqual(Object.keys(OPTIONS));
    for (const [key, option] of Object.entries(config)) {
        // Letters, digits and underscores, not starting with a digit: an option key the manifest schema refuses fails the
        // whole plugin's load.
        expect(key).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
        expect(option.title.length).toBeGreaterThan(0);
        expect(option.description.length).toBeGreaterThan(0);
        if (option.type === "number") {
            expect(option.default).toBeGreaterThanOrEqual(option.min);
            expect(option.default).toBeLessThanOrEqual(option.max);
        }
    }
});

// Claude runs these by name off the Bash tool's PATH. pnpm, which packs every release tarball, clears the executable bit
// of anything not named in `bin` or `publishConfig.executableFiles`, and a script shipped without it installs as
// "Permission denied". A checkout's own modes are the build's to set (build.mjs), since this repository's git ignores
// them.
test("every bin/ command stays executable in the tarball pnpm packs", () => {
    const { publishConfig } = read("package.json") as { publishConfig: { executableFiles?: string[] } };
    expect(publishConfig.executableFiles?.toSorted()).toEqual(readdirSync(join(ROOT, "bin")).map((name) => `./bin/${name}`).toSorted());
});

// The README is the npm page and the marketplace homepage, and the only place a person reads what each switch does
// before trying it.
test("the README documents every switch", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    for (const key of Object.keys(OPTIONS)) {
        expect({ key, documented: readme.includes(`| \`${key}\` |`) }).toEqual({ key, documented: true });
    }
});

// Claude Code 2.1.287 and later load the mod named under `modules`; older ones read the key and ignore the module. The
// module is a source file in hooks/, which `files` ships whole.
test("every module hooks.json names is a file the package ships", () => {
    const { modules = [] } = read("hooks/hooks.json") as { modules?: string[] };
    const { files } = read("package.json") as { files: string[] };
    expect(modules.length).toBeGreaterThan(0);
    expect(files).toContain("hooks");
    for (const module of modules) {
        expect(module.startsWith("./")).toBe(true);
        expect(existsSync(join(ROOT, "hooks", module))).toBe(true);
    }
});

test("the marketplace lists the plugin under its own name, from npm", () => {
    const marketplace = read("../../.claude-plugin/marketplace.json") as { plugins: { name: string; source: unknown }[] };
    expect(marketplace.plugins.find((plugin) => plugin.name === PLUGIN_NAME)?.source).toEqual({ source: "npm", package: "@intentic/claude-plugin" });
});
