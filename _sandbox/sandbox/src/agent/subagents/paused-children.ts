import type { Services } from "../../composition.js";
import { sayToParent } from "../../conversations/land/child-lands.js";
import { liveRunOf, turnRunOf } from "../../conversations/actor/conversation-holdings.js";
import type { ConversationEvent } from "../../conversations/actor/conversation-decide.js";
import { CHILDREN, keepChild, settleChild } from "./child-records.js";
import { taskLine } from "./child-spec.js";
import { noRerun } from "./child-words.js";
import type { ChildRecord } from "./children.js";
import { noteSpawnedChild } from "./subagents.js";

// A paused child: one whose turn ended on a wall the sandbox re-runs it past by itself (a spent allowance, a turn that
// stopped short). Its parent was told not to send the task again because the re-run is coming, so the pause ends as
// failed, said to the parent, once the re-run is found gone. The pause is a state of the child's own record
// (child-records.ts, `paused` on its file), and only there: a restart brings it back with the child, and the boot puts it
// back on this same watch while its re-run is still booked (child-restore.ts). 2026-10-20: a second ledger of pauses,
// settled by its own boot pass, told parents "a restart drops that booking" after held turns had become durable, while
// the child's own restore was waiting for that very booking, and nothing watched the restored pause.

// How often a paused child looks whether the re-run it waits for is still coming, and how many looks in a row may find
// it gone before the pause ends as failed; two, since a re-run firing is a moment with no hold and no run yet. Since
// 2026-10-20 the slow fallback only: the events below settle a lapse within seconds, and this catches one they missed.
const PAUSE_LOOK_MS = 15_000;
const PAUSE_MISSES = 2;

// The actor's events after which the booked re-run may be gone for good: the hold dropped (a cancel, an outage's or a
// re-mint's give-up), given up with words on the card, or a ladder that stood down. Each used to be noticed by the look
// above, 30 to 45 seconds later (2026-10-20).
const RERUN_GONE: ReadonlySet<ConversationEvent["kind"]> = new Set(["resume-dropped", "resume-abandoned", "ladder-spent"]);

// When such an event is followed by two looks: an outage's re-run drops its hold a moment before it starts the turn
// (turn-resume.ts), so one look could land in that moment. Both must find the re-run gone, as two misses of the slow
// look must.
const GONE_LOOKS_MS = [1_000, 5_000] as const;

/**
 * Ends a child's pause, whatever ends it: its re-run starting, a message from its parent, a cancel (its parent's, or its
 * family's as a parent leaves), or the re-run lapsing. Its file says so at the child's next write.
 */
export const endPause = (kid: ChildRecord): void => {
    kid.paused?.stop();
    kid.paused = undefined;
};

// Whether the re-run a paused child waits for is gone right now: no run of its own, and no hold still to fire.
const rerunGone = (services: Services, childId: string): boolean => {
    const held = services.conversations.state(childId)?.resume.held;
    return liveRunOf(services.conversations, childId) === undefined && (held === undefined || held.fired);
};

// Ends the pause as failed and tells the parent, once the re-run is found gone.
const lapse = (services: Services, childId: string, parent: string, kid: ChildRecord, failure: string): void => {
    const ranElsewhere = turnRunOf(services.conversations, childId)?.id !== kid.paused?.run;
    endPause(kid);
    const lapsed = `${failure} ${noRerun(ranElsewhere)}`;
    settleChild(services.conversations, childId, { status: "failed", report: kid.report ?? "", error: lapsed });
    keepChild(services, childId);
    void sayToParent(services, parent, `Your subagent \`${childId}\` ("${taskLine(kid.spec)}") stays stopped: ${lapsed}`);
};

// A turn that ended on a wall the sandbox re-runs it past by itself is paused, not finished: its row stays live so its
// parent's wait keeps covering it, says when the re-run comes and how to stop it, and ends as failed if it never does.
// The same watch takes a pause a restart brought back with its child, while its booked re-run came back too.
export const pauseChild = (services: Services, childId: string, parent: string, kid: ChildRecord, failure: string, error: string): void => {
    endPause(kid);
    noteSpawnedChild(services.conversations, childId, { status: "paused", summary: `Paused, not finished. ${error}`, error });
    let misses = 0;
    // Still this pause, and its record still the one held for the child. Its record went with a dispose (its own
    // conversation's, or its parent's): nobody is left to tell. The pause itself stands, for the family's cancel that
    // follows a parent's discard to find and end (cancelFamily).
    const current = (): boolean => kid.paused?.stop === stop && services.conversations.holdings(CHILDREN).get(childId) === kid;
    const look = setInterval(() => {
        if (!current()) {
            clearInterval(look);
            return;
        }
        misses = rerunGone(services, childId) ? misses + 1 : 0;
        if (misses >= PAUSE_MISSES) {
            lapse(services, childId, parent, kid, failure);
        }
    }, PAUSE_LOOK_MS);
    look.unref();
    const [first, second] = GONE_LOOKS_MS;
    const confirm = (): void => {
        if (current() && rerunGone(services, childId)) {
            lapse(services, childId, parent, kid, failure);
        }
    };
    const unhear = services.conversations.observe((id, event) => {
        if (id !== childId || !RERUN_GONE.has(event.kind)) {
            return;
        }
        setTimeout(() => {
            if (current() && rerunGone(services, childId)) {
                setTimeout(confirm, second - first).unref();
            }
        }, first).unref();
    });
    const stop = (): void => {
        clearInterval(look);
        unhear();
    };
    kid.paused = { failure, run: turnRunOf(services.conversations, childId)?.id, stop };
    keepChild(services, childId);
};
