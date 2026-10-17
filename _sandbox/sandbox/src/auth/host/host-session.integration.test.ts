import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditEvent } from "@intentic/sandbox-contract/schemas/audit";
import { createAuthorizer, fileOwnerStore, type MembersStore, ownerDocument, type PasskeyPolicy } from "../auth.js";
import { AUDIT_INBOX_DIR, drainAuditInbox, HOST_SESSION_EXIT, HostSessionRefused, mintHostSession } from "./host-session.js";
import { createSessions } from "../session.js";

// A history volume of its own per test, laid out as the daemon lays it out.
const historyWith = async (owner?: string): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "host-session-"));
    if (owner !== undefined) {
        await mkdir(join(root, "identity"), { recursive: true });
        await writeFile(join(root, ownerDocument.path), JSON.stringify({ email: owner }));
    }
    return root;
};

const refusal = async (promise: Promise<unknown>): Promise<HostSessionRefused> => {
    try {
        await promise;
    } catch (error) {
        if (error instanceof HostSessionRefused) {
            return error;
        }
        throw error;
    }
    throw new Error("expected the mint to be refused");
};

const inbox = async (root: string): Promise<string[]> => readdir(join(root, AUDIT_INBOX_DIR)).catch(() => []);

// How netd marks a request that came in on the machine-published loopback port (auth/proofs/listener.ts).
const LOOPBACK = { listener: "loopback" } as const;

const noMembers: MembersStore = { list: async () => [], add: async () => undefined, remove: async () => undefined };

test("a sandbox nobody has bound yet mints nothing: the first binding still takes a real sign-in", async () => {
    const root = await historyWith();
    const refused = await refusal(mintHostSession({ historyRoot: root }));
    expect(refused.code).toBe(HOST_SESSION_EXIT.noOwner);
    expect(await inbox(root)).toEqual([]);
});

test("an owner file that cannot be read mints nothing, and says what moves it aside", async () => {
    const root = await historyWith();
    await mkdir(join(root, "identity"), { recursive: true });
    await writeFile(join(root, ownerDocument.path), "{half");
    const refused = await refusal(mintHostSession({ historyRoot: root }));
    expect(refused.code).toBe(HOST_SESSION_EXIT.ownerUnreadable);
    expect(refused.message).toContain("ic sandbox reset-owner");
});

test("a sandbox whose browser access was removed mints nothing", async () => {
    const root = await historyWith("owner@example.com");
    await writeFile(join(root, "browser-access-disabled"), "disabled");
    expect((await refusal(mintHostSession({ historyRoot: root }))).code).toBe(HOST_SESSION_EXIT.browserAccessRemoved);
});

test("the bound owner gets an ordinary daemon session proven by `host`, with the platform's id when it is known", async () => {
    const root = await historyWith("Owner@Example.com");
    const answer = await mintHostSession({ historyRoot: root, now: () => 42, platformId: async () => "cuid-1" });
    expect(answer.email).toBe("Owner@Example.com");
    expect(answer.platformId).toBe("cuid-1");
    // A week, not the month a browser sign-in lasts: a copy of the machine's cache is worth that little.
    expect(answer.expiresAt).toBeGreaterThan(Date.now() + 6.9 * 86_400_000);
    expect(answer.expiresAt).toBeLessThanOrEqual(Date.now() + 7 * 86_400_000);
    // The daemon's own verifier takes it, under the secret it signs every session with, created 0600.
    await expect(createSessions(join(root, "session-secret")).verify(answer.token)).resolves.toEqual({ email: "Owner@Example.com", methods: ["host"] });
    expect(((await stat(join(root, "session-secret"))).mode & 0o777).toString(8)).toBe("600");
    expect((await mintHostSession({ historyRoot: root })).platformId).toBeNull();
});

test("each mint leaves one note for the audit trail, which the daemon's tick records once and deletes, never the token", async () => {
    const root = await historyWith("owner@example.com");
    const { token } = await mintHostSession({ historyRoot: root, now: () => 42 });
    const notes = await inbox(root);
    expect(notes).toEqual([expect.stringMatching(/^42-[0-9a-f]{12}\.json$/)]);
    const note = join(root, AUDIT_INBOX_DIR, notes[0] ?? "");
    expect(await readFile(note, "utf8")).not.toContain(token);
    expect(((await stat(note)).mode & 0o777).toString(8)).toBe("600");
    const recorded: AuditEvent[] = [];
    const warned: string[] = [];
    await writeFile(join(root, AUDIT_INBOX_DIR, "0-junk.json"), "not an event");
    expect(await drainAuditInbox(root, (event) => recorded.push(event), (message) => warned.push(message))).toBe(1);
    expect(recorded).toEqual([
        { actor: { kind: "member", email: "owner@example.com", role: "owner" }, action: "auth.sign_in", details: { methods: ["host"], mintedAt: 42 } },
    ]);
    expect(warned).toHaveLength(1);
    expect(await inbox(root)).toEqual([]);
    // Nothing left: a second tick records nothing again, and a history volume with no inbox at all is not an error.
    expect(await drainAuditInbox(root, (event) => recorded.push(event), () => undefined)).toBe(0);
    expect(await drainAuditInbox(await historyWith(), () => undefined, () => undefined)).toBe(0);
});

test("the daemon authorizes a host session for its owner only, and the require-passkey policy lets it through", async () => {
    const root = await historyWith("owner@example.com");
    const sessions = createSessions(join(root, "session-secret"));
    const passkeys: PasskeyPolicy = { required: async () => true, enrolled: async () => true, exists: async () => true };
    const authorizer = createAuthorizer({
        verify: async () => {
            throw new Error("no Google here");
        },
        session: sessions.verify,
        passkeys,
        owner: fileOwnerStore(join(root, ownerDocument.path)),
        members: noMembers,
    });
    const { token } = await mintHostSession({ historyRoot: root });
    await expect(authorizer.authorize(token, undefined, LOOPBACK)).resolves.toMatchObject({ email: "owner@example.com", role: "owner", methods: ["host"] });
    // Owner moved on (another owner bound): the same session is somebody who is no longer on this sandbox.
    await writeFile(join(root, ownerDocument.path), JSON.stringify({ email: "next@example.com" }));
    await expect(authorizer.authorize(token, undefined, LOOPBACK)).rejects.toThrow("not authorized");
    // Signing out everywhere re-keys the secret, which ends every host session with the rest.
    await writeFile(join(root, ownerDocument.path), JSON.stringify({ email: "owner@example.com" }));
    await sessions.rotate();
    await expect(authorizer.authorize(token, undefined, LOOPBACK)).rejects.toThrow();
});

test("a host session stands on the loopback port alone: over the tunnel or any other way in, every door refuses it", async () => {
    const root = await historyWith("owner@example.com");
    const sessions = createSessions(join(root, "session-secret"));
    const authorizer = createAuthorizer({
        verify: async () => {
            throw new Error("no Google here");
        },
        session: sessions.verify,
        owner: fileOwnerStore(join(root, ownerDocument.path)),
        members: noMembers,
    });
    const { token } = await mintHostSession({ historyRoot: root });
    await expect(authorizer.authorizeOwner(token, "loopback")).resolves.toBeUndefined();
    await expect(authorizer.authorizeRecovery(token, "loopback")).resolves.toMatchObject({ role: "owner" });
    for (const listener of [undefined, "tunnel", "Loopback", ""]) {
        await expect(authorizer.authorize(token, undefined, { listener })).rejects.toThrow("only on this machine's own loopback port");
        await expect(authorizer.authorizeOwner(token, listener)).rejects.toThrow("only on this machine's own loopback port");
        await expect(authorizer.authorizeRecovery(token, listener)).rejects.toThrow("only on this machine's own loopback port");
        await expect(authorizer.authorizeRetirement(token, listener)).rejects.toThrow("only on this machine's own loopback port");
    }
    // A passkey added on the machine's own page keeps the session bound: the machine's word is still part of its proof.
    const upgraded = await sessions.mint({ email: "owner@example.com", methods: ["host", "passkey"] });
    await expect(authorizer.authorize(upgraded.token, undefined, { listener: "tunnel" })).rejects.toThrow("only on this machine's own loopback port");
    // Any other session is unaffected by the way in.
    const browser = await sessions.mint({ email: "owner@example.com", methods: ["google"] });
    await expect(authorizer.authorize(browser.token, undefined)).resolves.toMatchObject({ methods: ["google"] });
    expect(browser.expiresAt).toBeGreaterThan(Date.now() + 29 * 86_400_000);
});
