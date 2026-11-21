import { z } from "zod";

// A message the free trial turned away as busy, which the sandbox sends again by itself on a short bounded backoff
// (the daemon's trial-retry.ts): which try its booking is, of how many. A booking a person re-times, a pick that moves
// the words, or a message sent after them takes it off, and the words go (or wait) as that person said.
export const QueuedTrialRetrySchema = z
    .object({
        made: z.number().int().min(1).describe("Which automatic try this booking is, counting from 1."),
        max: z.number().int().min(1).describe("How many automatic tries the sandbox makes before it leaves the message for a press."),
    })
    .describe(
        "Says `until` is the sandbox sending this message again by itself after the free trial turned it away as busy, not a time somebody chose. Absent on any other booking, and from sandboxes older than the field.",
    );
export type QueuedTrialRetry = z.infer<typeof QueuedTrialRetrySchema>;
