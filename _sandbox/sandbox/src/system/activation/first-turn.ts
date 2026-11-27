import { join } from "node:path";
import type { Logger } from "pino";
import { spokenByPerson } from "@intentic/sandbox-contract/schemas/speaker";
import { z } from "zod";
import type { DomainEventMap } from "../../seams/domain-events.js";
import { defineDocument } from "../../store/evolution/documents.js";
import { openDocument } from "../../store/open-document.js";
import { readJsonMarkerSync } from "../../store/plain-files/json-marker.js";

/* THE FIRST TURN A PERSON GOT DONE HERE (2026-11-26). The platform's funnel counted a sandbox as activated once its
 * daemon announced, which says a container came up, not that anybody got anything done in it, and product analytics
 * only sees the editor: a turn left to run hands-off finishes with no browser open. So the daemon records, once, the
 * moment the first turn a person started finished without failing, and every announce carries it (announce.ts), which
 * the platform keeps as the sandbox's `firstTurnAt` and counts as its activation (api admin-funnel.ts).
 *
 * Which settled runs count (seams/domain-events.ts, `run.settled`):
 *   - a person speaking: a member signed in at a door (spokenByPerson). Not a program holding a token a person minted,
 *     not the sandbox (an automation, a watch, a carry-on after a context or turn-cap stop), not an agent (a child's
 *     turn from its parent, a peer's message).
 *   - in their own words: no errand, so not the land-conflict brief the editor composes under their name.
 *   - finished: no failure, and not stopped.
 * A re-run the sandbox sent after a failure (a spent allowance, a restart) keeps the person as its speaker and carries
 * their own request, so its success counts: what they asked for got done. Recorded once and never moved, on the history
 * volume, so a restart or an update keeps it. A move to another sandbox leaves it behind: the target is another row on
 * the platform, and its first turn is its own. */

const FirstTurnSchema = z.object({
    // Epoch ms the run settled at. Every file written carries it; optional only so the store's stand-in for a file not
    // yet written is a value of the document's own shape.
    at: z.number().optional(),
});
export const firstTurnDocument = defineDocument({
    root: "history",
    path: "first-turn.json",
    // When the first turn a person started here finished without failing: this sandbox's own record with the platform,
    // which a moved sandbox starts again at its own first turn.
    portability: "identity",
    schema: FirstTurnSchema,
});

// Whether a settled run is the kind whose first success activates a sandbox (above).
export const firstTurnCounts = (settled: DomainEventMap["run.settled"]): boolean =>
    spokenByPerson(settled.speaker) && settled.errand === undefined && settled.failure === undefined && settled.stopped !== true;

// The recorded moment, for the announce, which goes out at boot before anything is awaited: read through the document's
// own schema without waiting, as the takeover marker beside it is. Undefined before one is recorded, for a daemon with no
// history volume (a headless run's), and for a file that cannot be read.
export const readFirstTurnNow = (historyRoot: string): number | undefined =>
    historyRoot === "" ? undefined : readJsonMarkerSync(join(historyRoot, firstTurnDocument.path), firstTurnDocument.schema)?.at;

// Records `at` unless a moment is already recorded; answers whether this call recorded it.
const recordFirstTurn = async (historyRoot: string, at: number): Promise<boolean> => {
    const file = openDocument(firstTurnDocument, join(historyRoot, firstTurnDocument.path), { fallback: () => ({}) });
    let recorded = false;
    await file.update((current) => {
        if (current.at !== undefined) {
            return current;
        }
        recorded = true;
        return { at };
    });
    return recorded;
};

export interface FirstTurnDeps {
    readonly historyRoot: string;
    readonly logger: Pick<Logger, "info" | "warn">;
    // Told once, as the moment is recorded, so the platform can hear of it now rather than at the next heartbeat.
    readonly recorded: () => void;
    readonly now?: () => number;
}

// The `run.settled` listener that records the first run that counts. Once one is known, read at boot or recorded since,
// every later run costs a flag. One that could not be written is tried again at the next run that counts.
export const firstTurnRecorder = (deps: FirstTurnDeps): ((settled: DomainEventMap["run.settled"]) => Promise<void>) => {
    const now = deps.now ?? Date.now;
    let known = deps.historyRoot === "" || readFirstTurnNow(deps.historyRoot) !== undefined;
    return async (settled) => {
        if (known || !firstTurnCounts(settled)) {
            return;
        }
        const at = now();
        // Before the write, so two runs settling together do not both write; the update keeps a recorded moment anyway.
        known = true;
        try {
            if (await recordFirstTurn(deps.historyRoot, at)) {
                deps.logger.info({ conversationId: settled.conversationId, at }, "first turn: the first turn a person started here finished, recorded for the platform");
                deps.recorded();
            }
        } catch (error) {
            known = false;
            deps.logger.warn({ err: error }, "first turn: the moment could not be recorded; the next finished turn tries again");
        }
    };
};
