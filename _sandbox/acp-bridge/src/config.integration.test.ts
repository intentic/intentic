import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSessions, writeSessions } from "./config.js";

/* The session map is rewritten whole on every change, so what it could not read must survive the next write. */

let dir: string;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "acp-sessions-"));
});
afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

test("no session map yet reads as an empty one", () => {
    expect(readSessions(dir)).toEqual({});
});

test("a session map that cannot be parsed is kept aside, not overwritten by the next write", () => {
    const torn = `{"a": {"conversationId": "c1", "agent": "claude"}`;
    writeFileSync(join(dir, "sessions.json"), torn);
    expect(readSessions(dir)).toEqual({});
    writeSessions({ b: { conversationId: "c2", agent: "claude" } }, dir);
    const aside = readdirSync(dir).filter((name) => name.startsWith("sessions.json.unreadable-"));
    expect(aside.length).toBe(1);
    expect(readFileSync(join(dir, aside[0] ?? ""), "utf8")).toBe(torn);
    expect(readSessions(dir)).toEqual({ b: { conversationId: "c2", agent: "claude" } });
});

test("a write leaves no staging file behind", () => {
    writeSessions({ a: { conversationId: "c1", agent: "codex", providerSessionId: "p1" } }, dir);
    expect(readdirSync(dir)).toEqual(["sessions.json"]);
    expect(readSessions(dir)).toEqual({ a: { conversationId: "c1", agent: "codex", providerSessionId: "p1" } });
});
