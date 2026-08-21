import type { Capability, IdentityConfig } from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";
import { composeEnvironment } from "../environment/environment.js";
import { capabilityCtx } from "./capability.js";
import { contributionKey, contributionRegistry, hostOf } from "./contributions.js";
import { registry } from "./registry.js";

/* THE AGENT OPENING AN ACCOUNT, the manifest half of "accounts become consequences, not setup steps". The
 * signup itself (driving the form, the SSO click, the code) is ordinary browser work in the identity's browser;
 * what needed a first-class verb is the part the agent could otherwise only do by editing manifest files: filing
 * a new browser entry under the identity so the skill, the tools and the card all exist.
 *
 * THE GATE IS THE IDENTITY'S OWN SWITCH, re-checked here on every call rather than trusted to the skill's
 * prose: automated signup is against most platforms' terms, so an identity whose owner has not explicitly
 * turned `openAccounts` on refuses, whatever the prompt said. Per identity, never global, and never a silent
 * default (the schema defaults it off).
 *
 * A deliberately thinner path than the add route: no extension gate (kind is pinned to browser), no requires
 * (browser has none), no post-apply process reconciliation (a browser entry starts nothing). The handler's
 * apply is the same one the route runs, it validates the platform card and the identity reference and writes
 * the skill, and composeEnvironment keeps the overlay honest, though a running identity browser means the
 * browser pack is already in the image and the hash will not move.
 *
 * NO SITE IS UNFILEABLE, which is the whole reason this path can be the only record of an account. It used to
 * refuse any platform no installed extension declared, and a signup the agent could not file is a signup that
 * ends up written down somewhere else, by hand, in a file nothing keeps true. (It did: a hand-kept table of
 * identities × providers, already stale within days, and the only trace of four real accounts.) So an unknown
 * platform falls back to the GENERIC browser session, which exists for exactly this, a card with no site,
 * whose page and purpose are answered rather than pinned. The site card is a better skill when there is one;
 * its absence is now a difference in how well the agent knows the site, not in whether the account can exist. */

export interface OpenAccountInput {
    readonly id: string;
    readonly platform: string;
    readonly identity: string;
    // Where the account lives once signed in. Required only on the generic fallback, where nothing pins it.
    readonly homeUrl?: string | undefined;
    readonly loginUrl?: string | undefined;
    // What the account is for, in the agent's own words, the account's half of the roster, and the line a later
    // session reads when it asks whether this identity already has somewhere to sign in.
    readonly purpose: string;
}

const ENTRY_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

// The card that carries no site, used whenever the named platform has none of its own.
const GENERIC = "website";

// Returns the human-readable summary of what happened (the handler's own log lines), or throws with a reason
// the model can act on.
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
    /* WHICH CARD THIS ACCOUNT GETS. A site the sandbox knows brings its own URLs and cheatsheet; anything else
     * rides the generic session, which then needs the address the agent just signed up at, nothing pins it. */
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
            // Only ever set on the generic card: a site card pins its own, and passing them would be an unknown
            // field on a card that declares none.
            ...(known ? {} : { homeUrl: input.homeUrl as string, ...((input.loginUrl ?? "") === "" ? {} : { loginUrl: input.loginUrl as string }) }),
        },
    };
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
    // The fallback is said out loud: the agent asked for one platform and got a card that knows nothing about
    // the site, so the difference, it will have to read the pages rather than being taught them, is its to know.
    return known
        ? lines.join("\n")
        : `${lines.join("\n")}\nNo site card for "${input.platform}", so this account rides the generic browser session, you know the site only by what you read on it.`;
};
