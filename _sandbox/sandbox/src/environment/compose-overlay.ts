import { parseArgs } from "node:util";
import { destination, pino } from "pino";
import { COMPOSE_OVERLAY_FORMAT, type ComposedOverlayLine } from "@intentic/sandbox-contract/schemas/compose-overlay";
import { createServices } from "../composition.js";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { loadConfig } from "../env.config.js";
import { composedOverlay } from "./overlay.js";
import { opt } from "../opt.js";

// THE OVERLAY THIS IMAGE WOULD COMPOSE FOR A SANDBOX, asked before a swap onto it. Run inside the TARGET image over
// read-only mounts of the running sandbox's volumes (`node /opt/sandbox/dist/environment/compose-overlay.js --base <image>`, ic's
// composition.rs), with the container's own runner-set environment replayed, it prints the overlay the target's daemon
// will compose on its first boot: its own capability fragments, its own feature packs left out where its own base bakes
// them. `ic` builds exactly that, so a swap that changes the daemon's pack steps no longer leaves one more rebuild
// pending behind it (the old daemon used to compose the overlay for the new image). One JSON line on stdout.

const { values } = parseArgs({ options: { base: { type: "string" } } });
if (values.base !== undefined && values.base.trim() !== "") {
    // What the new container is told it extends: the base its daemon composes FROM.
    process.env["SANDBOX_BASE_IMAGE"] = values.base.trim();
}

// Warnings (a fragment skipped, a policy unreadable) go to stderr, which ic keeps in its log; stdout is the answer alone.
const logger = pino({ level: "warn" }, destination(2));
const composed = await composedOverlay(createServices(loadConfig(), logger));
const line: ComposedOverlayLine = {
    compose: COMPOSE_OVERLAY_FORMAT,
    overlay: composed?.content ?? null,
    ...opt("hash", composed === undefined ? undefined : sha256Hex(composed.content)),
};
process.stdout.write(`${JSON.stringify(line)}\n`);
// Composing opened stores and timers the daemon would go on to use; the answer is all this run is for.
process.exit(0);
