import { z } from "zod";

// WHAT A TARGET IMAGE COMPOSES FOR A SANDBOX, as the host reads it: the one line the image's own composer prints
// (`node /opt/sandbox/dist/environment/compose-overlay.js --base <image>`, _sandbox/sandbox/src/environment/compose-overlay.ts) over read-only
// mounts of the sandbox's volumes before a swap onto it, which `ic` builds instead of the overlay the running daemon
// composed (_sandbox/ic/src/sandbox/composition.rs). golden/compose-overlay.json holds examples the Rust test reads.

// The one format `ic` reads; any other, or none, sends it back to the running daemon's overlay.
export const COMPOSE_OVERLAY_FORMAT = 1;

export const ComposedOverlayLineSchema = z.object({
    compose: z.literal(COMPOSE_OVERLAY_FORMAT).describe("The format of this line. A reader takes no other."),
    overlay: z
        .string()
        .nullable()
        .describe("The Dockerfile the image's daemon composes on its first boot, byte for byte; null when the sandbox wants no overlay on it."),
    hash: z.string().optional().describe("sha256 of `overlay`, what the new container is stamped with (SANDBOX_ENVIRONMENT_HASH). Absent with no overlay."),
});
export type ComposedOverlayLine = z.infer<typeof ComposedOverlayLineSchema>;
