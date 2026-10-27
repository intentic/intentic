import type { MemberSelf } from "@intentic/sandbox-contract/schemas/members";
import { memberAccess } from "@intentic/sandbox-contract/schemas/members";
import { memberRefusal } from "@intentic/sandbox-contract/protocol/member-reach";
import { demoAiAccounts, demoTier } from "./mode";
import { accessRequestOf } from "./fixture/access";
import { DEMO_USER } from "./platform";
import type { DemoHandler } from "./transport";

// THE TIER THE DEMO IS READ AS (`?as=`), HELD TO THE SAME FLOORS THE DAEMON HOLDS IT TO: the bearer middleware's own
// check (sandbox-contract protocol/member-reach.ts), answered with its own body, so a page looked at as a viewer meets
// what a viewer meets rather than an owner's daemon behind a viewer's shell. The editor foresees these refusals and
// never sends them (its client/sandbox/access/), so each one logged here is a request it failed to foresee: the
// access e2e (_tools/e2e/access/) reads these lines and fails on any.

/** What the daemon tells the person about themselves, for the tier the demo is read as. */
export const demoSelf = (): MemberSelf => {
    if (demoTier === `owner`) {
        return { role: `owner`, agents: `run`, edit: `all` };
    }
    const access = memberAccess({ role: demoTier });
    const self: MemberSelf = { role: demoTier, agents: access.agents, edit: access.edit === `all` || access.edit === `none` ? access.edit : [...access.edit] };
    if (access.see !== undefined) {
        self.areas = [...access.see];
    }
    if (demoAiAccounts !== undefined) {
        self.aiAccounts = [...demoAiAccounts];
    }
    const asked = accessRequestOf(DEMO_USER.email);
    if (asked !== undefined) {
        self.askedAt = asked.at;
    }
    return self;
};

/** The demo daemon, refusing below each route's floor for the tier the demo is read as. */
export const withFloors =
    (daemon: DemoHandler): DemoHandler =>
    async (request, url) => {
        if (demoTier === `owner`) {
            return daemon(request, url);
        }
        const self = demoSelf();
        const refusal = memberRefusal({ role: self.role, agents: self.agents, areas: self.areas }, request.method, url.pathname, url.searchParams.get(`path`) ?? undefined);
        if (refusal === undefined) {
            return daemon(request, url);
        }
        console.info(`[demo] ${demoTier} refused ${request.method} ${url.pathname}: ${refusal.error}`);
        return new Response(JSON.stringify(refusal), { status: 403, headers: { "content-type": `application/json` } });
    };
