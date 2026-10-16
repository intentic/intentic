import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AskpassPlace, askpassStatus, environmentFile, installAskpass, uninstallAskpass } from "./askpass.js";

// `keyring askpass install|uninstall|status` on Linux, in a temp HOME: the environment.d file it writes, the profile
// lines it hands the person, and that status reads back what install wrote.

let home: string;
let place: AskpassPlace;

beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "keyring-askpass-"));
    // A `$` in the path: environment.d would expand it unescaped.
    place = { platform: "linux", home, path: join(home, "bin $x", "intentic-askpass") };
});

afterEach(async () => {
    await rm(home, { recursive: true, force: true });
});

const withBinary = async (): Promise<void> => {
    await mkdir(join(home, "bin $x"), { recursive: true });
    await writeFile(place.path, "#!/bin/sh\n");
};

test("refuses to point anything at an askpass that is not there", async () => {
    await expect(installAskpass(place)).rejects.toMatchObject({ code: "no-keyring" });
});

test("writes the four variables to environment.d, escaped, and hands back the lines a shell profile needs", async () => {
    await withBinary();
    const installed = await installAskpass(place);
    const file = environmentFile(home);
    expect(installed).toMatchObject({ installed: true, path: place.path, file });
    const escaped = place.path.replaceAll("$", "\\$");
    expect(await readFile(file, "utf8")).toContain(
        [`SSH_ASKPASS=${escaped}`, "SSH_ASKPASS_REQUIRE=prefer", `SUDO_ASKPASS=${escaped}`, `GIT_ASKPASS=${escaped}`].join("\n"),
    );
    expect(installed.profile).toEqual([
        `export SSH_ASKPASS='${place.path}'`,
        "export SSH_ASKPASS_REQUIRE='prefer'",
        `export SUDO_ASKPASS='${place.path}'`,
        `export GIT_ASKPASS='${place.path}'`,
    ]);
    expect(await askpassStatus(place)).toEqual({
        installed: true,
        path: place.path,
        variables: { SSH_ASKPASS: place.path, SSH_ASKPASS_REQUIRE: "prefer", SUDO_ASKPASS: place.path, GIT_ASKPASS: place.path },
    });
});

test("uninstall removes the file, and status then says it is not set", async () => {
    await withBinary();
    await installAskpass(place);
    const removed = await uninstallAskpass(place);
    expect(removed.installed).toBe(false);
    await expect(readFile(environmentFile(home), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await askpassStatus(place)).toEqual({ installed: false, path: place.path, variables: {} });
});

test("a file pointing somewhere else is not read as installed", async () => {
    await withBinary();
    await installAskpass(place);
    await writeFile(environmentFile(home), "SSH_ASKPASS=/usr/lib/ssh/x11-ssh-askpass\n");
    expect(await askpassStatus(place)).toMatchObject({ installed: false, variables: { SSH_ASKPASS: "/usr/lib/ssh/x11-ssh-askpass" } });
});
