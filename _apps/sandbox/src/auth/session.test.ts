import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createSessions } from "./session.js";

const secretPath = async (): Promise<string> => join(await mkdtemp(join(tmpdir(), "session-")), "session-secret");

test("mint → verify roundtrips the identity, including the display claims", async () => {
    const sessions = createSessions(await secretPath());
    const { token, expiresAt } = await sessions.mint({ email: "a@x.com", name: "Ada", picture: "https://p/x.png" });
    expect(expiresAt).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60 * 1000);
    await expect(sessions.verify(token)).resolves.toEqual({ email: "a@x.com", name: "Ada", picture: "https://p/x.png" });
});

test("verify rejects garbage and tokens signed under another sandbox's secret", async () => {
    const sessions = createSessions(await secretPath());
    const other = createSessions(await secretPath());
    const { token } = await other.mint({ email: "a@x.com" });
    await expect(sessions.verify(token)).rejects.toThrow();
    await expect(sessions.verify("not-a-jwt")).rejects.toThrow();
});

test("the secret is created 0600 and reused, so sessions survive a daemon restart", async () => {
    const path = await secretPath();
    const before = createSessions(path);
    const { token } = await before.mint({ email: "a@x.com" });
    expect(((await stat(path)).mode & 0o777).toString(8)).toBe("600");
    // A new instance on the same path (the restarted daemon) verifies the old token.
    await expect(createSessions(path).verify(token)).resolves.toEqual({ email: "a@x.com" });
});

test("a truncated secret file is re-keyed instead of becoming a weak HMAC key", async () => {
    const path = await secretPath();
    await writeFile(path, "c2hvcnQ", "utf8");
    const sessions = createSessions(path);
    const { token } = await sessions.mint({ email: "a@x.com" });
    await expect(sessions.verify(token)).resolves.toEqual({ email: "a@x.com" });
    expect(Buffer.from((await readFile(path, "utf8")).trim(), "base64url").length).toBeGreaterThanOrEqual(32);
});
