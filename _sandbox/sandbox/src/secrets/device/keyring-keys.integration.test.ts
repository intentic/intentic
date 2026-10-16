import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyringSandboxKeysSchema } from "@intentic/sandbox-contract";
import { signGrant, verifyGrant } from "@intentic/sandbox-contract/keyring-seal";
import { Hono } from "hono";
import { createKeyringKeysRoute, fileSandboxKeyringKeys } from "./keyring-keys.js";

// This sandbox's keyring keys on disk, and the one door that shows them: minted once, root-only, the same pair after a
// restart, and only the public halves ever answered.

const dirs: string[] = [];
afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const keysPath = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "intentic-keyring-keys-"));
    dirs.push(dir);
    return join(dir, "auth", "keyring-keys.json");
};

test("the first read mints both pairs into a root-only file, and every later reader gets the same ones", async () => {
    const path = await keysPath();
    const [first, again] = await Promise.all([fileSandboxKeyringKeys(path).pairs(), fileSandboxKeyringKeys(path).pairs()]);
    expect(again).toEqual(first);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    // A fresh process over the same file: the keys a keyring pinned are still the ones it signs with.
    expect(await fileSandboxKeyringKeys(path).pairs()).toEqual(first);
    const grant = signGrant(first.sign, {
        v: 1,
        sandbox: "https://sandbox-7.example.dev",
        secret: "VPN_PASSWORD",
        target: { kind: "sandbox", lane: "shell" },
        purpose: "agent",
        detail: "curl …",
        nonce: "A".repeat(22),
        issuedAt: 1_000,
        expiresAt: 61_000,
    });
    expect(verifyGrant((await fileSandboxKeyringKeys(path).publicKeys()).sign, grant, 2_000)).toMatchObject({ ok: true });
});

test("GET /keyring/keys answers the public halves and nothing else", async () => {
    const path = await keysPath();
    const keys = fileSandboxKeyringKeys(path);
    const app = new Hono().get("/keyring/keys", createKeyringKeysRoute(keys));
    const response = await app.request("/keyring/keys");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.text();
    const { sign, seal } = await keys.pairs();
    expect(KeyringSandboxKeysSchema.strict().parse(JSON.parse(body))).toEqual({ sign: sign.publicKey, seal: seal.publicKey });
    expect([body.includes(sign.privateKey), body.includes(seal.privateKey)]).toEqual([false, false]);
    // On disk the private halves are there, which is why the file is the auth root's and 0600.
    expect((await readFile(path, "utf8")).includes(sign.privateKey)).toBe(true);
});
