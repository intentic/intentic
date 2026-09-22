import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability } from "@intentic/sandbox-contract";
import { test, expect } from "bun:test";
import { readWorkspaceFile, removeWorkspacePath, writeWorkspaceFile } from "../../workspace/files/workspace-files.js";
import type { CapabilityCtx } from "../capability.js";
import { netdiskHandler } from "./netdisk.handler.js";

// Ctx over a fresh temp workspace; HOME is a temp dir too, so ~/.intentic-netdisk writes land there. Every test runs
// with cifs-utils absent, the pre-rebuild state an add must survive.
const tempCtx = (remaining: Capability[] = []): { ctx: CapabilityCtx; root: string; home: string } => {
    const root = mkdtempSync(join(tmpdir(), "netdisk-cap-ws-"));
    const home = mkdtempSync(join(tmpdir(), "netdisk-cap-home-"));
    process.env["HOME"] = home;
    const ctx = {
        workspace: { root },
        files: { write: writeWorkspaceFile, read: readWorkspaceFile, remove: removeWorkspacePath },
        capabilities: { list: async () => remaining },
    } as unknown as CapabilityCtx;
    return { ctx, root, home };
};

const archive: Capability = {
    id: "archive",
    kind: "netdisk",
    config: {
        provider: "smb",
        server: "nas.local",
        share: "archive",
        username: "agent",
        password: "s3cret",
        access: "read",
        version: "auto",
        autoMount: "off",
    },
};
const credPath = (home: string, id: string): string => join(home, ".intentic-netdisk", `${id}.cred`);
const skillPath = (root: string): string => join(root, ".agents", "skills", "netdisk", "SKILL.md");

const drain = async (gen: AsyncGenerator<unknown>): Promise<void> => {
    for await (const _ of gen) {
    }
};

// Empty PATH makes the probe read "unavailable" (pending, needs a rebuild), independent of what's on the test host.
const withoutTooling = async <T>(body: () => Promise<T>): Promise<T> => {
    const path = process.env["PATH"];
    process.env["PATH"] = mkdtempSync(join(tmpdir(), "netdisk-nopath-"));
    try {
        return await body();
    } finally {
        process.env["PATH"] = path;
    }
};

test("apply stores a 0600 credentials file plus the shared skill, and the skill teaches the daemon-backed command", async () => {
    const { ctx, root, home } = tempCtx();
    await withoutTooling(() => drain(netdiskHandler.apply(ctx, "archive", archive.config)));

    expect(readFileSync(credPath(home, "archive"), "utf8")).toBe("username=agent\npassword=s3cret\n");
    expect(statSync(credPath(home, "archive")).mode & 0o777).toBe(0o600);
    const skill = await readWorkspaceFile(skillPath(root));
    expect(skill).toContain("name: netdisk");
    expect(skill).toContain("netdisk mount <name>");
    expect(skill).toContain("netdisk unmount <name>");
    expect(skill).toContain("/mnt/netdisk/<name>");
    // The read-only rule is the point of the access switch; the skill must say it is a decision, not a fault.
    expect(skill).toMatch(/read-only is the user's decision/i);
    // Raw tooling bypasses the daemon and desyncs the UI, so the skill must not teach it.
    expect(skill).not.toContain("mount -t cifs");
});

test("the password is on the credentials file alone, never on any other file the handler writes", async () => {
    const { ctx, home } = tempCtx();
    await withoutTooling(() => drain(netdiskHandler.apply(ctx, "archive", archive.config)));
    const dir = join(home, ".intentic-netdisk");
    const spilled = readdirSync(dir).filter((entry) => entry !== "archive.cred" && readFileSync(join(dir, entry), "utf8").includes("s3cret"));
    expect(spilled).toEqual([]);
});

test("status reports pending (rebuild required) while cifs-utils is not installed", async () => {
    const { ctx } = tempCtx();
    await withoutTooling(async () => {
        await drain(netdiskHandler.apply(ctx, "archive", archive.config));
        expect(await netdiskHandler.status(ctx, "archive", archive.config)).toEqual({ state: "pending", detail: "rebuild required" });
    });
});

test("apply with auto-mount on but no tooling stores the disk instead of failing", async () => {
    // The add must land: this entry is what puts the fragment into the overlay that installs the client.
    const { ctx, home } = tempCtx();
    const auto = { ...archive.config, autoMount: "on" };
    await withoutTooling(() => drain(netdiskHandler.apply(ctx, "archive", auto)));
    expect(statSync(credPath(home, "archive")).mode & 0o777).toBe(0o600);
});

test("the echo names every non-secret field and says whether a password is held, without carrying it", () => {
    const echoed = netdiskHandler.echo(archive.config, new Map());
    expect(echoed).toEqual({
        provider: "smb",
        server: "nas.local",
        share: "archive",
        username: "agent",
        access: "read",
        version: "auto",
        autoMount: "off",
        hasPassword: true,
    });
    expect(JSON.stringify(echoed)).not.toContain("s3cret");
    // A guest share holds no secret at all, so /secrets must not list one to rotate.
    const guest = { ...archive.config, password: undefined };
    expect(netdiskHandler.secret?.(guest, new Map())).toBeUndefined();
    expect(netdiskHandler.secret?.(archive.config, new Map())).toBe("password");
});

test("fragment installs cifs-utils and carries no runtime directive: the sandbox already holds the mount privilege", async () => {
    const returned = (await netdiskHandler.fragment!(archive.config))!;
    const blocks = typeof returned === "string" ? [returned] : [...returned];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain("cifs-utils");
    expect(blocks[0]).not.toContain("intentic:runtime");
});

test("remove erases the credentials, and drops the shared skill only with the last disk", async () => {
    const other: Capability = { ...archive, id: "scratch" };
    const { ctx, root, home } = tempCtx([archive, other]);
    await withoutTooling(async () => {
        await drain(netdiskHandler.apply(ctx, "archive", archive.config));
        await drain(netdiskHandler.apply(ctx, "scratch", other.config));
        await netdiskHandler.remove!(ctx, "archive", archive.config);
    });
    expect(() => statSync(credPath(home, "archive"))).toThrow();
    expect(await readWorkspaceFile(skillPath(root))).toContain("name: netdisk");

    const { ctx: last, root: lastRoot } = tempCtx([other]);
    await withoutTooling(async () => {
        await drain(netdiskHandler.apply(last, "scratch", other.config));
        await netdiskHandler.remove!(last, "scratch", other.config);
    });
    // readWorkspaceFile answers undefined for a missing file: the skill went with the last disk.
    expect(await readWorkspaceFile(skillPath(lastRoot))).toBeUndefined();
});
