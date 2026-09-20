import { type Fence, fenceAllows, fenceReaches, type SystemEvent } from "@intentic/sandbox-contract";
import { ORPCError } from "@orpc/server";
import type { Caller } from "./auth.js";

// What a caller may see of the fleet, on two independent narrowings. A DESK sees the conversations they own or
// started and nothing else. A FENCED member — anyone granted slices of the workspace — sees only conversations whose
// own slices are among theirs. Everyone else sees the fleet whole, which is what the board's Everyone/Mine row is for.
// Neither narrowing is a preference: the transcript of someone else's wider conversation is the brain in prose, and
// fencing the files while leaving the transcripts open would be a fence with a door in it.

// The provenance fields every registry shape carries, which is all this needs to read.
export interface Provenance {
    readonly startedBy?: string | undefined;
    readonly owner?: { readonly email: string } | undefined;
    // The fence the conversation was born with, as slice ids. Absent means it was started by someone unfenced.
    readonly slices?: readonly string[] | undefined;
}

const sameEmail = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

const theirs = (caller: Caller, agent: Provenance): boolean =>
    (agent.owner !== undefined && sameEmail(agent.owner.email, caller.email)) ||
    (agent.startedBy !== undefined && sameEmail(agent.startedBy, caller.email));

/**
 * Whether a holder's slices cover work born with these: the one rule behind both narrowings that involve a fence —
 * what a fenced member may read of the fleet, and who a conversation may be handed to.
 * Compared as ids, not as the folders behind them, so this stays a synchronous answer every route and every event
 * frame can afford; the slice manifest is a file read, and this is asked once per conversation per frame.
 * The cost is conservatism: a member holding `finance` does not see work fenced to a different slice that happens to
 * name a folder inside `finance`. It errs toward hiding, never toward showing.
 */
export const slicesCover = (holder: readonly string[] | undefined, work: readonly string[] | undefined): boolean => {
    if (holder === undefined) {
        return true;
    }
    const held = new Set(holder);
    return work !== undefined && work.every((slice) => held.has(slice));
};

const withinFence = (caller: Caller, agent: Provenance): boolean => slicesCover(caller.slices, agent.slices);

// Whether the caller may see this conversation. Undefined identity is the owner's own tool (a panel, loopback), which
// sees everything.
export const visibleTo = (caller: Caller | undefined, agent: Provenance): boolean => {
    if (caller === undefined) {
        return true;
    }
    if (caller.role === "desk" && !theirs(caller, agent)) {
        return false;
    }
    return withinFence(caller, agent);
};

// The refusal a desk meets on someone else's conversation. Unnamed on purpose: whose it is would say what the desk
// may not know.
export const refuseUnlessVisible = (caller: Caller | undefined, agent: Provenance): void => {
    if (!visibleTo(caller, agent)) {
        throw new ORPCError("FORBIDDEN", { message: "not one of your conversations" });
    }
};

// A desk may act only through the personas it holds; naming none is refused too, since an unpinned attended chat reaches
// every account, which is exactly what a desk is not handed.
export const refuseUnlessHeld = (caller: Caller | undefined, actsAs: string | undefined): void => {
    if (caller === undefined || caller.role !== "desk") {
        return;
    }
    const held = caller.desks ?? [];
    if (actsAs === undefined || !held.includes(actsAs)) {
        throw new ORPCError("FORBIDDEN", {
            message:
                actsAs === undefined
                    ? `a desk speaks through one of its personas: ${held.join(", ")}`
                    : `"${actsAs}" is not one of your personas: ${held.join(", ")}`,
        });
    }
};

// Which persona ids a desk holds; undefined for every other tier, meaning no narrowing.
export const heldPersonas = (caller: Caller | undefined): ReadonlySet<string> | undefined =>
    caller !== undefined && caller.role === "desk" ? new Set(caller.desks ?? []) : undefined;

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
// `fence` is the caller's own, resolved once when the stream opens — a slice edit revokes the connection, so a frame
// is never filtered against a fence its reader no longer has.
export const framedEvent = (caller: Caller | undefined, fence: Fence, event: SystemEvent): SystemEvent | undefined => {
    if (caller === undefined) {
        return event;
    }
    // A desk has no file view at all, so a path or a repository says nothing it can act on.
    const desk = caller.role === "desk";
    switch (event.kind) {
        case "agents": {
            return { ...event, agents: event.agents.filter((agent) => visibleTo(caller, agent)) };
        }
        case "workspaceChanged":
        case "derivedChanged": {
            return desk ? undefined : framedPaths(fence, event);
        }
        case "reposChanged":
        case "refsChanged": {
            return desk ? undefined : framedRepos(fence, event);
        }
        default: {
            return event;
        }
    }
};
