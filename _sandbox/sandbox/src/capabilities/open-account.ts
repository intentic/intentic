import type { Capability, IdentityConfig } from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";
import { composeEnvironment } from "../environment/environment.js";
import { capabilityCtx } from "./capability.js";
import { registry } from "./registry.js";

/* THE AGENT OPENING AN ACCOUNT — the manifest half of "accounts become consequences, not setup steps". The
 * signup itself (driving the form, the SSO click, the code) is ordinary browser work in the identity's browser;
 * what needed a first-class verb is the part the agent could otherwise only do by editing manifest files: filing
 * a new browser entry under the identity so the skill, the tools and the card all exist.
 *
 * THE GATE IS THE IDENTITY'S OWN SWITCH, re-checked here on every call rather than trusted to the skill's
 * prose: automated signup is against most platforms' terms, so an identity whose owner has not explicitly
 * turned `openAccounts` on refuses — whatever the prompt said. Per identity, never global, and never a silent
 * default (the schema defaults it off).
 *
 * A deliberately thinner path than the add route: no extension gate (kind is pinned to browser), no requires
 * (browser has none), no post-apply process reconciliation (a browser entry starts nothing). The handler's
 * apply is the same one the route runs — it validates the platform card and the identity reference and writes
 * the skill — and composeEnvironment keeps the overlay honest, though a running identity browser means the
 * browser pack is already in the image and the hash will not move. */

export interface OpenAccountInput {
    readonly id: string;
    readonly platform: string;
    readonly identity: string;
}

const ENTRY_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

// Returns the human-readable summary of what happened (the handler's own log lines), or throws with a reason
// the model can act on.
export const openBrowserAccount = async (services: Services, input: OpenAccountInput): Promise<string> => {
    if (!ENTRY_ID.test(input.id) || input.id.length > 60) {
        throw new Error(`"${input.id}" is not a usable account id — letters, digits, dashes and underscores, starting with a letter or digit`);
    }
    const identity = await services.capabilities.get(input.identity);
    if (identity?.kind !== "identity") {
        throw new Error(`no identity "${input.identity}" — open_account files an account under an existing identity`);
    }
    if ((identity.config as IdentityConfig).openAccounts !== "on") {
        throw new Error(
            `the identity "${input.identity}" may not open accounts — its owner has not turned that on. Ask them to, or have them add the account themselves`,
        );
    }
    if ((await services.capabilities.get(input.id)) !== undefined) {
        throw new Error(`"${input.id}" already exists — pick another id, or act through the existing entry`);
    }
    const entry: Capability = { id: input.id, kind: "browser", config: { platform: input.platform, identity: input.identity } };
    const ctx = capabilityCtx(services);
    const lines: string[] = [];
    // IntenticLine is a loose frame (kind + whatever the step attached); the log lines' message is the human
    // half, and it is all this summary wants.
    for await (const line of registry.browser.apply(ctx, entry.id, entry.config)) {
        if (line.kind === "log" && typeof line["message"] === "string") {
            lines.push(line["message"]);
        }
    }
    await services.capabilities.upsert(entry);
    await composeEnvironment(services);
    return lines.join("\n");
};
