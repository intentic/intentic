import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pino } from "pino";
import { restoreExecBits } from "./exec-bits.js";

const quiet = pino({ level: "silent" });

let root = "";
beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "exec-bits-"));
});
afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

test("a PATH symlink into the install whose target lost its exec bit gets it back, and nothing else is touched", async () => {
    const install = `${join(root, "opt", "sandbox")  }/`;
    const bin = join(root, "bin");
    await mkdir(join(install, "dist", "logs"), { recursive: true });
    await mkdir(bin);
    const lost = join(install, "dist", "logs", "pane-log-clean.js");
    const fine = join(install, "dist", "gate.js");
    const outside = join(root, "elsewhere.js");
    await writeFile(lost, "#!/usr/bin/env node\n", { mode: 0o644 });
    await writeFile(fine, "#!/usr/bin/env node\n", { mode: 0o755 });
    await writeFile(outside, "#!/usr/bin/env node\n", { mode: 0o644 });
    await chmod(lost, 0o644);
    await chmod(outside, 0o644);
    await symlink(lost, join(bin, "pane-log-clean"));
    await symlink(fine, join(bin, "memory-gate"));
    await symlink(outside, join(bin, "other"));
    await symlink(join(root, "missing.js"), join(bin, "dangling"));

    const repaired = await restoreExecBits(bin, install, quiet);

    expect(repaired).toEqual(["pane-log-clean"]);
    expect((await stat(lost)).mode & 0o777).toBe(0o755);
    expect((await stat(fine)).mode & 0o777).toBe(0o755);
    expect((await stat(outside)).mode & 0o777).toBe(0o644);
});
