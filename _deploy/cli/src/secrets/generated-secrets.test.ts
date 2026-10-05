import { loadStoredSecrets } from "./generated-secrets.js";
import type { SecretStore } from "./secret-store.js";

const storeOf = (values: Record<string, string>, failing: readonly string[] = []): SecretStore & { writes: string[] } => {
    const writes: string[] = [];
    return {
        writes,
        get: async (key) => {
            if (failing.includes(key)) {
                throw new Error("host unreachable");
            }
            return values[key];
        },
        set: async (key) => {
            writes.push(key);
        },
    };
};

// A pruned node's own generated secret: the stores still hold it, the env (built from the current graph) does not.
test("loadStoredSecrets loads what a store holds and never mints what it does not", async () => {
    const store = storeOf({ ANN_PASSWORD: "stored" });
    const env: Record<string, string | undefined> = { SET_ALREADY: "env" };
    const unloaded = await loadStoredSecrets(store, ["ANN_PASSWORD", "SET_ALREADY", "NEVER_STORED"], env, () => {});
    expect(env).toEqual({ SET_ALREADY: "env", ANN_PASSWORD: "stored" });
    expect(unloaded).toEqual(["NEVER_STORED"]);
    expect(store.writes).toEqual([]);
});

test("loadStoredSecrets logs a store that cannot answer and leaves the key unset, instead of failing the apply", async () => {
    const logs: string[] = [];
    const env: Record<string, string | undefined> = {};
    const unloaded = await loadStoredSecrets(storeOf({}, ["ANN_PASSWORD"]), ["ANN_PASSWORD"], env, (line) => logs.push(line));
    expect(env).toEqual({});
    expect(unloaded).toEqual(["ANN_PASSWORD"]);
    expect(logs[0]).toContain('could not load "ANN_PASSWORD"');
});
