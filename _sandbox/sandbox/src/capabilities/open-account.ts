import type { Capability, IdentityConfig } from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";
import { composeEnvironment } from "../environment/environment.js";
import { capabilityCtx } from "./capability.js";
import { contributionKey, contributionRegistry, hostOf } from "./contributions.js";
import { registry } from "./registry.js";

// Files a signup as a browser account entry so its skill, tools and card exist; refuses unless the identity's
// `openAccounts` config is `on`. An unknown platform falls back to the generic card rather than being unfileable.

export interface OpenAccountInput {
    readonly id: string;
    readonly platform: string;
    readonly identity: string;
    // Where the account lives once signed in; only required on the generic fallback.
    readonly homeUrl?: string | undefined;
    readonly loginUrl?: string | undefined;
    // What the account is for, in the agent's own words: a later session reads it to decide whether to reuse the
    // account.
    readonly purpose: string;
}

const ENTRY_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

// Fallback card for a platform with no site card of its own.
const GENERIC = "website";

// Returns the handler's log lines as one summary string, or throws with a reason the model can act on.
export const openBrowserAccount = async (services: Services, input: OpenAccountInput): Promise<string> => {
    if (!ENTRY_ID.test(input.id) || input.id.length > 60) {
        throw new Error(`"${input.id}" is not a usable account id: letters, digits, dashes and underscores, starting with a letter or digit`);
    }
    const identity = await services.capabilities.get(input.identity);
    if (identity?.kind !== "identity") {
        throw new Error(`no identity "${input.identity}": open_account files an account under an existing identity`);
    }
    if ((identity.config as IdentityConfig).openAccounts !== "on") {
        throw new Error(
            `the identity "${input.identity}" may not open accounts: its owner has not turned that on. Ask them to, or have them add the account themselves`,
        );
    }
    if ((await services.capabilities.get(input.id)) !== undefined) {
        throw new Error(`"${input.id}" already exists: pick another id, or act through the existing entry`);
    }
    const purpose = input.purpose.trim();
    if (purpose === "") {
        throw new Error(`say what "${input.id}" is for: one line, which is what a later session reads to know whether to reuse this account`);
    }
    const ctx = capabilityCtx(services);
    // A known platform gets its own card; otherwise the account rides the generic session and needs homeUrl.
    const known = (await contributionRegistry(hostOf(ctx))).has(contributionKey("browser", input.platform));
    const platform = known ? input.platform : GENERIC;
    if (!known && (input.homeUrl ?? "") === "") {
        throw new Error(
            `no site card for "${input.platform}", so the account rides the generic browser session: pass homeUrl (the page this account lives on once signed in) and it files fine`,
        );
    }
    const entry: Capability = {
        id: input.id,
        kind: "browser",
        config: {
            platform,
            identity: input.identity,
            purpose,
            openedAt: new Date().toISOString().slice(0, 10),
            // Set only on the generic card; a site card pins its own URLs and rejects unknown fields.
            ...(known ? {} : { homeUrl: input.homeUrl as string, ...((input.loginUrl ?? "") === "" ? {} : { loginUrl: input.loginUrl as string }) }),
        },
    };
    const lines: string[] = [];
    // IntenticLine is a loose frame; only the log lines' message field is used here.
    for await (const line of registry.browser.apply(ctx, entry.id, entry.config)) {
        if (line.kind === "log" && typeof line["message"] === "string") {
            lines.push(line["message"]);
        }
    }
    await services.capabilities.upsert(entry);
    await composeEnvironment(services);
    // States the fallback explicitly: the caller learns the site only from what it reads, not from a card.
    return known
        ? lines.join("\n")
        : `${lines.join("\n")}\nNo site card for "${input.platform}", so this account rides the generic browser session, you know the site only by what you read on it.`;
};
