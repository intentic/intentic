import type { MemoryReading } from "@intentic/constants/memory-room";
import { breakArmed } from "@intentic/sandbox-contract/schemas/turn-break";
import type { Services } from "../../../composition.js";
import type { RoutedTurn } from "../../../seams/turn-starter.js";
import { NamespaceSetupError } from "../../../workload/namespace-holder.js";
import { breakPolicyFor } from "../turn/break-policy.js";

// A TURN WHOSE OWN VIEW OF THE WORKSPACE DID NOT COME UP IN TIME. Its namespace holder said nothing for the whole quiet
// bound twice, a second apart (withSetupRetry), with the daemon awake to hear it: the sandbox too loaded to set the turn
// up. Nothing ran, so the turn is turned away at the door with a code of its own (`workspace-setup`, failure-codes.ts) and
// held like a memory hold: sent again by itself once the sandbox has had room a while (turn-resume.ts, releaseRoomHolds),
// where the conversation's answer to the memory wall is to resend. Before this, the holder's raw error ("namespace setup
// timed out: ") was the turn's only word, and the person pressed Continue themselves (2026-10-13, mellow-harbor-rk0i).

export interface SetupRefusal {
    readonly refused: string;
    readonly code: "workspace-setup" | "workspace-broken";
}

const GIB = 1024 ** 3;

type Load = Pick<MemoryReading, "stallPercent" | "ioStallPercent" | "swapBytes">;

// What the sandbox measured, as the share of the last ten seconds everything in it waited; undefined when it measured
// nothing worth saying, where the sentence says only that it was slow.
const loadClause = (reading: Load | undefined): string | undefined => {
    if (reading === undefined) {
        return undefined;
    }
    const memory = Math.round(reading.stallPercent);
    const disk = Math.round(reading.ioStallPercent ?? 0);
    const waits = [...(memory >= 1 ? [`on memory ${String(memory)}%`] : []), ...(disk >= 1 ? [`on the disk ${String(disk)}%`] : [])];
    const swapped = reading.swapBytes >= GIB ? `${(reading.swapBytes / GIB).toFixed(1)} GiB in swap` : undefined;
    const waited = waits.length === 0 ? undefined : `everything waited ${waits.join(" and ")} of the last ten seconds`;
    const said = [waited, swapped].filter((part) => part !== undefined);
    return said.length === 0 ? undefined : said.join(", with ");
};

/** The refusal's sentence: what happened, what the sandbox measured, and whether it goes again by itself. */
export const setupRefusalSentence = (reading: Load | undefined, resends: boolean): string => {
    const load = loadClause(reading);
    const why = load === undefined ? "the sandbox was too slow to prepare it" : `the sandbox was too busy (${load})`;
    const first = `This conversation's copy of the workspace could not be set up in time: ${why}.`;
    return resends ? `${first} It goes again by itself once the sandbox has had room for a while.` : first;
};

// Whether the turn this refuses is held for the room release to send: a person's, on a conversation whose answer to the
// memory wall is to resend. Anything else is said as it stands, with nothing promised.
const resendsByItself = async (services: Pick<Services, "agents" | "sandboxSettings">, input: RoutedTurn): Promise<boolean> =>
    input.unattended !== true && input.conversationId !== undefined && breakArmed(await breakPolicyFor(services, input.conversationId, "memory"));

/** The placement's answer to a holder that did not come up in time twice: logged with its facts, refused at the door. */
export const setupRefusalOf = async (
    services: Pick<Services, "agents" | "sandboxSettings" | "resources" | "logger">,
    input: RoutedTurn,
    error: NamespaceSetupError,
): Promise<SetupRefusal> => {
    const reading = await services.resources.snapshot().then(
        (snapshot) => snapshot.reading,
        // allow(silent-catch): the refusal stands without its figures; the sentence then says only that it was slow.
        () => undefined,
    );
    services.logger.warn(
        {
            conversationId: input.conversationId,
            failure: error.failure,
            ...error.facts,
            reason: error.message,
            memoryStallPercent: reading?.stallPercent,
            ioStallPercent: reading?.ioStallPercent,
            swapBytes: reading?.swapBytes,
        },
        "turn placement: the conversation's namespace did not come up in time twice, the turn is held at the door",
    );
    return { refused: setupRefusalSentence(reading, await resendsByItself(services, input)), code: "workspace-setup" };
};

/** The note a first stalled attempt leaves before the second starts. */
export const retryNote =
    (services: Pick<Services, "logger">, input: RoutedTurn) =>
    (error: NamespaceSetupError): void => {
        services.logger.warn(
            { conversationId: input.conversationId, failure: error.failure, ...error.facts, reason: error.message },
            "turn placement: the conversation's namespace did not come up in time, trying once more",
        );
    };

/* A TURN WHOSE OWN VIEW OF THE WORKSPACE FAILED WITH AN ERROR OF ITS OWN: the holder answered, and what it answered was a
   refusal (a mount the kernel would not make), past the one repair the anchor makes by itself (isolation.ts
   startAnchor). Nothing ran, and the same turn sent again fails the same way, so it is turned away at the door with a code
   that says so (`workspace-broken`, failure-codes.ts `repeats`): its words are held for a press, the chat offers the ways
   out instead of Continue, and the holder's own words ride behind the sentence for whoever reads the details. Before this,
   the holder's stderr was the turn's only word, uncoded, so it read as a turn that stopped short and every press of
   Continue ran into it again (2026-11-05, twenty presses on one conversation). */
export const BROKEN_SENTENCE =
    "This conversation's copy of the workspace could not be set up, and setting it up again did not help. Nothing ran, and sending again will fail the same way: continue in a new conversation, which gets a copy of its own.";

const brokenRefusalOf = (services: Pick<Services, "logger">, input: RoutedTurn, error: NamespaceSetupError): SetupRefusal => {
    services.logger.warn(
        { conversationId: input.conversationId, failure: error.failure, ...error.facts, reason: error.message },
        "turn placement: the conversation's namespace failed past its repair, refused at the door as workspace-broken",
    );
    return { refused: `${BROKEN_SENTENCE} (${error.message})`, code: "workspace-broken" };
};

// A second stalled placement is refused before anything runs, and so is one the holder refused past its repair; any
// other placement failure keeps its own error.
export const withSetupRefusal = async <T>(
    services: Parameters<typeof setupRefusalOf>[0],
    input: RoutedTurn,
    place: () => Promise<T>,
): Promise<T | SetupRefusal> => {
    try {
        return await place();
    } catch (error) {
        if (!(error instanceof NamespaceSetupError)) {
            throw error;
        }
        return error.transient ? setupRefusalOf(services, input, error) : brokenRefusalOf(services, input, error);
    }
};

/** What a turn's placement did on its own way up, for the turn to say: how many layers its one repair set aside. */
export interface SetupSink {
    repaired?: number;
}

// The anchor's two notes, one per way it went on by itself: a second attempt after a stall, and a repair after a refusal.
export const setupNotes = (services: Pick<Services, "logger">, input: RoutedTurn, sink: SetupSink) => ({
    onRetry: retryNote(services, input),
    onRepair: (layers: number, error: NamespaceSetupError): void => {
        sink.repaired = layers;
        services.logger.warn(
            { conversationId: input.conversationId, layers, failure: error.failure, ...error.facts, reason: error.message },
            "turn placement: the conversation's namespace was refused, its layers set aside and set up once more",
        );
    },
});
