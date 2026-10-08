import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneOpencodeBuilds } from "./engine-descriptors.js";

// npm fetches every build of @opencode/cli for the OS and CPU; only the one its postinstall linked into the CLI stays.
test("an OpenCode install keeps its linked binary and drops the platform builds beside it", async () => {
    const scope = join(mkdtempSync(join(tmpdir(), "opencode-prune-")), "node_modules", "@opencode");
    for (const dir of ["cli/bin", "cli-linux-x64/bin", "cli-linux-x64-musl/bin", "client", "cli/node_modules/@opencode/cli-linux-x64-baseline"]) {
        mkdirSync(join(scope, dir), { recursive: true });
    }
    writeFileSync(join(scope, "cli", "bin", "opencode.exe"), "binary");
    await pruneOpencodeBuilds(scope);
    expect(readdirSync(scope).toSorted()).toEqual(["cli", "client"]);
    expect(readdirSync(join(scope, "cli", "node_modules", "@opencode"))).toEqual([]);
    expect(existsSync(join(scope, "cli", "bin", "opencode.exe"))).toBe(true);
});

test("an OpenCode install whose binary never got linked is left whole, for verify to judge", async () => {
    const scope = join(mkdtempSync(join(tmpdir(), "opencode-prune-")), "node_modules", "@opencode");
    mkdirSync(join(scope, "cli-linux-x64", "bin"), { recursive: true });
    mkdirSync(join(scope, "cli"), { recursive: true });
    await pruneOpencodeBuilds(scope);
    expect(readdirSync(scope).toSorted()).toEqual(["cli", "cli-linux-x64"]);
});
