import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { bridgeScoped, fileBridgeTokens } from "./bridge-tokens.js";

const storePath = async (): Promise<string> => join(await mkdtemp(join(tmpdir(), "bridge-")), "bridge-tokens.json");

test("mint returns the raw token once and persists only its hash", async () => {
    const path = await storePath();
    const store = fileBridgeTokens(path);
    const { token } = await store.mint("zed on laptop");
    expect(token.startsWith("ibt_")).toBe(true);
    const raw = await readFile(path, "utf8");
    expect(raw.includes(token)).toBe(false);
    expect(await store.verify(token)).toBe(true);
    expect(await store.verify("ibt_not-the-token")).toBe(false);
    expect(await store.verify("")).toBe(false);
});

test("list echoes id/label/createdAt only; revoke takes effect immediately", async () => {
    const store = fileBridgeTokens(await storePath());
    const { id, token } = await store.mint("zed");
    const listed = await store.list();
    expect(listed).toEqual([{ id, label: "zed", createdAt: expect.any(Number) }]);
    expect(await store.revoke(id)).toBe(true);
    expect(await store.verify(token)).toBe(false);
    expect(await store.revoke(id)).toBe(false);
});

test("bridgeScoped allows exactly the agent-conversation surface", () => {
    expect(bridgeScoped("POST", "/agent")).toBe(true);
    expect(bridgeScoped("POST", "/agent/reply")).toBe(true);
    expect(bridgeScoped("GET", "/sessions")).toBe(true);
    expect(bridgeScoped("GET", "/sessions/abc")).toBe(true);
    expect(bridgeScoped("GET", "/workspace/search")).toBe(true);

    expect(bridgeScoped("GET", "/capabilities")).toBe(false);
    expect(bridgeScoped("POST", "/capabilities")).toBe(false);
    expect(bridgeScoped("GET", "/workspace/file")).toBe(false);
    expect(bridgeScoped("POST", "/history/restore")).toBe(false);
    expect(bridgeScoped("DELETE", "/sessions/abc")).toBe(false);
    expect(bridgeScoped("GET", "/agent")).toBe(false);
});
