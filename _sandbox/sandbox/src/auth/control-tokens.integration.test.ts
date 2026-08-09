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
    expect(await store.scopeOf(token)).toBe("editor");
    expect(await store.scopeOf("ict_not-the-token")).toBeUndefined();
    expect(await store.scopeOf("")).toBeUndefined();
});

test("scopeOf answers with the scope the token was minted at, per token", async () => {
    const store = fileControlTokens(await storePath());
    const editor = await store.mint("zed", "editor");
    const ci = await store.mint("github actions", "drive");
    expect(await store.scopeOf(editor.token)).toBe("editor");
    expect(await store.scopeOf(ci.token)).toBe("drive");
});

test("list echoes id/label/scope/createdAt only; revoke takes effect immediately", async () => {
    const store = fileControlTokens(await storePath());
    const { id, token } = await store.mint("zed", "editor");
    const listed = await store.list();
    expect(listed).toEqual([{ id, label: "zed", scope: "editor", createdAt: expect.any(Number) }]);
    expect(await store.revoke(id)).toBe(true);
    expect(await store.scopeOf(token)).toBeUndefined();
    expect(await store.revoke(id)).toBe(false);
});

test("editor reaches exactly the agent-conversation surface — one conversation, not the fleet", () => {
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
    // Deliberately NOT a rung on the ladder: an editor bridge has no business reading the board.
    expect(controlScoped("editor", "GET", "/agents")).toBe(false);
});

test("read observes the fleet and mutates nothing", () => {
    expect(controlScoped("read", "GET", "/agents")).toBe(true);
    expect(controlScoped("read", "GET", "/agents/abc/diff")).toBe(true);
    expect(controlScoped("read", "GET", "/agents/abc/transcript")).toBe(true);
    expect(controlScoped("read", "GET", "/ports")).toBe(true);
    // Attaching to a running turn is a read that has to be a POST — it carries a replay cursor in its body.
    expect(controlScoped("read", "POST", "/agent/attach")).toBe(true);

    expect(controlScoped("read", "POST", "/agent")).toBe(false);
    expect(controlScoped("read", "POST", "/agent/steer")).toBe(false);
    expect(controlScoped("read", "POST", "/agents/abc/land")).toBe(false);
    expect(controlScoped("read", "POST", "/ports/forward")).toBe(false);
    expect(controlScoped("read", "GET", "/capabilities")).toBe(false);
    expect(controlScoped("read", "GET", "/secrets")).toBe(false);
});

test("drive makes an agent work but cannot move code into the main tree", () => {
    expect(controlScoped("drive", "GET", "/agents")).toBe(true);
    expect(controlScoped("drive", "POST", "/agent")).toBe(true);
    expect(controlScoped("drive", "POST", "/agent/steer")).toBe(true);
    expect(controlScoped("drive", "POST", "/agent/stop")).toBe(true);
    expect(controlScoped("drive", "POST", "/agents/abc/rename")).toBe(true);

    // The whole point of the rung below `land`.
    expect(controlScoped("drive", "POST", "/agents/abc/land")).toBe(false);
    expect(controlScoped("drive", "POST", "/agents/abc/discard")).toBe(false);
    expect(controlScoped("drive", "POST", "/agents/archive")).toBe(false);
    expect(controlScoped("drive", "POST", "/agents/purge")).toBe(false);
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

    expect(controlScoped("land", "GET", "/capabilities")).toBe(false);
    expect(controlScoped("land", "GET", "/secrets")).toBe(false);
    expect(controlScoped("land", "POST", "/history/restore")).toBe(false);
    expect(controlScoped("land", "POST", "/environment/approve")).toBe(false);
});

test("no scope reaches the credentials or the environment — the owner-only floor", () => {
    // The floor every scope shares, asserted over the union so a NEW scope cannot quietly undercut it: adding
    // one to CONTROL_SCOPES puts it in this loop without anybody remembering to.
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
        ["GET", "/vpn"],
    ];
    for (const scope of CONTROL_SCOPES) {
        for (const [method, path] of forbidden) {
            expect({ scope, method, path, allowed: controlScoped(scope, method, path) }).toEqual({ scope, method, path, allowed: false });
        }
    }
});
