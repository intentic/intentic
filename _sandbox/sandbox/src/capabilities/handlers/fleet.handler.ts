import type { FleetConfig } from "@intentic/sandbox-contract";
import { answerError, type FleetWho } from "../../sandboxes/fleet-client.js";
import type { CapabilityHandler } from "../capability.js";

/* THE OWNER'S ACCOUNT, connected to one sandbox so that box can bring up others. The wallet's sibling one level up. */

// The token never reaches the agent's environment, unlike a `cli` connector's: the approval card on every create is
// only an approval while the agent cannot mint a claim behind it. So this kind has an `apply` that verifies and a
// `status` that re-verifies, and nothing that hands the value onward.

const whoOf = (body: string): FleetWho | undefined => {
    try {
        const parsed = JSON.parse(body) as { email?: unknown; label?: unknown };
        return typeof parsed.email === "string" ? { email: parsed.email, label: typeof parsed.label === "string" ? parsed.label : "" } : undefined;
    } catch {
        return undefined;
    }
};

export const fleetHandler: CapabilityHandler = {
    secret: () => "token",
    echo: (config) => ({ hasToken: (config as FleetConfig).token !== "" }),
    // One per sandbox and nothing is keyed by the name, so a rename would move nothing and mean nothing.
    rename: { refuse: "there is one account connection per sandbox, so its name is not a handle anything uses" },
    async *apply(ctx, _id, config) {
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
        yield { kind: "log", message: `Connected to ${who.email}${who.label === "" ? "" : ` as "${who.label}"`}.` };
        yield {
            kind: "log",
            message:
                "The agent can now run `sandboxes ls` and `sandboxes create`. Every create asks you in chat first and names the machine it would run on; new sandboxes land on a computer connected as a device, never on a hosted machine.",
        };
    },
    status: async (ctx, _id, config) => {
        const fleet = config as FleetConfig;
        const answer = await ctx.fleetWhoami(fleet.token);
        if (answer.status === 401 || answer.status === 403) {
            return { state: "error", detail: "that token was revoked or never verified; make a new one at Settings ▸ Tokens", code: "token" };
        }
        if (answer.status !== 200) {
            // A dead platform is not a dead token: the entry stays usable and says which of the two this is.
            return { state: "pending", detail: answerError(answer) };
        }
        const who = whoOf(answer.body);
        return who === undefined ? { state: "error", detail: "the platform's answer was unreadable" } : { state: "active", detail: who.email };
    },
    // Nothing was installed and nothing runs: removing the entry removes the token, which is the whole teardown. The
    // sandboxes it created are not touched, deliberately — they belong to the account, not to this connection.
    remove: async () => {},
};
