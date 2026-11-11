import { parseJsonWith } from "@intentic/base/json";
import { z } from "zod";

/* THE STEPS OF A MOVE BETWEEN COMPUTERS (2026-11-11, the `move-prepare`/`move-out`/`move-in` ops): the flow field the daemon
fills, and the lines both ics print, read by the daemon's move gate (sandboxes/move-gate.ts). */

// The plan is ic's own (`ic sandbox move-out --plan-only`), read here only for what the owner's card says: loose, so
// everything ic put in it reaches the target's ic unchanged, and the target's ic checks it whole.
export const DeviceMovePlanSchema = z.looseObject({
    v: z.number().int(),
    slug: z.string().min(1),
    // Every byte the copy carries: the volumes, and an image the target cannot pull or build.
    bytes: z.number().nonnegative(),
    running: z.boolean().optional(),
});
export type DeviceMovePlan = z.infer<typeof DeviceMovePlanSchema>;
// One `intentic-move: {json}` line either ic prints during a move: its step, and the fields the daemon reads. Loose,
// since each step carries fields of its own (a volume's `done`/`total`) that are only relayed.
export const DeviceMoveStepSchema = z.looseObject({
    step: z.string().min(1),
    plan: DeviceMovePlanSchema.optional(),
    publicKey: z.string().optional(),
    listen: z.array(z.string()).optional(),
    port: z.number().int().positive().optional(),
    reason: z.string().optional(),
    // On the source's `failed`: everything was sent and the connection broke before the target's verdict, so the source
    // stays stopped rather than risk two copies running; the daemon starts it again only if the target failed.
    ambiguous: z.boolean().optional(),
});
export type DeviceMoveStep = z.infer<typeof DeviceMoveStepSchema>;
const DEVICE_MOVE_LINE_PREFIX = "intentic-move: ";
// The step a printed line carries, or undefined for narration (and for a marker that is not one, printed as it came).
export const deviceMoveStepOf = (text: string): DeviceMoveStep | undefined => {
    if (!text.startsWith(DEVICE_MOVE_LINE_PREFIX)) {
        return undefined;
    }
    return parseJsonWith(text.slice(DEVICE_MOVE_LINE_PREFIX.length), DeviceMoveStepSchema);
};
// The move ops' own fields, daemon-filled and never the caller's. `id` names the move on both computers (ic's journal
// and the file `move-in` hands the key through). `stage` says which half of `move-out` runs: the read-only `plan`
// before the owner's card, or the `send`. `plan` is the source ic's own answer, carried verbatim to the target, which
// checks it again. `peer` is the other side's ephemeral public key, which only the daemon carries between the flows;
// marked secret so no log or view prints it, though it is no secret (the move's keys never leave either process).
// `connect` is where the target listens, `listen` lets the source fall back to a loopback port the daemon relays.
export const DeviceSandboxMoveSchema = z.strictObject({
    id: z.string().regex(/^[0-9a-f]{8,64}$/),
    stage: z.enum(["plan", "send"]).optional(),
    plan: DeviceMovePlanSchema.optional(),
    peer: z.string().min(1).optional().meta({ secret: true }),
    connect: z.array(z.string().min(1)).optional(),
    listen: z.boolean().optional(),
    manager: z.enum(["ic", "compose"]).optional(),
});
export type DeviceSandboxMove = z.infer<typeof DeviceSandboxMoveSchema>;
