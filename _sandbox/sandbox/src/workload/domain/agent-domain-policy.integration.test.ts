import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDomainPolicySchema, SandboxSettingsWriteSchema } from "@intentic/sandbox-contract";
import { fileAgentDomainPolicy } from "./agent-domain-policy.js";

const fixture = async () => {
    const path = join(await mkdtemp(join(tmpdir(), "domain-policy-")), "agent-domain.json");
    return { path, store: fileAgentDomainPolicy(path) };
};

test("absent policy keeps the rollout off", async () => {
    const { store } = await fixture();
    expect(await store.get()).toEqual({ agentDomain: "root" });
});

test("the protected policy persists with mode 0600", async () => {
    const { path, store } = await fixture();
    await store.set({ agentDomain: "unprivileged" });
    expect(await fileAgentDomainPolicy(path).get()).toEqual({ agentDomain: "unprivileged" });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
});

test("corrupt and invalid policies never downgrade execution to root", async () => {
    const { path, store } = await fixture();
    for (const bytes of ["{broken", '{"agentDomain":"unknown"}']) {
        await writeFile(path, bytes);
        await expect(store.get()).rejects.toThrow("refusing agent execution");
        await expect(store.set({ agentDomain: "root" })).rejects.toThrow();
        expect(await readFile(path, "utf8")).toBe(bytes);
    }
});

test("workspace settings cannot carry the execution boundary", () => {
    expect(SandboxSettingsWriteSchema.parse({ agentDomain: "root" })).toEqual(SandboxSettingsWriteSchema.parse({}));
    expect(AgentDomainPolicySchema.parse({})).toEqual({ agentDomain: "root" });
});
