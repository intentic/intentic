import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HISTORY_ROOT } from "@intentic/constants";
import { expect, test } from "vitest";
import { CONTROL_SCOPES, controlScoped, fileControlTokens } from "./control-tokens.js";

const storePath = async (): Promise<string> => join(await mkdtemp(join(tmpdir(), "control-")), "control-tokens.json");

test("mint returns the raw token once and persists only its hash", async () => {
    const path = await storePath();
    const store = fileControlTokens(path);
    const { token } = await store.mint("zed on laptop", "editor");
    expect(token.startsWith("ict_")).toBe(true);
    const raw = await readFile(path, "utf8");
    expect(raw.includes(token)).toBe(false);
    expect(await store.resolve(token)).toEqual({ id: expect.any(String), label: "zed on laptop", scope: "editor" });
    expect(await store.resolve("ict_not-the-token")).toBeUndefined();
    expect(await store.resolve("")).toBeUndefined();
});

test("resolve answers with the scope and label the token was minted at, per token", async () => {
    const store = fileControlTokens(await storePath());
    const editor = await store.mint("zed", "editor");
    const ci = await store.mint("github actions", "drive", { createdBy: "owner@example.com" });
    expect((await store.resolve(editor.token))?.scope).toBe("editor");
    expect(await store.resolve(ci.token)).toEqual({ id: ci.id, label: "github actions", scope: "drive" });
});

test("an expired token resolves to nothing, and its row still lists so the owner can see and revoke it", async () => {
    const store = fileControlTokens(await storePath());
    const now = Date.parse("2026-09-06T12:00:00Z");
    const { id, token } = await store.mint("nightly", "read", { expiresAt: now + 1_000 });
    expect((await store.resolve(token, now))?.id).toBe(id);
    expect(await store.resolve(token, now + 1_000)).toBeUndefined();
    expect((await store.list()).map((entry) => entry.id)).toEqual([id]);
});

test("touch marks the last use once a minute, never per request", async () => {
    const store = fileControlTokens(await storePath());
    const { id } = await store.mint("zed", "editor");
    const first = Date.parse("2026-09-06T12:00:00Z");
    await store.touch(id, first);
    await store.touch(id, first + 30_000);
    expect((await store.list())[0]?.lastUsedAt).toBe(first);
    await store.touch(id, first + 60_000);
    expect((await store.list())[0]?.lastUsedAt).toBe(first + 60_000);
    // A token revoked between authorize and touch writes nothing and throws nothing.
    await store.touch("gone", first);
});

test("list echoes every field but the hash; revoke takes effect immediately", async () => {
    const store = fileControlTokens(await storePath());
    const { id, token } = await store.mint("zed", "editor", { createdBy: "owner@example.com", expiresAt: 4_102_444_800_000 });
    const listed = await store.list();
    expect(listed).toEqual([{ id, label: "zed", scope: "editor", createdAt: expect.any(Number), createdBy: "owner@example.com", expiresAt: 4_102_444_800_000 }]);
    expect(await store.revoke(id)).toBe(true);
    expect(await store.resolve(token)).toBeUndefined();
    expect(await store.revoke(id)).toBe(false);
});

test("editor reaches exactly the agent-conversation surface: one conversation, not the fleet", () => {
    expect(controlScoped("editor", "POST", "/agent")).toBe(true);
    expect(controlScoped("editor", "POST", "/agent/reply")).toBe(true);
    expect(controlScoped("editor", "GET", "/sessions")).toBe(true);
    expect(controlScoped("editor", "GET", "/sessions/abc")).toBe(true);
    expect(controlScoped("editor", "GET", "/workspace/search")).toBe(true);

    expect(controlScoped("editor", "GET", "/capabilities")).toBe(false);
    expect(controlScoped("editor", "POST", "/capabilities")).toBe(false);
    expect(controlScoped("editor", "GET", "/workspace/file")).toBe(false);
    expect(controlScoped("editor", "POST", "/history/restore")).toBe(false);
    expect(controlScoped("editor", "DELETE", "/sessions/abc")).toBe(false);
    expect(controlScoped("editor", "GET", "/agent")).toBe(false);
    // Not a rung on the ladder: an editor bridge has no business reading the board.
    expect(controlScoped("editor", "GET", "/agents")).toBe(false);
});

// `read` is the viewer tier held by a program: every read a viewer member makes must work here too.
// Pinned on the routes the docs and a CI script actually reach for, so a floor moved to maintainer shows up here, not
// as a pipeline 403.
test("read observes everything a viewer sees and mutates nothing", () => {
    expect(controlScoped("read", "GET", "/agents")).toBe(true);
    expect(controlScoped("read", "GET", "/agents/abc/diff")).toBe(true);
    expect(controlScoped("read", "GET", "/agents/abc/transcript")).toBe(true);
    expect(controlScoped("read", "GET", "/ports")).toBe(true);
    expect(controlScoped("read", "GET", "/git/root/status")).toBe(true);
    expect(controlScoped("read", "GET", "/ci/runs")).toBe(true);
    expect(controlScoped("read", "GET", "/workspace/tree")).toBe(true);
    expect(controlScoped("read", "GET", "/workspace/file")).toBe(true);
    expect(controlScoped("read", "GET", "/sessions")).toBe(true);
    // Attaching to a running turn is a read that has to be a POST: it carries a replay cursor in its body.
    expect(controlScoped("read", "POST", "/agent/attach")).toBe(true);

    expect(controlScoped("read", "POST", "/agent")).toBe(false);
    expect(controlScoped("read", "POST", "/agent/steer")).toBe(false);
    expect(controlScoped("read", "POST", "/agents/abc/land")).toBe(false);
    expect(controlScoped("read", "POST", "/ports/forward")).toBe(false);
    expect(controlScoped("read", "POST", "/workspace/media-ticket")).toBe(false);
    expect(controlScoped("read", "GET", "/capabilities")).toBe(false);
    expect(controlScoped("read", "GET", "/secrets")).toBe(false);
    expect(controlScoped("read", "GET", "/logs")).toBe(false);
});

test("drive is the collaborator tier: it makes an agent work but cannot move code into the main tree", () => {
    expect(controlScoped("drive", "GET", "/agents")).toBe(true);
    expect(controlScoped("drive", "POST", "/agent")).toBe(true);
    expect(controlScoped("drive", "POST", "/agent/reply")).toBe(true);
    expect(controlScoped("drive", "POST", "/agent/resume")).toBe(true);
    expect(controlScoped("drive", "POST", "/agent/steer")).toBe(true);
    expect(controlScoped("drive", "POST", "/agent/stop")).toBe(true);
    expect(controlScoped("drive", "POST", "/agents/abc/rename")).toBe(true);
    expect(controlScoped("drive", "POST", "/agents/abc/seen")).toBe(true);
    expect(controlScoped("drive", "POST", "/agents/abc/resume-after-outage")).toBe(true);
    // A collaborator's landing is a request, and so is a drive token's.
    expect(controlScoped("drive", "POST", "/agents/abc/request-land")).toBe(true);
    // Archiving is reversible and collaborator-floored, so it sits here rather than on the land rung.
    expect(controlScoped("drive", "POST", "/agents/archive")).toBe(true);
    expect(controlScoped("drive", "POST", "/agents/unarchive")).toBe(true);

    // Writing bytes straight into the shared tree is the same act as landing, so `drive` doesn't reach the upload route
    // either.
    // A grant matches on method and path alone, never the target, so there's no attachment-shaped slice of this route
    // to hand a program.
    expect(controlScoped("drive", "POST", "/workspace/upload")).toBe(false);
    expect(controlScoped("drive", "POST", "/agents/abc/land")).toBe(false);
    expect(controlScoped("drive", "POST", "/agents/abc/discard")).toBe(false);
    expect(controlScoped("drive", "POST", "/agents/purge")).toBe(false);
    // Arming auto-land is a landing decision, so it floors at maintainer and no token reaches it.
    expect(controlScoped("drive", "POST", "/agents/abc/auto-land")).toBe(false);
    expect(controlScoped("drive", "POST", "/workspace/move")).toBe(false);
    expect(controlScoped("drive", "GET", "/secrets")).toBe(false);
});

test("land adds the irreversible half and still stops short of the owner-only surface", () => {
    expect(controlScoped("land", "POST", "/agents/abc/land")).toBe(true);
    expect(controlScoped("land", "POST", "/agents/abc/discard")).toBe(true);
    expect(controlScoped("land", "POST", "/agents/archive")).toBe(true);
    expect(controlScoped("land", "POST", "/agents/unarchive")).toBe(true);
    expect(controlScoped("land", "POST", "/agents/purge")).toBe(true);
    // Still inherits everything below it.
    expect(controlScoped("land", "POST", "/agent")).toBe(true);
    expect(controlScoped("land", "GET", "/agents")).toBe(true);
    expect(controlScoped("land", "GET", "/git/root/status")).toBe(true);

    // Land is the only maintainer-floored press a token holds; nothing else at that tier rides in with it.
    expect(controlScoped("land", "POST", "/agents/abc/auto-land")).toBe(false);
    expect(controlScoped("land", "POST", "/approvals")).toBe(false);
    expect(controlScoped("land", "POST", "/workspace/move")).toBe(false);
    expect(controlScoped("land", "GET", "/capabilities")).toBe(false);
    expect(controlScoped("land", "GET", "/secrets")).toBe(false);
    expect(controlScoped("land", "POST", "/history/restore")).toBe(false);
    expect(controlScoped("land", "POST", "/environment/approve")).toBe(false);
});

// The surface no token reaches, asserted over the union so a new scope can't quietly undercut it: adding one to
// CONTROL_SCOPES puts it in this loop automatically.
// Two kinds of route: ones already kept out by their floor, and ones a viewer member may open but a program must not
// (roster, sessions, tokens, money, network).
test("no scope reaches the sandbox's own trust surface: credentials, roster, sessions, tokens, money, network", () => {
    const forbidden: readonly (readonly [string, string])[] = [
        ["GET", "/secrets"],
        ["POST", "/secrets"],
        ["GET", "/capabilities"],
        ["POST", "/capabilities"],
        ["POST", "/environment/approve"],
        ["POST", `${HISTORY_ROOT}/restore`],
        ["GET", "/system/control/tokens"],
        ["POST", "/system/control/tokens"],
        ["POST", "/system/sessions/revoke"],
        ["POST", "/system/session"],
        ["POST", "/system/presence"],
        ["POST", "/system/ws-ticket"],
        ["POST", "/system/sync/pair"],
        ["GET", "/members"],
        ["DELETE", "/members/self"],
        ["GET", "/logs"],
        ["POST", "/logs/report"],
        ["GET", "/bundles"],
        ["GET", "/vpn"],
        ["GET", "/exit"],
        ["GET", "/wallet/status"],
        ["GET", "/pool/services"],
        ["POST", "/push/subscribe"],
        ["GET", "/children"],
    ];
    for (const scope of CONTROL_SCOPES) {
        for (const [method, path] of forbidden) {
            expect({ scope, method, path, allowed: controlScoped(scope, method, path) }).toEqual({ scope, method, path, allowed: false });
        }
    }
});
