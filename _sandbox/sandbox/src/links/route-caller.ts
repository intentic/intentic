import type { Context } from "hono";
import type { AppEnv } from "../app-env.js";
import { peopleFor, type RouteCaller, routeCallerFrom } from "../account-routing/who-asks.js";
import { supervisorFor } from "../agent/subagents/children.js";
import { turnStandingOf } from "../conversations/actor/turn-standing.js";
import type { Services } from "../composition.js";

// Who a send to another sandbox comes from (account-routing/who-asks.ts), wired to this daemon: the proven conversation
// and the people it acts for, or nobody. Here rather than beside who-asks.ts because whether a turn may hand work on is
// the agent layer's word (children.ts); every routed send asks it, a report, a drop and a read alike.

/** Who a send to another sandbox comes from: its proven conversation and that conversation's people, or nobody. */
export const routeCallerOf = (
    services: Pick<Services, "agents" | "conversations" | "ownerEmail">,
    c: Pick<Context<AppEnv>, "req">,
): Promise<RouteCaller> =>
    routeCallerFrom(
        {
            peopleOf: (id) => peopleFor(services, id),
            ownerEmail: () => services.ownerEmail(),
            // A conversation this daemon planned no turn for (a person's own terminal stamped with it) is not held to the gate.
            mayHandOn: (id) => turnStandingOf(services.conversations, id) === undefined || supervisorFor(services.conversations, id) !== undefined,
        },
        c.req.header("x-intentic-conversation"),
        c.req.header("x-intentic-turn-proof"),
    );
