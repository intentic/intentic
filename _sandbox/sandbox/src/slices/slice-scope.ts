import { type Fence, fenceCovers, type Slice } from "@intentic/sandbox-contract";
import type { Caller } from "../auth/auth.js";
import { foldersOf } from "./slices-store.js";

// Who is fenced to what, resolved in one place. Two readers ask it: a request, whose fence comes from the member row
// behind the bearer, and a turn, whose fence comes from the conversation it runs in. Both resolve slice ids to folders
// through the live manifest, so editing a slice moves every holder at once instead of only new grants.

/**
 * The folders this caller may touch. Undefined is the whole workspace: what an owner holds, what a caller with no
 * verified identity is (the owner's own tool — loopback, a panel), and what every member row written without slices
 * keeps.
 */
export const callerFence = (slices: readonly Slice[], caller: Caller | undefined): Fence => foldersOf(slices, caller?.slices);

/** The folders a conversation may touch, from the fence it was born with. Undefined is the whole workspace. */
export const conversationFence = (slices: readonly Slice[], entry: { readonly slices?: readonly string[] | undefined } | undefined): Fence =>
    foldersOf(slices, entry?.slices);

/**
 * Whether one fence covers another, in folders: what a checkout may be cut to, and what a card's slices may narrow
 * to. The id-level question — who may see or be handed a conversation — is `slicesCover` in auth/fleet-scope.ts,
 * which has to answer synchronously and so cannot read the manifest.
 */
export const fenceHolds = (holder: Fence, work: Fence): boolean => fenceCovers(holder, work);
