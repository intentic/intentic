import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import type { DeviceScopes } from "@intentic/sandbox-contract/schemas/capabilities";
import { assertHoldsNoProtected, assertPath, ScopeError } from "./policy.js";
import { grantWith } from "./device-testing.js";
import { readTextFile, trashFile, writeTextFile } from "./tools/files.js";

// The protected places on a real home folder with real links: HOME points at a temp tree for this file, which is what
// homeDir() reads per call (local-agent). Every link is made before the first check, since resolved places are held a
// second (policy.ts).

const base = realpathSync(mkdtempSync(join(tmpdir(), "device-protected-")));
const home = join(base, "home");
const elsewhere = join(base, "elsewhere");
const previousHome = process.env["HOME"];
process.env["HOME"] = home;

mkdirSync(join(home, ".ssh", "public"), { recursive: true });
writeFileSync(join(home, ".ssh", "id_ed25519"), "PRIVATE KEY");
writeFileSync(join(home, ".ssh", "public", "key.pub"), "ssh-ed25519 AAAA");
mkdirSync(join(home, "projects"), { recursive: true });
writeFileSync(join(home, "projects", "notes.txt"), "mine");
mkdirSync(join(home, ".codex"), { recursive: true });
writeFileSync(join(home, ".codex", "auth.json"), "{}");
// A link from an ordinary folder into a protected one, and a protected folder that is itself a link to another disk.
symlinkSync(join(home, ".ssh"), join(home, "projects", "keys"));
mkdirSync(join(elsewhere, "aws"), { recursive: true });
writeFileSync(join(elsewhere, "aws", "credentials"), "[default]");
symlinkSync(join(elsewhere, "aws"), join(home, ".aws"));

// No roots: the home folder, as an unnarrowed card reads.
const everywhere: DeviceScopes = grantWith(["write"]);
const opened = (...extra: string[]): DeviceScopes => grantWith(["write"], { roots: ["~", ...extra].join("\n") });

afterAll(() => {
    process.env["HOME"] = previousHome;
    rmSync(base, { recursive: true, force: true });
});

test("a key under the home folder is refused, saying what the place holds and how the owner allows it", async () => {
    const refusal = assertPath(join(home, ".ssh", "id_ed25519"), everywhere, "read");
    await expect(refusal).rejects.toThrow(ScopeError);
    await expect(refusal).rejects.toThrow(`it is in ${join(home, ".ssh")}, which holds SSH keys`);
    await expect(refusal).rejects.toThrow(`To allow it, the owner adds ${join(home, ".ssh")} (or a folder inside it) as a line of "Folders it may touch"`);
});

test("a build this sandbox pushed here is reachable, while the rest of intentic's own folder stays shut", async () => {
    const build = join(home, STATE_DIR, "machine", "runs", "sandbox-1", "server", "v1");
    mkdirSync(build, { recursive: true });
    writeFileSync(join(build, "run.log"), "listening");
    writeFileSync(join(home, STATE_DIR, "machine", "device.json"), "{}");
    expect((await readTextFile(join(build, "run.log"), {}, everywhere)).text).toBe("listening");
    await expect(assertPath(build, everywhere, "start a program in")).resolves.toBe(build);
    await expect(assertPath(join(home, STATE_DIR, "machine", "device.json"), everywhere, "read")).rejects.toThrow("intentic's own credentials");
    // Gone again, so the tests that take the home folder whole meet only the places they set up.
    rmSync(join(home, STATE_DIR), { recursive: true, force: true });
});

test("a link into a protected place is judged where it leads", async () => {
    await expect(assertPath(join(home, "projects", "keys", "id_ed25519"), everywhere, "read")).rejects.toThrow(`(it leads to ${join(home, ".ssh", "id_ed25519")})`);
});

test("a protected folder that is itself a link protects where it leads", async () => {
    await expect(assertPath(join(elsewhere, "aws", "credentials"), grantWith(["write"], { roots: base }), "read")).rejects.toThrow("AWS credentials");
});

test("read, write and list are all refused there, and a file beside it is not", async () => {
    await expect(readTextFile(join(home, ".ssh", "id_ed25519"), {}, everywhere)).rejects.toThrow(ScopeError);
    await expect(writeTextFile(join(home, ".ssh", "authorized_keys"), "ssh-ed25519 ATTACKER", undefined, everywhere)).rejects.toThrow(ScopeError);
    await expect(assertPath(join(home, ".ssh"), everywhere, "list")).rejects.toThrow(ScopeError);
    expect((await readTextFile(join(home, "projects", "notes.txt"), {}, everywhere)).text).toBe("mine");
    expect((await readTextFile(join(home, ".codex", "auth.json"), {}, everywhere)).text).toBe("{}");
});

test("naming the place, or a folder inside it, as an allowed folder opens what that line holds", async () => {
    expect(await assertPath(join(home, ".ssh", "id_ed25519"), opened("~/.ssh"), "read")).toBe(join(home, ".ssh", "id_ed25519"));
    expect(await assertPath(join(home, ".ssh", "public", "key.pub"), opened("~/.ssh/public"), "read")).toBe(join(home, ".ssh", "public", "key.pub"));
    await expect(assertPath(join(home, ".ssh", "id_ed25519"), opened("~/.ssh/public"), "read")).rejects.toThrow(ScopeError);
    // The line names the link; what it leads to is opened by it.
    expect(await assertPath(join(home, ".aws", "credentials"), opened("~/.aws"), "read")).toBe(join(elsewhere, "aws", "credentials"));
});

test("a folder that holds a protected place is not taken whole until that place itself is allowed", async () => {
    await expect(assertHoldsNoProtected(home, "~", everywhere, "copy from")).rejects.toThrow(`that folder holds ${join(home, ".ssh")} (SSH keys)`);
    await expect(trashFile(home, everywhere)).rejects.toThrow(ScopeError);
    await expect(assertHoldsNoProtected(join(home, "projects"), "~/projects", everywhere, "copy from")).resolves.toBeUndefined();
    await expect(assertHoldsNoProtected(home, "~", opened("~/.ssh", "~/.aws"), "copy from")).resolves.toBeUndefined();
    await expect(assertHoldsNoProtected(home, "~", opened("~/.ssh/public", "~/.aws"), "copy from")).rejects.toThrow(join(home, ".ssh"));
});
