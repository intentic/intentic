// The desktop git bridge's view of a sandbox's repositories, on the ports list it already polls.
import { z } from "zod";
import { PortsListSchema } from "./ports.js";

// (2026-11-24) What the desktop git bridge used to ask over a fresh SSH login per repo every five seconds
// (`git ls-remote --symref sandbox HEAD`, plus an `ls /history/gits` every minute): two logins a second into a
// ten-repo sandbox. Answered on GET /ports from the git dirs' files instead, on the poll the device already makes.
// Kept out of schemas/ports, which extensions read under the extension API's version (extension-api/src/wire.ts): an
// extension has no use for it, and its parse of the list drops the field.
export const BridgeHeadSchema = z.object({
    repo: z.string().min(1).describe("The repository, as its git dir under /history/gits is named, decoded."),
    branch: z.string().min(1).optional().describe("The branch its HEAD names. Absent for a detached HEAD, which has no branch to follow."),
    tip: z
        .string()
        .regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/)
        .optional()
        .describe("The commit that branch points at. Absent while the branch has no commits yet."),
    probe: z
        .literal(true)
        .optional()
        .describe("Set when the sandbox could not read the head off its files (a ref format it does not parse): ask git over SSH instead."),
});
export type BridgeHead = z.infer<typeof BridgeHeadSchema>;

// The ports list as GET /ports answers it. `bridgeHeads` goes only to a desktop-sync caller (the `x-intentic-sync`
// header), and is absent from a sandbox from before 2026-11-24, whose device then keeps asking over SSH.
export const SyncPortsListSchema = PortsListSchema.extend({
    bridgeHeads: z
        .array(BridgeHeadSchema)
        .optional()
        .describe("Every repository's checked-out branch and its tip, for a paired computer's git bridge. Sent only to a desktop-sync caller."),
});
export type SyncPortsList = z.infer<typeof SyncPortsListSchema>;
