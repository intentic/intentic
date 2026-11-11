import { type FleetConfig, FleetConfigSchema } from "@intentic/sandbox-contract/schemas/capabilities";
import { answerError, type FleetWho } from "../../sandboxes/fleet-client.js";
import type { CapabilityCtx, CapabilityHandler } from "../capability.js";
import { parseJsonOr } from "@intentic/base/json";
import { opt } from "../../opt.js";

/* THE OWNER'S ACCOUNT, connected to one sandbox so that box can bring up others. The wallet's sibling one level up. */

// The token never reaches the agent's environment, unlike a `cli` connector's: the approval card on every create is
// only an approval while the agent cannot mint a claim behind it. So this kind has an `apply` that verifies and a
// `status` that re-verifies, and nothing that hands the value onward.
//
// (2026-11-11) The card is usually one Allow in the editor, which mints a token for this sandbox under the owner's
// session and saves it here with its platform id (`tokenId`). Such a token belongs to the card: removing the card, or
// replacing its token, revokes it on the platform, so nothing it could do outlives the card. A pasted token carries no
// id and is left alone, since it may be one the owner also gave another sandbox; it is revoked on Settings ▸ Tokens.

const whoOf = (body: string): FleetWho | undefined => {
    const parsed = parseJsonOr(body, undefined) as { email?: unknown; label?: unknown } | null | undefined;
    return typeof parsed?.email === "string" ? { email: parsed.email, label: typeof parsed.label === "string" ? parsed.label : "" } : undefined;
};

// Revokes a token minted for this card. Never fatal: a platform that cannot be reached leaves the token listed on
// Settings ▸ Tokens, where the owner revokes it by hand, and that is said in the log rather than holding the card.
const release = async (ctx: CapabilityCtx, fleet: FleetConfig, why: string): Promise<void> => {
    if (fleet.tokenId === undefined) {
        return;
    }
    const answer = await ctx.fleetRelease(fleet.token);
    // 401 is a token already revoked, which is the end this wanted.
    if (answer.status !== 200 && answer.status !== 401) {
        ctx.logger.warn({ tokenId: fleet.tokenId, status: answer.status }, `fleet: the token minted for this card was not revoked (${why}): ${answerError(answer)}`);
    }
};

// The token this card held before an apply replaced it, when that one was minted for the card.
const replacedToken = async (ctx: CapabilityCtx, id: string, next: FleetConfig): Promise<FleetConfig | undefined> => {
    const before = await ctx.capabilities.get(id);
    return before?.kind === "fleet" && before.config.token !== next.token ? before.config : undefined;
};

export const fleetHandler: CapabilityHandler = {
    secret: () => "token",
    echo: (config) => {
        const fleet = config as FleetConfig;
        return { hasToken: fleet.token !== "", ...opt("tokenId", fleet.tokenId) };
    },
    // One per sandbox and nothing is keyed by the name, so a rename would move nothing and mean nothing.
    rename: { refuse: "there is one account connection per sandbox, so its name is not a handle anything uses" },
    async *apply(ctx, id, config) {
        const fleet = config as FleetConfig;
        yield { kind: "log", message: "Checking the provisioning token with the platform…" };
        const answer = await ctx.fleetWhoami(fleet.token);
        if (answer.status !== 200) {
            yield { kind: "log", message: `The platform would not accept that token: ${answerError(answer)}` };
            return;
        }
        const who = whoOf(answer.body);
        if (who === undefined) {
            yield { kind: "log", message: "The platform's answer was unreadable. The entry stays pending, re-add it to retry." };
            return;
        }
        // Only once the new token is known good: a replacement the platform refuses leaves the old one working.
        const replaced = await replacedToken(ctx, id, fleet);
        if (replaced !== undefined) {
            await release(ctx, replaced, "its token was replaced");
        }
        yield { kind: "log", message: `Connected to ${who.email}${who.label === "" ? "" : ` as "${who.label}"`}.` };
        yield {
            kind: "log",
            message:
                "The agent can now run `sandboxes ls` and `sandboxes create`. Every create asks you in chat first and names the machine it would run on; new sandboxes land on a computer connected as a device, never on a hosted machine.",
        };
    },
    // The minted token's id stays with that token: kept when the same token is saved again without it (a form that has
    // no box for it), and dropped when a new token arrives under the old id (a token pasted over a minted one).
    installed: async (ctx, id, config) => {
        const fleet = FleetConfigSchema.parse(config);
        const before = await ctx.capabilities.get(id);
        const held = before?.kind === "fleet" ? before.config : undefined;
        if (held?.tokenId === undefined) {
            return fleet;
        }
        if (held.token === fleet.token) {
            return { ...fleet, tokenId: fleet.tokenId ?? held.tokenId };
        }
        return fleet.tokenId === held.tokenId ? { token: fleet.token } : fleet;
    },
    status: async (ctx, _id, config) => {
        const fleet = config as FleetConfig;
        const answer = await ctx.fleetWhoami(fleet.token);
        if (answer.status === 401 || answer.status === 403) {
            return { state: "error", detail: "that token was revoked; allow this sandbox again on its Sandbox fleet card", code: "token" };
        }
        if (answer.status !== 200) {
            // A dead platform is not a dead token: the entry stays usable and says which of the two this is.
            return { state: "pending", detail: answerError(answer) };
        }
        const who = whoOf(answer.body);
        return who === undefined ? { state: "error", detail: "the platform's answer was unreadable" } : { state: "active", detail: who.email };
    },
    // Nothing was installed and nothing runs: the token is the whole connection, so a token minted for this card is
    // revoked with it. The sandboxes it created are not touched, deliberately: they belong to the account, not to this
    // connection.
    remove: async (ctx, _id, config) => {
        await release(ctx, FleetConfigSchema.parse(config), "its card was removed");
    },
};
