import { z } from "zod";

// The hosted lane's offer, read before creation; `remaining` is this caller's own allowance left.
// `hours` describes the chosen tier: shared free hours or the new paid machine's own allowance.
// Absent when the platform does not meter this offer.
export const HostedHoursSchema = z.object({
    // Monthly ceiling and what's left, in whole hours; `remaining` floors, so "1 hour left" isn't a few minutes.
    allowance: z.number().int().nonnegative(),
    remaining: z.number().int().nonnegative(),
    // Present while a new account's ceiling is the ramp's rather than the month's: when the full one applies (ISO).
    rampUntil: z.iso.datetime().optional(),
});
export type HostedHours = z.infer<typeof HostedHoursSchema>;

export const HostedOfferSchema = z.object({
    enabled: z.boolean(),
    // Cloud entry can commit an idempotent create, select a paid tier and return checkout here.
    startJourney: z.boolean().optional(),
    // Omitted when unopened machines are kept. Applies to the machine and its files, not the registry row.
    unopenedDays: z.number().int().positive().optional(),
    remaining: z.number().int().nonnegative(),
    // The platform's fleet is full, no machine to give anyone; unrelated to this account's own `remaining`.
    full: z.boolean().optional(),
    hours: HostedHoursSchema.optional(),
    // True when the caller is on the hosted plan (or comped): their machines are never removed for going unopened.
    plan: z.boolean().optional(),
    // True when the hosted lane is switched off for this account (hosted-standing.ts); `remaining` is 0 with it.
    suspended: z.boolean().optional(),
    // True when a machine of ours can hold a project folder (`hostedProvision`'s `project`). Absent from a platform from
    // before hosted projects, which would drop that field unread, so the editor keeps a project on the reader's own
    // computer there.
    projects: z.boolean().optional(),
    // True when this account signs in only by email and holds no free paid slot: a free machine, the trial and Repair
    // need a Google sign-in linked to the account first (api sandbox/hosted/free-lane.ts), so the editor offers linking
    // Google, buying a machine, or running the sandbox on the reader's own computer. `remaining` is 0 with it.
    needsGoogle: z.boolean().optional(),
});
export type HostedOffer = z.infer<typeof HostedOfferSchema>;
