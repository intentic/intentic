import { type Fence, fenceCovers, type Area } from "@intentic/sandbox-contract";
import type { Caller } from "../auth/auth.js";
import { foldersOf } from "./areas-store.js";

// Who is fenced to what, resolved in one place. Two readers ask it: a request, whose fence comes from the member row
// behind the bearer, and a turn, whose fence comes from the conversation it runs in. Both resolve area ids to folders
// through the live manifest, so editing an area moves every holder at once instead of only new grants.

/**
 * The folders this caller may touch. Undefined is the whole workspace: what an owner holds, what a caller with no
 * verified identity is (the owner's own tool — loopback, a panel), and what every member row written without areas
 * keeps.
 */
export const callerFence = (areas: readonly Area[], caller: Caller | undefined): Fence => foldersOf(areas, caller?.areas);

/** The folders a conversation may touch, from the fence it was born with. Undefined is the whole workspace. */
export const conversationFence = (areas: readonly Area[], entry: { readonly areas?: readonly string[] | undefined } | undefined): Fence =>
    foldersOf(areas, entry?.areas);

/**
 * Whether one fence covers another, in folders: what a checkout may be cut to, and what a persona's own folders may
 * narrow to. The id-level question — who may see or be handed a conversation — is `areasCover` in auth/fleet-scope.ts,
 * which has to answer synchronously and so cannot read the manifest.
 */
export const fenceHolds = (holder: Fence, work: Fence): boolean => fenceCovers(holder, work);
