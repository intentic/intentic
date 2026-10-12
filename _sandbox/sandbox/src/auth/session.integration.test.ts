import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignJWT } from "jose";
import { createSessions } from "./session.js";

const secretPath = async (): Promise<string> => join(await mkdtemp(join(tmpdir(), "session-")), "session-secret");

test("mint → verify roundtrips the proof: identity, display claims, methods and the passkey behind it", async () => {
    const sessions = createSessions(await secretPath());
    const { token, expiresAt } = await sessions.mint({
        email: "a@x.com",
        name: "Ada",
        picture: "https://p/x.png",
        methods: ["google", "passkey"],
        credentialId: "cred-1",
    });
    expect(expiresAt).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60 * 1000);
    await expect(sessions.verify(token)).resolves.toEqual({
        email: "a@x.com",
        name: "Ada",
        picture: "https://p/x.png",
        methods: ["google", "passkey"],
        credentialId: "cred-1",
    });
});

test("verify rejects garbage and tokens signed under another sandbox's secret", async () => {
    const sessions = createSessions(await secretPath());
    const other = createSessions(await secretPath());
    const { token } = await other.mint({ email: "a@x.com", methods: ["google"] });
    await expect(sessions.verify(token)).rejects.toThrow();
    await expect(sessions.verify("not-a-jwt")).rejects.toThrow();
});

test("the secret is created 0600 and reused, so sessions survive a daemon restart", async () => {
    const path = await secretPath();
    const before = createSessions(path);
    const { token } = await before.mint({ email: "a@x.com", methods: ["google"] });
    expect(((await stat(path)).mode & 0o777).toString(8)).toBe("600");
    // A new instance on the same path (the restarted daemon) verifies the old token.
    await expect(createSessions(path).verify(token)).resolves.toEqual({ email: "a@x.com", methods: ["google"] });
});

/* The sign-out-everywhere primitive. */
test("rotate invalidates every outstanding session, and the new secret persists across a restart", async () => {
    const path = await secretPath();
    const sessions = createSessions(path);
    const { token: before } = await sessions.mint({ email: "a@x.com", methods: ["google"] });
    await expect(sessions.verify(before)).resolves.toEqual({ email: "a@x.com", methods: ["google"] });

    await sessions.rotate();
    await expect(sessions.verify(before)).rejects.toThrow();

    // The sandbox stays usable: a session minted after the rotation verifies normally…
    const { token: after } = await sessions.mint({ email: "a@x.com", methods: ["google"] });
    await expect(sessions.verify(after)).resolves.toEqual({ email: "a@x.com", methods: ["google"] });
    // …and a restart honours the NEW secret, so a revoked token can't come back with the daemon.
    const restarted = createSessions(path);
    await expect(restarted.verify(after)).resolves.toEqual({ email: "a@x.com", methods: ["google"] });
    await expect(restarted.verify(before)).rejects.toThrow();
    expect(((await stat(path)).mode & 0o777).toString(8)).toBe("600");
});

// loadOrMintKey's rule: content too short to be a key is damage, replaced whole, and the key it answers is the one
// then on the disk, so the replacement is kept rather than living only in this process.
test("a truncated secret file is re-keyed instead of becoming a weak HMAC key, and the new key is the one kept", async () => {
    const path = await secretPath();
    await writeFile(path, "c2hvcnQ", "utf8");
    const sessions = createSessions(path);
    const { token } = await sessions.mint({ email: "a@x.com", methods: ["google"] });
    await expect(sessions.verify(token)).resolves.toEqual({ email: "a@x.com", methods: ["google"] });
    expect(Buffer.from((await readFile(path, "utf8")).trim(), "base64url").length).toBeGreaterThanOrEqual(32);
    await expect(createSessions(path).verify(token)).resolves.toEqual({ email: "a@x.com", methods: ["google"] });
    expect(((await stat(path)).mode & 0o777).toString(8)).toBe("600");
});

// Only absence or a short key mints: a secret that is there but cannot be read is never replaced, or every session
// signs out on a transient fault.
test("a secret that cannot be read refuses to mint and is left as it was", async () => {
    const path = await secretPath();
    await mkdir(path);
    const sessions = createSessions(path);
    await expect(sessions.mint({ email: "a@x.com", methods: ["google"] })).rejects.toThrow();
    expect((await stat(path)).isDirectory()).toBe(true);
});

// Two daemons' first boot on one file (spelled two ways, so neither shares the other's in-process load) keep one key:
// whichever loses the publish reads the winner's back.
test("two concurrent first loads of the secret agree on one key", async () => {
    const path = await secretPath();
    const [a, b] = [createSessions(path), createSessions(path.replace(/\/session-secret$/u, "/./session-secret"))];
    const [fromA, fromB] = await Promise.all([a.mint({ email: "a@x.com", methods: ["google"] }), b.mint({ email: "a@x.com", methods: ["google"] })]);
    await expect(b.verify(fromA.token)).resolves.toEqual({ email: "a@x.com", methods: ["google"] });
    await expect(a.verify(fromB.token)).resolves.toEqual({ email: "a@x.com", methods: ["google"] });
    await expect(createSessions(path).verify(fromA.token)).resolves.toEqual({ email: "a@x.com", methods: ["google"] });
});

// rotate() replaces a valid key, which loadOrMintKey never does: it writes its own, atomically, and keeps it 0600.
test("rotate replaces the stored key with a new full-length one that verifies what it mints", async () => {
    const path = await secretPath();
    const sessions = createSessions(path);
    await sessions.mint({ email: "a@x.com", methods: ["google"] });
    const before = await readFile(path, "utf8");
    await sessions.rotate();
    const after = await readFile(path, "utf8");
    expect(after).not.toBe(before);
    expect(Buffer.from(after.trim(), "base64url").length).toBe(32);
    const { token } = await sessions.mint({ email: "a@x.com", methods: ["google"] });
    await expect(createSessions(path).verify(token)).resolves.toEqual({ email: "a@x.com", methods: ["google"] });
    expect(((await stat(path)).mode & 0o777).toString(8)).toBe("600");
});

// The require-passkey policy reads `amr` off every session; a token with none would be one the policy cannot see.
test("a session signed with the right secret but carrying no proof claims is refused", async () => {
    const path = await secretPath();
    const sessions = createSessions(path);
    // Forces the secret file into being, then signs a claimless token under it.
    await sessions.mint({ email: "a@x.com", methods: ["google"] });
    const secret = Buffer.from((await readFile(path, "utf8")).trim(), "base64url");
    const claimless = await new SignJWT({})
        .setProtectedHeader({ alg: "HS256" })
        .setSubject("a@x.com")
        .setIssuer("intentic-sandbox-session")
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(secret);
    await expect(sessions.verify(claimless)).rejects.toThrow(/proof claims/);
});
