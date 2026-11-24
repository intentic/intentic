import { ProjectClaimsSchema } from "@intentic/api-contract/ingress";
import { parseJsonOr } from "@intentic/base/json";
import type { Config } from "../env.config.js";
import { callPlatform } from "../system/platform-relay.js";
import { routeClientOf } from "../account-routing/route-client.js";

// What the platform's directory says about project claims (docs/architecture/account-routing.md), for the `projects`
// command and the claim card (needs/kinds/claim-need.ts): the projects this sandbox answers for, and which of the
// owner's sandboxes answers for one project now. Read only; a claim is written by the owner's own platform session.

export type ClaimedHere = { readonly ok: true; readonly projects: readonly string[] } | { readonly ok: false; readonly status: number; readonly problem: string };

// The projects this sandbox claims, as the platform lists them.
export const claimedHere = async (config: Config): Promise<ClaimedHere> => {
    const answer = await callPlatform(config, { route: "projectsMine", unreached: "nothing was read" });
    const claims = ProjectClaimsSchema.safeParse(parseJsonOr(answer.body, undefined));
    if (answer.status !== 200 || !claims.success) {
        return { ok: false, status: answer.status, problem: `the platform did not list this sandbox's projects (${answer.status}): ${answer.body.slice(0, 300)}` };
    }
    return { ok: true, projects: claims.data.projects };
};

// Who answers for a project on the owner's account, other than this sandbox: nobody, another sandbox (by name, where the
// platform could give one), or unknown with why. Asked after `claimedHere`, so "this sandbox" is already ruled out.
export type ClaimHolder =
    | { readonly state: "none" }
    | { readonly state: "other"; readonly name?: string }
    | { readonly state: "unknown"; readonly reason: string };

export const holderOf = async (config: Config, project: string): Promise<ClaimHolder> => {
    // A report as nobody in particular: the platform searches this sandbox's owner's claims, as it always did.
    const resolved = await routeClientOf({ config }).routeTo({ scope: "report", project });
    if (resolved.ok) {
        return { state: "other", name: resolved.value.name };
    }
    if (resolved.status === 404) {
        return { state: "none" };
    }
    // 409: claimed by a sandbox that has never come online, so the directory has no address (and no name) to give.
    return resolved.status === 409 ? { state: "other" } : { state: "unknown", reason: resolved.message };
};
