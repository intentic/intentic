import { expect, test } from "vitest";
import type { NamedSecret } from "../secrets/secret-registry.js";
import { typeableSecret } from "./secrets-tools.js";

/* The one DECISION in the browser exit (the rest is CDP wiring over a live page, the accounts-tools posture):
 * which stored secrets may be typed into a page at all. Only the user-kept kinds — a capability's credential
 * already has its own lane (type_credential, the connector env vars), and a tool that would type ANY
 * connector's token into ANY page is the confused deputy this machinery exists not to build. */

const registry: NamedSecret[] = [
    { name: "GRAFANA_ADMIN_PASSWORD", value: "gen-a8f2k1m4p7q9", source: "generated" },
    { name: "CLOUDFLARE_API_TOKEN", value: "cf_live_0011223344ff", source: "env" },
    { name: "reddit/password", value: "Xk4!mQ2pRt7@wZ9aBc1_", source: "capability" },
];

test("user-kept secrets are typeable, a capability's credential is not", () => {
    expect(typeableSecret(registry, "CLOUDFLARE_API_TOKEN")?.value).toBe("cf_live_0011223344ff");
    expect(typeableSecret(registry, "GRAFANA_ADMIN_PASSWORD")?.value).toBe("gen-a8f2k1m4p7q9");
    // Stored, maskable, resolvable in the shell — and still not typeable: its lane is type_credential.
    expect(typeableSecret(registry, "reddit/password")).toBeUndefined();
});

test("an unknown name is simply not found — the tool's error names the rule", () => {
    expect(typeableSecret(registry, "NOPE")).toBeUndefined();
});
