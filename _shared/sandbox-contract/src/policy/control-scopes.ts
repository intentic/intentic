import { z } from "zod";

/* CONTROL-TOKEN SCOPES, the ladder a program's credential to a sandbox is minted on, shared by everything that
 * names one: the daemon (auth/control-tokens.ts decides what each reaches), the generated OpenAPI document
 * (its security scheme), the site's authorisation page, and the app's mint form. One list, so a scope added
 * here appears in the picker, the document and the daemon's reach table together, and a sentence about what a
 * rung reaches cannot be one thing on the site and another on the card.
 *
 * The ladder widens downward EXCEPT `editor`, which is its own narrow slice rather than a rung: an editor
 * bridge drives one conversation and has no business reading the fleet, and saying so costs one row. */
export const CONTROL_SCOPES = ["editor", "read", "drive", "land"] as const;
export type ControlScope = (typeof CONTROL_SCOPES)[number];
export const ControlScopeSchema = z.enum(CONTROL_SCOPES);

export interface ControlScopeReach {
    readonly scope: ControlScope;
    // What a token at this rung reaches, in one sentence a person minting one can act on.
    readonly reach: string;
    // The reason the rung exists, or the cost of holding it.
    readonly note: string;
}

/* The sentences, in ladder order. The reach itself is DERIVED in the daemon from the same role floors a member
 * is held to (a `read` token sees what a viewer sees, a `drive` token does what a collaborator does), so these
 * describe the tiers rather than enumerate routes, and the tiers are what the Access tab already teaches. */
export const CONTROL_SCOPE_REACH: readonly ControlScopeReach[] = [
    {
        scope: "editor",
        reach: "One conversation: run a turn, answer a card it parked on, read transcripts, search the tree.",
        note: "What an editor bridge holds. It cannot see the fleet and it cannot land work.",
    },
    {
        scope: "read",
        reach: "Everything a viewer sees: the fleet, transcripts, files, git state, CI runs, listening ports. Changes nothing.",
        note: "The one genuinely narrow rung, which is why it exists separately rather than as a politeness.",
    },
    {
        scope: "drive",
        reach: "Everything read sees, plus what a collaborator does: start, answer, steer and stop turns, rename and archive agents.",
        note: "Stops short of anything that moves code into the main tree. A stolen token at this rung is the agent's reach.",
    },
    {
        scope: "land",
        reach: "Everything drive does, plus merging a conversation's worktree into the main tree, and discarding or purging one.",
        note: "Separate because the usual arrangement is a program that works and a person who decides.",
    },
];
