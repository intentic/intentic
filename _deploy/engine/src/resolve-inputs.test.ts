import { expect, test } from "vitest";

import { resolveInputs } from "./resolve-inputs.js";
import { createStore, PENDING } from "./store.js";

const env = { TOKEN: "secret-value" };

test("resolves a secret from env", () => {
    const out = resolveInputs({ apiToken: { $secret: { source: "env", key: "TOKEN" } } }, createStore(), env, { lenient: false });
    expect(out["apiToken"]).toBe("secret-value");
});

test("a missing secret throws in both strict and lenient mode", () => {
    const input = { x: { $secret: { source: "env", key: "MISSING" } } };
    expect(() => resolveInputs(input, createStore(), {}, { lenient: false })).toThrow('missing secret env var "MISSING"');
    expect(() => resolveInputs(input, createStore(), {}, { lenient: true })).toThrow('missing secret env var "MISSING"');
});

test("resolves an output ref to its stored value and a bare ref to the id", () => {
    const store = createStore();
    store.set("host", "host");
    store.set("host-git.url", "https://git.example.com");
    const out = resolveInputs({ server: { $ref: "host" }, instanceUrl: { $ref: "host-git.url" } }, store, env, { lenient: false });
    expect(out["server"]).toBe("host");
    expect(out["instanceUrl"]).toBe("https://git.example.com");
});

test("resolves nested objects and arrays recursively", () => {
    const out = resolveInputs(
        { env: { DATABASE_URL: { $secret: { source: "env", key: "TOKEN" } } }, list: ["a", { $secret: { source: "env", key: "TOKEN" } }] },
        createStore(),
        env,
        { lenient: false },
    );
    expect(out["env"]).toEqual({ DATABASE_URL: "secret-value" });
    expect(out["list"]).toEqual(["a", "secret-value"]);
});

test("a missing output ref: strict throws, lenient yields PENDING", () => {
    expect(() => resolveInputs({ x: { $ref: "ghost.url" } }, createStore(), env, { lenient: false })).toThrow(/ghost\.url/);
    const out = resolveInputs({ x: { $ref: "ghost.url" } }, createStore(), env, { lenient: true });
    expect(out["x"]).toBe(PENDING);
});

test("a literal {kind:'ref'} object is NOT treated as a ref (serialized form only)", () => {
    const out = resolveInputs({ x: { kind: "ref", resourceId: "host" } }, createStore(), env, { lenient: false });
    expect(out["x"]).toEqual({ kind: "ref", resourceId: "host" });
});
