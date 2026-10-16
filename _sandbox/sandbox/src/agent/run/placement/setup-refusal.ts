import type { MemoryReading } from "@intentic/constants/memory-room";
import { breakArmed } from "@intentic/sandbox-contract/schemas/turn-break";
import type { Services } from "../../../composition.js";
import type { RoutedTurn } from "../../../seams/turn-starter.js";
import type { NamespaceSetupError } from "../../../workload/namespace-holder.js";
import { breakPolicyFor } from "../turn/turn-resume.js";

// A TURN WHOSE OWN VIEW OF THE WORKSPACE DID NOT COME UP IN TIME. Its namespace holder said nothing for the whole quiet
// bound twice, a second apart (withSetupRetry), with the daemon awake to hear it: the sandbox too loaded to set the turn
// up. Nothing ran, so the turn is turned away at the door with a code of its own (`workspace-setup`, turned-away.ts) and
// held like a memory hold: sent again by itself once the sandbox has had room a while (turn-resume.ts, releaseRoomHolds),
// where the conversation's answer to the memory wall is to resend. Before this, the holder's raw error ("namespace setup
// timed out: ") was the turn's only word, and the person pressed Continue themselves (2026-10-13, mellow-harbor-rk0i).

export interface SetupRefusal {
    readonly refused: string;
    readonly code: "workspace-setup";
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
