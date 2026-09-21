import { type Fence, fenceAllows, fenceReaches, type SystemEvent } from "@intentic/sandbox-contract";
import { ORPCError } from "@orpc/server";
import type { Caller } from "./auth.js";

// What a caller may see of the fleet, on two independent narrowings. A GUEST sees the conversations they own or
// started and nothing else. A FENCED member — anyone granted areas of the workspace — sees only conversations whose
// own areas are among theirs. Everyone else sees the fleet whole, which is what the board's Everyone/Mine row is for.
// Neither narrowing is a preference: the transcript of someone else's wider conversation is the brain in prose, and
// fencing the files while leaving the transcripts open would be a fence with a door in it.
// Which persona cards that same fence hands over is the other half of it, and lives in personas/persona-reach.ts
// because it has to resolve area ids to folders, which is a file read this file cannot afford.

// The provenance fields every registry shape carries, which is all this needs to read.
export interface Provenance {
    readonly startedBy?: string | undefined;
    readonly owner?: { readonly email: string } | undefined;
    // The fence the conversation was born with, as area ids. Absent means it was started by someone unfenced.
    readonly areas?: readonly string[] | undefined;
}

const sameEmail = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

const theirs = (caller: Caller, agent: Provenance): boolean =>
    (agent.owner !== undefined && sameEmail(agent.owner.email, caller.email)) ||
    (agent.startedBy !== undefined && sameEmail(agent.startedBy, caller.email));

/**
 * Whether a holder's areas cover work born with these: the one rule behind both narrowings that involve a fence —
 * what a fenced member may read of the fleet, and who a conversation may be handed to.
 * Compared as ids, not as the folders behind them, so this stays a synchronous answer every route and every event
 * frame can afford; the area manifest is a file read, and this is asked once per conversation per frame.
 * The cost is conservatism: a member holding `finance` does not see work fenced to a different area that happens to
 * name a folder inside `finance`. It errs toward hiding, never toward showing.
 */
export const areasCover = (holder: readonly string[] | undefined, work: readonly string[] | undefined): boolean => {
    if (holder === undefined) {
        return true;
    }
    const held = new Set(holder);
    return work !== undefined && work.every((area) => held.has(area));
};

const withinFence = (caller: Caller, agent: Provenance): boolean => areasCover(caller.areas, agent.areas);

// Whether the caller may see this conversation. Undefined identity is the owner's own tool (a panel, loopback), which
// sees everything.
export const visibleTo = (caller: Caller | undefined, agent: Provenance): boolean => {
    if (caller === undefined) {
        return true;
    }
    if (caller.role === "guest" && !theirs(caller, agent)) {
        return false;
    }
    return withinFence(caller, agent);
};

// The refusal a guest meets on someone else's conversation. Unnamed on purpose: whose it is would say what the guest
// may not know.
export const refuseUnlessVisible = (caller: Caller | undefined, agent: Provenance): void => {
    if (!visibleTo(caller, agent)) {
        throw new ORPCError("FORBIDDEN", { message: "not one of your conversations" });
    }
};

// A path batch cut to the caller's own folders. An empty list already means "refetch the whole tree", and that
// refetch is itself fenced, so it rides on unchanged rather than being mistaken for a batch with nothing left in it.
const framedPaths = <T extends { readonly paths: readonly string[] }>(fence: Fence, event: T): T | undefined => {
    if (fence === undefined || event.paths.length === 0) {
        return event;
    }
    const paths = event.paths.filter((path) => fenceAllows(fence, path));
    return paths.length === 0 ? undefined : { ...event, paths };
};

// Repository ids are folder names; a fenced member is told about the ones they hold, and about the ones on the way
// down to them, since a repo above a held folder still explains a change inside it.
const framedRepos = <T extends { readonly repos: readonly string[] }>(fence: Fence, event: T): T =>
    fence === undefined ? event : { ...event, repos: event.repos.filter((repo) => fenceReaches(fence, repo)) };

// What a narrowed caller's event stream carries: the roster cut to the conversations they may see, and no path or
// repository they may not. Undefined drops the frame.
// `fence` is the caller's own, resolved once when the stream opens — an area edit revokes the connection, so a frame
// is never filtered against a fence its reader no longer has.
// One rule for every tier including a guest: a guest is always fenced (auth.ts MemberSchema) and reads its own area's
// files, so cutting its frames to that fence is what keeps its tree from going stale behind it.
export const framedEvent = (caller: Caller | undefined, fence: Fence, event: SystemEvent): SystemEvent | undefined => {
    if (caller === undefined) {
        return event;
    }
    switch (event.kind) {
        case "agents": {
            return { ...event, agents: event.agents.filter((agent) => visibleTo(caller, agent)) };
        }
        case "workspaceChanged":
        case "derivedChanged": {
            return framedPaths(fence, event);
        }
        case "reposChanged":
        case "refsChanged": {
            return framedRepos(fence, event);
        }
        default: {
            return event;
        }
    }
};
