import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ssh.ts derives ~/.ssh from homedir() at import time, so HOME points at a throwaway dir before the dynamic import.
process.env["HOME"] = mkdtempSync(join(tmpdir(), "ssh-config-"));
process.env["USERPROFILE"] = process.env["HOME"];
const { writeManagedSshConfig, removeManagedSshConfig, INCLUDE_MARKER } = await import("../ssh.js");
const { userSshConfigPath, sshDir } = await import("../config.js");
const { lstat, mkdir, readdir, readFile, rm, stat, symlink, writeFile } = await import("node:fs/promises");

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

// Removal once rewrote the user's config in place, so a crash mid-write left it truncated: it is now staged beside the
// file and renamed over it (a new inode), like the write, and nothing staged is left behind.
test("removing the include replaces the user's config whole, leaving their entries and commented lines", async () => {
    await writeFile(userSshConfigPath, `# ${INCLUDE_MARKER}\nHost box\n    HostName 10.0.0.2\n`);
    await writeManagedSshConfig("");
    const written = await stat(userSshConfigPath);

    await removeManagedSshConfig();

    expect(await readFile(userSshConfigPath, "utf8")).toBe(`# ${INCLUDE_MARKER}\nHost box\n    HostName 10.0.0.2\n`);
    expect((await stat(userSshConfigPath)).ino).not.toBe(written.ino);
    expect((await readdir(sshDir)).toSorted()).toEqual(["config"]);
});
