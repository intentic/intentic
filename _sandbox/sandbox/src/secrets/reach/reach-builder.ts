import type { AgentAccess, ManageRight } from "@intentic/sandbox-contract/schemas/members";
import { holdsRight, memberAccess } from "@intentic/sandbox-contract/schemas/members";
import type { ReachDevice, ReachLinkIn, ReachLinkOut, ReachServer, SandboxReach } from "@intentic/sandbox-contract/schemas/sandbox-reach";
import type { MemberTier } from "@intentic/sandbox-contract/schemas/shared";
import type { Member } from "../../auth/auth.js";
import { opt } from "../../opt.js";
import { reachAllows, reachOfPeople } from "../credential-reach.js";

// ONE SANDBOX'S TIES, SHAPED FOR WHOEVER ASKS (GET /system/reach, docs/architecture/accounts.md). The route gathers what
// the daemon stores; this decides what the reader is told of it, by the same rules the daemon enforces: whether their
// own conversations may use each card (they run agents here and their credential reach allows it,
// credential-reach.ts), how many other people's may (only for someone who runs people and access, who may read the
// roster anyway), and the inbound links and the machine it runs on (Full access's, as the Access page's are). Beside
// credential reach because that is what it reads: kept here, the system layer depends on nothing above it.

export interface ReachCaller {
    readonly email: string;
    readonly tier: MemberTier;
    readonly agents?: AgentAccess | undefined;
    readonly manages?: readonly ManageRight[] | undefined;
}

type Tie<T> = Omit<T, "yours" | "others">;

/** Whether the reader's own conversations may use one card, and how many other people's may. */
type CardAccess = Pick<ReachDevice, "yours" | "others">;

export interface ReachFacts {
    readonly caller: ReachCaller;
    readonly owner?: string | undefined;
    readonly roster: readonly Member[];
    readonly sandboxId?: string | undefined;
    readonly runsOn?: { readonly host?: string; readonly os?: string } | undefined;
    readonly org?: { readonly id: string; readonly name: string } | undefined;
    readonly linksOut: readonly Tie<ReachLinkOut>[];
    readonly linksIn: readonly ReachLinkIn[];
    readonly devices: readonly Tie<ReachDevice>[];
    readonly servers: readonly Tie<ReachServer>[];
    /** The fleet card's id, when the sandbox holds one. */
    readonly fleet?: string | undefined;
    readonly readAt: number;
}

const same = (left: string, right: string | undefined): boolean => right !== undefined && left.toLowerCase() === right.toLowerCase();

// Whether a person's conversations here run agents: the owner's always, a member's as their row's access says.
const runsAgents = (agents: AgentAccess): boolean => agents === "run" || agents === "home";

export const buildSandboxReach = (facts: ReachFacts): SandboxReach => {
    const { caller, owner, roster } = facts;
    const isOwner = caller.tier === "owner" || same(caller.email, owner);
    const full = isOwner || caller.tier === "maintainer";
    const readerAgents = isOwner || runsAgents(caller.agents ?? memberAccess({ tier: caller.tier }).agents);
    const allows = (email: string, card: string): boolean => reachAllows(reachOfPeople([email], roster, owner), "capability", card);

    // Everyone else who may sign in here, and of them those whose own conversations run agents.
    const others = [
        ...(owner === undefined || same(owner, caller.email) ? [] : [{ email: owner, agents: true }]),
        ...roster.filter((row) => !same(row.email, caller.email)).map((row) => ({ email: row.email, agents: runsAgents(memberAccess(row).agents) })),
    ];
    const countsOthers = holdsRight({ tier: isOwner ? "owner" : caller.tier, manages: caller.manages }, "people");
    const access = (card: string): CardAccess => ({
        yours: readerAgents && allows(caller.email, card),
        ...opt("others", countsOthers ? others.filter((person) => person.agents && allows(person.email, card)).length : undefined),
    });

    return {
        self: { ...opt("sandboxId", facts.sandboxId), ...opt("runsOn", full ? facts.runsOn : undefined), ...opt("org", facts.org) },
        reader: { tier: isOwner ? "owner" : caller.tier, agents: readerAgents },
        linksOut: facts.linksOut.map((link) => ({ ...link, ...access(link.card) })),
        ...opt("linksIn", full ? [...facts.linksIn] : undefined),
        devices: facts.devices.map((device) => ({ ...device, grants: [...device.grants], ...access(device.card) })),
        servers: facts.servers.map((server) => ({ ...server, ...access(server.card) })),
        ...opt("fleet", facts.fleet === undefined ? undefined : access(facts.fleet)),
        ...opt("people", countsOthers ? others.length : undefined),
        readAt: facts.readAt,
    };
};
