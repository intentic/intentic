import { z } from "zod";

// A person's message that reached the wrong sandbox, offered to the one it was meant for (account-routing.md, 2026-11-25).
// The words are the daemon's copy of what the person opened a turn with, never the agent's retelling, and only that
// person can press it: their editor, signed in to both, opens a chat in the target and sends the words there as they
// would by hand. No pass and no pairing travel. The platform only found the target among the sandboxes they are in.
export const REDIRECT_WORDS_MAX = 20_000;
export const RedirectNeedSchema = z.object({
    kind: z.literal("redirect"),
    target: z.string().min(1).max(40).describe("The target sandbox's tunnel id."),
    targetName: z.string().max(120).describe("Its name, as the platform gave it."),
    address: z.string().max(400).optional().describe("The target's address, as the platform gave it, which the card finds it by."),
    person: z.string().min(1).max(254).describe("Whose words they are, and the only one who can send them on."),
    words: z.string().max(REDIRECT_WORDS_MAX).describe("The message, exactly as the person sent it here."),
    clipped: z.boolean().optional().describe("The message was longer than the card carries, so only its head goes."),
    attachments: z.number().int().min(0).optional().describe("How many files went with it, which stay here."),
    project: z.string().max(400).optional().describe("The project the target was found by, when it was found by its claim."),
});
export type RedirectNeed = z.infer<typeof RedirectNeedSchema>;
