import { sdkServerDoor } from "../../runtimes/daemon-tools/sdk-door.js";
import { NO_PROGRAMS } from "../../secrets/guards/program-guards.js";
import type { SecretAccess } from "../../secrets/secret-access.js";
import type { NamedSecret } from "../../secrets/secret-registry.js";
import { secretsServer, type SecretsToolsDeps, typeableSecret } from "./secrets-tools.js";

/* The one DECISION in the browser exit (the rest is CDP wiring over a live page, the accounts-tools posture). */

const registry: NamedSecret[] = [
    { name: "GRAFANA_ADMIN_PASSWORD", value: "gen-a8f2k1m4p7q9", source: "generated" },
    { name: "CLOUDFLARE_API_TOKEN", value: "cf_live_0011223344ff", source: "env" },
    { name: "reddit/password", value: "Xk4!mQ2pRt7@wZ9aBc1_", source: "capability" },
];

test("user-kept secrets are typeable, a capability's credential is not", () => {
    expect(typeableSecret(registry, "CLOUDFLARE_API_TOKEN")?.value).toBe("cf_live_0011223344ff");
    expect(typeableSecret(registry, "GRAFANA_ADMIN_PASSWORD")?.value).toBe("gen-a8f2k1m4p7q9");
    // Stored, maskable, resolvable in the shell, and still not typeable: its lane is type_credential.
    expect(typeableSecret(registry, "reddit/password")).toBeUndefined();
});

test("an unknown name is simply not found: the tool's error names the rule", () => {
    expect(typeableSecret(registry, "NOPE")).toBeUndefined();
});

/* The server as a turn sees it: the places it offers follow what the turn mounted, and a place it was not given is
   refused before anything is released. */

const released: string[] = [];
const access: SecretAccess = {
    list: async () => registry,
    used: () => undefined,
    release: async (names) => {
        released.push(...names);
        return { ok: true };
    },
};

const serverFor = (over: Partial<SecretsToolsDeps>) =>
    sdkServerDoor(
        secretsServer({
            secrets: access,
            accounts: {},
            keyrings: { link: { type: async () => ({ ok: false, code: "unavailable", refusal: "offline" }) }, listed: async () => [], programGuardFor: async () => NO_PROGRAMS },
            ...over,
        }),
    );

const call = async (deps: Partial<SecretsToolsDeps>, args: Record<string, unknown>) => {
    const answer = await serverFor(deps).handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "type_secret", arguments: args } });
    // SAFETY: the tool answers one text block, an error or not.
    const result = answer?.result as { content: { text: string }[]; isError?: boolean } | undefined;
    return { text: result?.content[0]?.text ?? "", isError: result?.isError === true };
};

test("the description names exactly the places this turn reaches", async () => {
    const listed = await serverFor({ devices: ["rog"] }).handle({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    // SAFETY: tools/list answers the one tool this server defines.
    const result = listed?.result as { tools: { description: string }[] } | undefined;
    const description = result?.tools[0]?.description ?? "";
    expect(description).toContain(`"rog" (the focused window on that computer`);
    expect(description).not.toContain('"desktop"');
    expect(description).not.toContain('"page"');
});

test("a computer the turn did not mount is refused before anything is released", async () => {
    released.length = 0;
    const answer = await call({ devices: ["rog"] }, { name: "CLOUDFLARE_API_TOKEN", where: "omen" });
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain(`"omen" is not a place this turn can type into`);
    expect(released).toEqual([]);
});

test("a phone is named together with the computer it is attached to", async () => {
    const answer = await call({ devices: ["rog"] }, { name: "CLOUDFLARE_API_TOKEN", phone: "R58M123" });
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain("set `where` to that computer (rog)");
});

test("a keyring's refusal comes back as the tool's error, with no value in it", async () => {
    const answer = await call({ devices: ["rog"] }, { name: "CLOUDFLARE_API_TOKEN", where: "rog" });
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain("nothing was typed: offline");
    expect(answer.text).not.toContain("cf_live_0011223344ff");
});
