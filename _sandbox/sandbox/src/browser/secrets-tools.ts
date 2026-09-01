import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { sdk } from "../claude/claude-sdk.js";
import { z } from "zod";
import type { SecretAccess } from "../agent/agent-secrets.js";
import { type NamedSecret, secretReference } from "../secrets/secret-registry.js";
import { browserAccountPage } from "./browser-sessions.js";
import { focusedEditable } from "./accounts-tools.js";

/* THE BROWSER EXIT: how a stored secret gets into a dashboard's form, a Grafana admin password into its
 * login, an API key into a service's settings page, without ever entering the model's context. The same
 * design rule as type_credential, widened from an account's own password to the sandbox's NAMED secrets: the
 * agent focuses the field with the browser tools, names the secret, and the daemon types the value over the
 * same CDP attach the /browsers view watches through.
 *
 * Deliberately ONLY the user-kept kinds (env, generated). A capability's credential already has its own lane
 *, type_credential for a browser account's password, the connector env vars for a CLI's token, and a tool
 * that would type ANY connector's credential into ANY page is exactly the confused deputy this machinery
 * exists not to build. The page's host is recorded on the use ledger, so "which secret went to which site" is
 * a question the Secrets view answers rather than a matter of trust. */

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

// The policy in one place: only the user-kept kinds are typeable, whatever else the registry holds.
export const typeableSecret = (registry: readonly NamedSecret[], name: string): NamedSecret | undefined =>
    registry.find((secret) => secret.name === name && (secret.source === "env" || secret.source === "generated"));

export interface SecretsToolsDeps {
    readonly secrets: SecretAccess;
    // The browsers this turn holds, as the same account→profile-owner map the router enforces with (plus
    // `web`→`web` when the credential-free browser is up). The tool types only into a browser the turn could
    // already drive, which is what scopes WHERE a value can land.
    readonly accounts: Record<string, string>;
}

export const secretsServer = (deps: SecretsToolsDeps): McpSdkServerConfigWithInstance =>
    sdk().createSdkMcpServer({
        name: "secrets",
        tools: [
            sdk().tool(
                "type_secret",
                "Type a stored secret into the FOCUSED field of a live browser page, a dashboard login, an API-key form. You never see the value: navigate with the browser tools, click the field, then call this with the secret's name (the same name `{{secret:name}}` masking shows you). Only user-kept secrets are typeable; an account's own password stays with type_credential.",
                {
                    browser: z.string().describe('Which browser holds the page: "web", or a browser account\'s capability id'),
                    name: z.string().describe("The stored secret's name, e.g. GRAFANA_ADMIN_PASSWORD"),
                },
                async ({ browser, name }) => {
                    const owner = deps.accounts[browser];
                    if (owner === undefined) {
                        return fail(`no browser "${browser}" this turn drives: it is "web" or one of the account ids whose tools you hold`);
                    }
                    let entry;
                    try {
                        entry = typeableSecret(await deps.secrets.list(), name);
                    } catch {
                        return fail("the secret store could not be read: try again");
                    }
                    if (entry === undefined) {
                        return fail(
                            `no typeable secret named "${name}": the name is what ${secretReference("…")} masking shows, and only user-kept ` +
                                "secrets (the Secrets view's own entries) can be typed; ask the owner to add it there if it does not exist yet",
                        );
                    }
                    const page = browserAccountPage(owner);
                    if (page === undefined) {
                        return fail(`"${browser}" has no live page: open the site with the browser tools first`);
                    }
                    if (!(await focusedEditable(page))) {
                        return fail("no text field is focused on the page: browser_click the field first, then call this again");
                    }
                    const host = ((): string => {
                        try {
                            return new URL(page.url()).host;
                        } catch {
                            return "the current page";
                        }
                    })();
                    // Same human-ish cadence as type_credential, some forms listen for the key events.
                    await page.keyboard.type(entry.value, { delay: 30 });
                    deps.secrets.used({ name, lane: "browser", detail: host });
                    return ok(`typed ${secretReference(name)} into the focused field on ${host} (value not shown)`);
                },
            ),
        ],
    });
