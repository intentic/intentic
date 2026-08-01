import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { readWorkspaceFile, removeWorkspacePath, writeWorkspaceFile } from "../../workspace/workspace-files.js";
import type { CapabilityCtx } from "../capability.js";
import { sshHandler } from "./ssh.js";

// A ctx exposing only what sshHandler touches (files + workspace.root + capabilities.list), over a fresh temp
// workspace. HOME is pointed at a temp dir so the handler's ~/.ssh writes land there, not the real home.
const tempCtx = (remaining: Capability[] = []): { ctx: CapabilityCtx; root: string; home: string } => {
    const root = mkdtempSync(join(tmpdir(), "ssh-cap-ws-"));
    const home = mkdtempSync(join(tmpdir(), "ssh-cap-home-"));
    process.env["HOME"] = home;
    const ctx = {
        workspace: { root },
        files: { write: writeWorkspaceFile, read: readWorkspaceFile, remove: removeWorkspacePath },
        capabilities: { list: async () => remaining },
    } as unknown as CapabilityCtx;
    return { ctx, root, home };
};

const box: Capability = { id: "box", kind: "ssh", config: { auth: "key", host: "1.2.3.4", port: 22, user: "root", privateKey: "PRIV" } };
const confPath = (home: string, id: string): string => join(home, ".ssh", "intentic-hosts", `${id}.conf`);
const keyPath = (home: string, id: string): string => join(home, ".ssh", "intentic-hosts", `${id}.key`);
const skillPath = (root: string): string => join(root, ".claude", "skills", "ssh", "SKILL.md");

const drain = async (gen: AsyncGenerator<unknown>): Promise<void> => {
    for await (const _ of gen) {
        // consume the apply frames
    }
};

test("key auth: apply writes the alias block, a 0600 key, the Include and the shared skill; status flips active", async () => {
    const { ctx, root, home } = tempCtx();
    expect(await sshHandler.status(ctx, "box", box.config)).toEqual({ state: "inactive" });

    await drain(sshHandler.apply(ctx, "box", box.config));

    const conf = readFileSync(confPath(home, "box"), "utf8");
    expect(conf).toContain("Host box");
    expect(conf).toContain("HostName 1.2.3.4");
    expect(conf).toContain("User root");
    expect(conf).toContain("IdentityFile");
    // The private key is written mode 0600 (ssh refuses group/world-readable keys).
    expect(readFileSync(keyPath(home, "box"), "utf8")).toBe("PRIV\n");
    expect(statSync(keyPath(home, "box")).mode & 0o777).toBe(0o600);
    // ~/.ssh/config Includes the managed dir once.
    expect(readFileSync(join(home, ".ssh", "config"), "utf8")).toContain("Include intentic-hosts/*.conf");
    // One shared skill teaches the agent how to reach every connected machine.
    const skill = await readWorkspaceFile(skillPath(root));
    expect(skill).toContain("name: ssh");
    expect(skill).toContain("~/.ssh/intentic-hosts/");
    expect(skill).toContain("sshpass -f");
    expect(await sshHandler.status(ctx, "box", box.config)).toEqual({ state: "active" });
});

test("password auth: writes a 0600 .pass file, no IdentityFile", async () => {
    const pw: Capability = { id: "db", kind: "ssh", config: { auth: "password", host: "db.internal", port: 2222, user: "ops", password: "s3cret" } };
    const { ctx, home } = tempCtx();
    await drain(sshHandler.apply(ctx, "db", pw.config));
    const passPath = join(home, ".ssh", "intentic-hosts", "db.pass");
    expect(readFileSync(passPath, "utf8")).toBe("s3cret");
    expect(statSync(passPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(confPath(home, "db"), "utf8")).not.toContain("IdentityFile");
});

test("remove drops the machine files but keeps the shared skill while another ssh machine remains", async () => {
    const other: Capability = { id: "box2", kind: "ssh", config: { auth: "key", host: "5.6.7.8", port: 22, user: "root", privateKey: "K2" } };
    // Store still holds box + box2 during removal of box.
    const { ctx, root, home } = tempCtx([box, other]);
    await drain(sshHandler.apply(ctx, "box", box.config));

    await sshHandler.remove!(ctx, "box", box.config);
    expect(() => readFileSync(confPath(home, "box"), "utf8")).toThrow();
    expect(() => readFileSync(keyPath(home, "box"), "utf8")).toThrow();
    // box2 remains → skill stays.
    expect(await readWorkspaceFile(skillPath(root))).toContain("name: ssh");
});

test("remove deletes the shared skill when the last ssh machine goes", async () => {
    // Store holds only box during its removal.
    const { ctx, root } = tempCtx([box]);
    await drain(sshHandler.apply(ctx, "box", box.config));
    await sshHandler.remove!(ctx, "box", box.config);
    expect(await readWorkspaceFile(skillPath(root))).toBeUndefined();
});
