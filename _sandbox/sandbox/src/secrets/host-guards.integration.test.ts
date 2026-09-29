import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileSecretHostGuards } from "./host-guards.js";

// The owner's host guards on disk: private to the daemon's user, one setting per subject and kind with its list kept
// while it is off, and never read as "every guard off" when the file is there but cannot be read.

const store = () => {
    const path = join(mkdtempSync(join(tmpdir(), "secret-hosts-")), "secret-hosts.json");
    return { path, guards: fileSecretHostGuards(path) };
};

test("keeps each subject's setting under its kind, its list kept while off, readable only by the daemon's user", async () => {
    const { path, guards } = store();
    await guards.set({ subject: "github", kind: "secret", guard: true, hosts: ["example.com"] });
    await guards.set({ subject: "github", kind: "capability", guard: false, hosts: ["api.github.com", "github.com"] });
    expect(await guards.list()).toEqual([
        { subject: "github", kind: "secret", guard: true, hosts: ["example.com"] },
        { subject: "github", kind: "capability", guard: false, hosts: ["api.github.com", "github.com"] },
    ]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    await guards.remove("github", "secret");
    expect(await guards.list()).toEqual([{ subject: "github", kind: "capability", guard: false, hosts: ["api.github.com", "github.com"] }]);
});

test("reads a host a person wrote by hand in the pattern's own spelling, and drops what is not a host", async () => {
    const { path, guards } = store();
    writeFileSync(
        path,
        JSON.stringify({ "secret:GITHUB_TOKEN": { guard: true, hosts: ["API.GitHub.com", "https://uploads.github.com/x", "*", "evil .example"] } }),
    );
    expect(await guards.list()).toEqual([{ subject: "GITHUB_TOKEN", kind: "secret", guard: true, hosts: ["api.github.com", "uploads.github.com"] }]);
});

test("refuses a file it cannot read, rather than answering that every guard is off, and never writes over it", async () => {
    const { path, guards } = store();
    writeFileSync(path, "{ not json");
    await expect(guards.list()).rejects.toThrow("could not be read");
    await expect(guards.set({ subject: "GITHUB_TOKEN", kind: "secret", guard: true, hosts: ["api.github.com"] })).rejects.toThrow(
        "could not be read",
    );
    expect(readFileSync(path, "utf8")).toBe("{ not json");
});
