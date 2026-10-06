import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability } from "@intentic/sandbox-contract";
import { readWorkspaceFile, removeWorkspacePath, writeWorkspaceFile } from "../../workspace/files/workspace-files.js";
import type { CapabilityCtx } from "../capability.js";
import { generateSshKey } from "../credentials/ssh-keys.js";
import { fileSshKeyStore, type SshKeyStore } from "../ssh-key-store.js";
import { sshHandler } from "./ssh.handler.js";

// A ctx exposing only what sshHandler touches (files + workspace.root + capabilities.list + the key store), over a fresh
// temp workspace. HOME is pointed at a temp dir so the handler's ~/.ssh writes land there, not the real home, and the
// key store sits in a temp auth root of its own.
const tempCtx = (remaining: Capability[] = []): { ctx: CapabilityCtx; root: string; home: string; keys: SshKeyStore } => {
    const root = mkdtempSync(join(tmpdir(), "ssh-cap-ws-"));
    const home = mkdtempSync(join(tmpdir(), "ssh-cap-home-"));
    process.env["HOME"] = home;
    const keys = fileSshKeyStore(join(mkdtempSync(join(tmpdir(), "ssh-cap-auth-")), "ssh-keys"));
    const ctx = {
        workspace: { root },
        files: { write: writeWorkspaceFile, read: readWorkspaceFile, remove: removeWorkspacePath },
        capabilities: { list: async () => remaining },
        sshKeys: keys,
    } as unknown as CapabilityCtx;
    return { ctx, root, home, keys };
};

const pasted = generateSshKey("someone@laptop");
const box: Capability = { id: "box", kind: "ssh", config: { auth: "key", host: "1.2.3.4", port: 22, user: "root", privateKey: pasted.privateKey } };
// What a key with a passphrase reads as here: nothing ssh2 can load without one.
const locked: Capability = {
    id: "locked",
    kind: "ssh",
    config: { auth: "key", host: "9.9.9.9", port: 22, user: "root", privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nPRIV\n-----END OPENSSH PRIVATE KEY-----\n" },
};
const hostsPath = (home: string, file: string): string => join(home, ".ssh", "intentic-hosts", file);
const confPath = (home: string, id: string): string => hostsPath(home, `${id}.conf`);
const keyPath = (home: string, id: string): string => hostsPath(home, `${id}.key`);
const pubPath = (home: string, id: string): string => hostsPath(home, `${id}.pub`);
const skillPath = (root: string): string => join(root, ".agents", "skills", "ssh", "SKILL.md");

const drain = async (gen: AsyncGenerator<unknown>): Promise<void> => {
    for await (const _ of gen) {
        // consume the apply frames
    }
};

test("key auth: the key goes to the store, only its public half beside the alias; Include and skill written; status flips active", async () => {
    const { ctx, root, home, keys } = tempCtx();
    expect(await sshHandler.status(ctx, "box", box.config)).toEqual({ state: "inactive" });

    await drain(sshHandler.apply(ctx, "box", box.config));

    const conf = readFileSync(confPath(home, "box"), "utf8");
    expect(conf).toContain("Host box");
    expect(conf).toContain("HostName 1.2.3.4");
    expect(conf).toContain("User root");
    // ssh offers exactly this key, from the agent: the config names the public half, and no private key sits beside it.
    expect(conf).toContain(`IdentityFile "${pubPath(home, "box")}"`);
    expect(conf).toContain("IdentitiesOnly yes");
    expect(readFileSync(pubPath(home, "box"), "utf8")).toBe(`${pasted.publicKey}\n`);
    expect(existsSync(keyPath(home, "box"))).toBe(false);
    // The private half is the daemon's: in the store, 0600.
    expect(await keys.get("box")).toBe(pasted.privateKey);
    expect(statSync(keys.pathOf("box")).mode & 0o777).toBe(0o600);
    // ~/.ssh/config Includes the managed dir once.
    expect(readFileSync(join(home, ".ssh", "config"), "utf8")).toContain("Include intentic-hosts/*.conf");
    // One shared skill teaches the agent how to reach every connected machine.
    const skill = await readWorkspaceFile(skillPath(root));
    expect(skill).toContain("name: ssh");
    expect(skill).toContain("~/.ssh/intentic-hosts/");
    expect(skill).toContain("SSH_AUTH_SOCK");
    expect(skill).toContain("sshpass -f");
    expect(await sshHandler.status(ctx, "box", box.config)).toEqual({ state: "active" });
});

// The agent could never sign with a key it has no passphrase for, and the passphrase is what protects it in a file.
test("a key the agent cannot load (one with a passphrase) stays a 0600 file the alias names, as before", async () => {
    const { ctx, home, keys } = tempCtx();
    await drain(sshHandler.apply(ctx, "locked", locked.config));
    expect(readFileSync(confPath(home, "locked"), "utf8")).toContain(`IdentityFile "${keyPath(home, "locked")}"`);
    expect(statSync(keyPath(home, "locked")).mode & 0o777).toBe(0o600);
    expect(await keys.has("locked")).toBe(false);
});

test("password auth: writes a 0600 .pass file, no IdentityFile, nothing in the store", async () => {
    const pw: Capability = { id: "db", kind: "ssh", config: { auth: "password", host: "db.internal", port: 2222, user: "ops", password: "s3cret" } };
    const { ctx, home, keys } = tempCtx();
    await drain(sshHandler.apply(ctx, "db", pw.config));
    const passPath = hostsPath(home, "db.pass");
    expect(readFileSync(passPath, "utf8")).toBe("s3cret");
    expect(statSync(passPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(confPath(home, "db"), "utf8")).not.toContain("IdentityFile");
    expect(await keys.aliases()).toEqual([]);
});

// Where the key came from changes nothing about how it is used: the same store, the same public IdentityFile.
test("generated auth: signs in through the store exactly as a pasted key does", async () => {
    const pair = generateSshKey("intentic-box");
    const made: Capability = {
        id: "made",
        kind: "ssh",
        config: { auth: "generated", host: "5.6.7.8", port: 22, user: "deploy", privateKey: pair.privateKey },
    };
    const { ctx, home, keys } = tempCtx();
    await drain(sshHandler.apply(ctx, "made", made.config));
    const conf = readFileSync(confPath(home, "made"), "utf8");
    expect(conf).toContain("User deploy");
    expect(conf).toContain(`IdentityFile "${pubPath(home, "made")}"`);
    expect(await keys.get("made")).toBe(pair.privateKey);
    expect(existsSync(keyPath(home, "made"))).toBe(false);
    expect(existsSync(hostsPath(home, "made.pass"))).toBe(false);
});

// A machine switched from a key to a password must not keep the key it no longer signs in with, and back.
test("re-applying with the other kind of credential drops the one it replaced", async () => {
    const { ctx, home, keys } = tempCtx();
    await drain(sshHandler.apply(ctx, "box", box.config));
    await drain(sshHandler.apply(ctx, "box", { auth: "password", host: "1.2.3.4", port: 22, user: "root", password: "pw" }));
    expect(await keys.has("box")).toBe(false);
    expect(existsSync(pubPath(home, "box"))).toBe(false);
    expect(readFileSync(hostsPath(home, "box.pass"), "utf8")).toBe("pw");

    await drain(sshHandler.apply(ctx, "box", box.config));
    expect(existsSync(hostsPath(home, "box.pass"))).toBe(false);
    expect(await keys.has("box")).toBe(true);
});

test("remove drops the machine files but keeps the shared skill while another ssh machine remains", async () => {
    const other: Capability = { id: "box2", kind: "ssh", config: { auth: "key", host: "5.6.7.8", port: 22, user: "root", privateKey: "K2" } };
    // Store still holds box + box2 during removal of box.
    const { ctx, root, home, keys } = tempCtx([box, other]);
    await drain(sshHandler.apply(ctx, "box", box.config));

    await sshHandler.remove!(ctx, "box", box.config);
    expect(existsSync(confPath(home, "box"))).toBe(false);
    expect(existsSync(pubPath(home, "box"))).toBe(false);
    expect(await keys.has("box")).toBe(false);
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
