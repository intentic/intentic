import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ssh.ts derives ~/.ssh from homedir() at import time, so HOME points at a throwaway dir before the dynamic import.
process.env["HOME"] = mkdtempSync(join(tmpdir(), "ssh-config-"));
process.env["USERPROFILE"] = process.env["HOME"];
const { writeManagedSshConfig, INCLUDE_MARKER } = await import("./ssh.js");
const { userSshConfigPath, sshDir } = await import("./config.js");
const { lstat, mkdir, readFile, rm, symlink, writeFile } = await import("node:fs/promises");

beforeEach(async () => {
    await rm(sshDir, { recursive: true, force: true });
    await mkdir(sshDir, { recursive: true });
});

test("a machine with no ssh config gets one holding only the include", async () => {
    await writeManagedSshConfig("");
    expect(await readFile(userSshConfigPath, "utf8")).toBe(`${INCLUDE_MARKER}\n`);
});

test("the user's own entries survive, with the include put first", async () => {
    await writeFile(userSshConfigPath, "Host box\n    HostName 10.0.0.2\n");
    await writeManagedSshConfig("");
    expect(await readFile(userSshConfigPath, "utf8")).toBe(`${INCLUDE_MARKER}\nHost box\n    HostName 10.0.0.2\n`);
});

// The write replaces the file by rename, so a config that exists and cannot be read would be replaced by the include
// alone. A link that loops stands in for EACCES, which a test running as root cannot provoke.
test("a config that exists but cannot be read is refused, never replaced", async () => {
    await symlink("config", userSshConfigPath);
    await expect(writeManagedSshConfig("")).rejects.toThrow(expect.objectContaining({ code: "ELOOP" }));
    expect((await lstat(userSshConfigPath)).isSymbolicLink()).toBe(true);
});
