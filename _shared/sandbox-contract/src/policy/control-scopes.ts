import { z } from "zod";

// One shared list (daemon, OpenAPI, site, mint form); widens downward except editor, its own narrow slice.
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

// Derived in the daemon from the same role floors a member holds (read=viewer, drive=collaborator).
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

// One control token as the roster lists it: everything but the secret, which the daemon keeps only as a hash.
export const ControlTokenSummarySchema = z.object({
    id: z.string(),
    label: z.string(),
    scope: ControlScopeSchema,
    createdAt: z.number(),
    // The owner or maintainer who minted it, so the roster says whose decision each token was.
    createdBy: z.string().optional(),
    // Epoch ms after which the token is refused; absent means it lives until revoked.
    expiresAt: z.number().optional(),
    // Epoch ms of the last authorized request, coarse on purpose; absent means never used.
    lastUsedAt: z.number().optional(),
});
export type ControlTokenSummary = z.infer<typeof ControlTokenSummarySchema>;
export const ControlTokensListSchema = z.object({ tokens: z.array(ControlTokenSummarySchema) });

// POST /system/control/tokens: scope is required, never defaulted; expiry is optional and absent means never.
export const ControlTokenMintSchema = z.object({
    scope: ControlScopeSchema,
    label: z.string().optional(),
    expiresAt: z.number().optional(),
});
export type ControlTokenMint = z.infer<typeof ControlTokenMintSchema>;
// The raw token, shown exactly once.
export const ControlTokenMintedSchema = z.object({ id: z.string(), token: z.string() });
export type ControlTokenMinted = z.infer<typeof ControlTokenMintedSchema>;
