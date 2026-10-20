import { notifyingSandboxSecrets, type SandboxSecrets } from "./sandbox-secrets.js";

const memory = (): SandboxSecrets => {
    const kept = new Map<string, string>();
    return {
        all: async () => Object.fromEntries(kept),
        get: async (name) => kept.get(name),
        set: async (name, value) => void kept.set(name, value),
        remove: async (name) => kept.delete(name),
    };
};

test("a stored or removed secret is announced once it is written, and a removal that found nothing is no news", async () => {
    const heard: (string | undefined)[] = [];
    const store = memory();
    // What the store holds at each announcement: the write has landed before anyone hears of it.
    const secrets = notifyingSandboxSecrets(store, () => void store.get("GITHUB_TOKEN").then((value) => heard.push(value)));
    await secrets.set("GITHUB_TOKEN", "***");
    await Promise.resolve();
    expect(heard).toEqual(["***"]);
    expect(await secrets.remove("NOT_THERE")).toBe(false);
    expect(heard).toHaveLength(1);
    expect(await secrets.remove("GITHUB_TOKEN")).toBe(true);
    await Promise.resolve();
    expect(heard).toEqual(["***", undefined]);
});
