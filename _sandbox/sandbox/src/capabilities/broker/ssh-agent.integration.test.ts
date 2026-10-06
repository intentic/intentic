import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { WORKSPACE_ROOT } from "@intentic/constants";
import { repoRoot } from "@intentic/constants/node";
import type { Capability } from "@intentic/sandbox-contract";
import type { ExtensionHost } from "../../extensions/installed-extensions.js";
import { readWorkspaceFile } from "../../workspace/files/workspace-files.js";
import { generateSshKey, loadPrivateKey } from "../credentials/ssh-keys.js";
import { credentialPolicies } from "./broker-policy.routes.js";
import type { CredentialCheck, CredentialVerdict } from "../../secrets/gates/credential-gate.js";
import type { HeldKey, SshSignUse } from "./ssh-agent.js";
import { createSshAgentSockets, type SshAgentSockets } from "./ssh-agent-sockets.js";

// The sandbox's ssh agent against OpenSSH's own client tools: `ssh-add -L` lists what it offers, and `ssh-keygen -Y
// sign` with only a PUBLIC key file has the agent make the signature, which `ssh-keygen -Y check-novalidate` then
// checks. That is the same agent conversation an `ssh <alias>` has, without a server to log in to.

const run = promisify(execFile);

// Short on purpose: a Unix socket path must fit in 107 bytes.
const shortDir = (prefix: string): string => mkdtempSync(join("/tmp", prefix));

// ssh-keygen writes a key of each type the agent signs with; ed25519 is what the sandbox itself generates.
const keygen = async (dir: string, name: string, type: "rsa" | "ecdsa"): Promise<string> => {
    const path = join(dir, name);
    await run("ssh-keygen", ["-q", "-t", type, "-N", "", "-C", name, "-f", path]);
    return readFileSync(path, "utf8");
};

// A connected machine's key unless `account` says it is a git account's: the owner's only, recorded nowhere.
const held = (alias: string, privateKey: string, account?: { readonly card: string }): HeldKey => {
    const key = loadPrivateKey(privateKey);
    if (key === undefined) {
        throw new Error(`test key ${alias} did not load`);
    }
    return account === undefined
        ? { alias, key, cards: [alias], forConversations: true, ledgerName: `${alias}/privateKey` }
        : { alias, key, cards: [account.card], forConversations: false };
};

const publicFile = (dir: string, alias: string, key: HeldKey): string => {
    const path = join(dir, `${alias}.pub`);
    writeFileSync(path, `${key.key.type} ${key.key.getPublicSSH().toString("base64")} ${alias}\n`);
    return path;
};

const withSocket = (socket: string) => ({ env: { ...process.env, SSH_AUTH_SOCK: socket } });

const listed = async (socket: string): Promise<string[]> =>
    (await run("ssh-add", ["-L"], withSocket(socket))).stdout
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => line.split(" ").slice(0, 2).join(" "));

// A signature over `data` made through the agent, then checked; true only when both steps pass.
const signsThrough = async (socket: string, publicPath: string, dir: string): Promise<boolean> => {
    const data = join(dir, `data-${String(Math.random()).slice(2)}`);
    writeFileSync(data, "what the server would ask the agent to sign\n");
    try {
        await run("ssh-keygen", ["-Y", "sign", "-n", "file", "-f", publicPath, data], withSocket(socket));
    } catch {
        return false;
    }
    const checked = await run("sh", ["-c", `ssh-keygen -Y check-novalidate -n file -s ${data}.sig < ${data}`]);
    return /Good "file" signature/u.test(`${checked.stdout}${checked.stderr}`);
};

interface Harness {
    readonly dir: string;
    readonly sockets: SshAgentSockets;
    readonly checks: CredentialCheck[];
    readonly uses: SshSignUse[];
}

const harness = (keys: readonly HeldKey[], gate: (check: CredentialCheck) => CredentialVerdict = () => ({ allow: true }), dir = shortDir("sa-")): Harness => {
    const checks: CredentialCheck[] = [];
    const uses: SshSignUse[] = [];
    const sockets = createSshAgentSockets({
        dir,
        tag: async (purpose) => Buffer.from(purpose).toString("base64url").slice(-12).padStart(12, "x"),
        keys: async () => keys,
        credentialGate: {
            check: async (check) => {
                checks.push(check);
                return gate(check);
            },
        },
        used: (use) => void uses.push(use),
        warn: () => {},
    });
    return { dir, sockets, checks, uses };
};

const scratch = shortDir("sa-keys-");
const ed25519 = held("box", generateSshKey("box").privateKey);
const rsa = held("rsabox", await keygen(scratch, "rsabox", "rsa"));
const ecdsa = held("ecbox", await keygen(scratch, "ecbox", "ecdsa"));
const account = held("github.com", generateSshKey("intentic-sandbox").privateKey, { card: "github" });

test("the owner's socket lists every held key and signs with each type, ed25519, rsa-sha2-512 and ecdsa alike", async () => {
    const { sockets } = harness([ed25519, rsa, ecdsa, account]);
    await sockets.start();
    try {
        expect(statSync(sockets.owner).mode & 0o777).toBe(0o600);
        expect(await listed(sockets.owner)).toHaveLength(4);
        for (const key of [ed25519, rsa, ecdsa, account]) {
            expect(await signsThrough(sockets.owner, publicFile(scratch, key.alias, key), scratch)).toBe(true);
        }
    } finally {
        await sockets.stop();
    }
});

test("nothing on the socket can load, remove or lock a key: only listing and signing are answered", async () => {
    const { sockets } = harness([ed25519]);
    await sockets.start();
    try {
        await expect(run("ssh-add", ["-D"], withSocket(sockets.owner))).rejects.toThrow();
        const extra = join(scratch, "extra");
        writeFileSync(extra, generateSshKey("extra").privateKey, { mode: 0o600 });
        await expect(run("ssh-add", [extra], withSocket(sockets.owner))).rejects.toThrow();
        expect(await listed(sockets.owner)).toHaveLength(1);
    } finally {
        await sockets.stop();
    }
});

test("a conversation's socket offers no git account key, signs through the card's gate, and records the use", async () => {
    const { sockets, checks, uses } = harness([ed25519, account]);
    await sockets.start();
    try {
        const socket = await sockets.forConversation("conv-1");
        expect(socket).toBeDefined();
        const path = socket ?? "";
        expect(path.startsWith(sockets.owner.replace("owner.sock", "c-conv-1."))).toBe(true);
        // The account key is the owner's: a turn's git goes through the credential gateway, where its rules apply.
        expect(await listed(path)).toEqual([`${ed25519.key.type} ${ed25519.key.getPublicSSH().toString("base64")}`]);
        expect(await signsThrough(path, publicFile(scratch, "account", account), scratch)).toBe(false);

        expect(await signsThrough(path, publicFile(scratch, "box", ed25519), scratch)).toBe(true);
        expect(checks.map(({ subject, kind, lane, detail, conversationId }) => ({ subject, kind, lane, detail, conversationId }))).toEqual([
            { subject: "box", kind: "capability", lane: "ssh", detail: "ssh box", conversationId: "conv-1" },
        ]);
        expect(uses).toEqual([{ alias: "box", ledgerName: "box/privateKey", conversationId: "conv-1" }]);
    } finally {
        await sockets.stop();
    }
});

test("a gate that does not release the card refuses the signature, and nothing is recorded", async () => {
    const { sockets, uses } = harness([ed25519], () => ({ allow: false, reason: "needs a named approver" }));
    await sockets.start();
    try {
        const socket = (await sockets.forConversation("conv-2")) ?? "";
        expect(await signsThrough(socket, publicFile(scratch, "box", ed25519), scratch)).toBe(false);
        expect(uses).toEqual([]);
    } finally {
        await sockets.stop();
    }
});

// A background job keeps its SSH_AUTH_SOCK across a daemon restart; the next run must be listening there again.
test("a conversation's socket is listening again after a restart, at the same path, and forgetting it closes it", async () => {
    const first = harness([ed25519]);
    await first.sockets.start();
    const socket = (await first.sockets.forConversation("conv-3")) ?? "";
    await first.sockets.stop();

    const second = harness([ed25519], undefined, first.dir);
    await second.sockets.start();
    try {
        expect(await listed(socket)).toHaveLength(1);
        await second.sockets.forget("conv-3");
        await expect(listed(socket)).rejects.toThrow();
    } finally {
        await second.sockets.stop();
    }

    // Forgotten is forgotten: a third run does not bring it back.
    const third = harness([ed25519], undefined, first.dir);
    await third.sockets.start();
    try {
        await expect(listed(socket)).rejects.toThrow();
    } finally {
        await third.sockets.stop();
    }
});

test("an id that is not a conversation id gets no socket", async () => {
    const { sockets } = harness([ed25519]);
    expect(await sockets.forConversation("../owner")).toBeUndefined();
    await sockets.stop();
});

// What the Secrets view and `secrets policy` say about each machine: a key the agent signs with through the ssh agent
// never reaches it; a password, or a key with a passphrase, does, and is labelled as handed over.
test("an SSH machine's credential reads as held by the ssh agent, or as handed over when nothing could sign for it", async () => {
    const machine = (id: string, config: Record<string, unknown>): Capability => ({ id, kind: "ssh", config: { host: "10.0.0.1", port: 22, user: "root", ...config } }) as Capability;
    const host = {
        workspace: { root: WORKSPACE_ROOT },
        files: { read: readWorkspaceFile },
        capabilities: {
            list: async (): Promise<Capability[]> => [
                machine("box", { auth: "generated", privateKey: generateSshKey("box").privateKey }),
                machine("db", { auth: "password", password: "pw" }),
                machine("locked", { auth: "key", privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nENCRYPTED\n-----END OPENSSH PRIVATE KEY-----\n" }),
            ],
        },
        config: { extensionsDir: join(repoRoot(import.meta.url), "_extensions"), historyRoot: shortDir("sa-history-") },
    } as unknown as ExtensionHost;

    const policies = await credentialPolicies(host, { of: async () => ({}) });

    expect([...policies.values()].map(({ subject, delivery, rules }) => ({ subject, delivery, rules }))).toEqual([
        { subject: "box", delivery: "ssh-agent", rules: [] },
        { subject: "db", delivery: "direct", rules: [] },
        { subject: "locked", delivery: "direct", rules: [] },
    ]);
});
