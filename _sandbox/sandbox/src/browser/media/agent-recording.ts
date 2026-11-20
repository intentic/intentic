import { errorMessage } from "@intentic/base/errors";
import type { Page } from "playwright";
import type { Display } from "../cast/display.js";
import type { Region } from "../cast/region.js";
import type { CropRect } from "./castd-control.js";
import type { Castd } from "./castd.js";
import { autoStopMs, type Recorded, type Running, startRecording, stopRecording, turnRecordingPath } from "./recordings.js";

/* An agent's turn recorded as it drives a browser window, with the sandbox's `recordAgentBrowsing` on (recordings.ts
   says what a recording is). The router tells this of every browser call that answered (browser-router.ts): the first
   one with a window starts castd's recording of it, cropped to the tab in front, and the turn's end stops it. The MP4
   goes under the conversation's own folder of the browser artifacts, and the conversation is told where as the
   recording starts, as a notice in its transcript, so the path is there whether or not the turn ends cleanly.

   castd ends a recording when its picture changes size, and at its longest: so the crop is checked after each call, and
   a window that moved, or a recording that reached castd's longest, is kept as one part and the next part started. A
   window castd serves as its whole screen (a person watching it on the media path) is recorded as castd frames it: it
   is never moved to a crop, which would start castd again under that person's view. */

export interface TurnRecordingDeps {
    // The sandbox's `recordAgentBrowsing`, read at each call.
    readonly enabled: () => Promise<boolean>;
    readonly outputDir: string;
    // A notice in the conversation's transcript, while its turn runs.
    readonly note: (conversationId: string, text: string) => void;
    readonly log: (fields: Readonly<Record<string, string | number | undefined>>, message: string) => void;
    // The owner's castd as it runs, else one started cropped to `rect`.
    readonly castd: (owner: string, display: Display, rect: CropRect) => Pick<Castd, "control" | "framing" | "ready" | "moveCrop"> | undefined;
    readonly display: (owner: string) => Display | undefined;
    readonly page: (owner: string) => Page | undefined;
    readonly region: (page: Page, display: Display) => Promise<Region | undefined>;
    readonly now: () => Date;
    // Moves a part from where castd wrote it to where it is kept, and ages out the oldest (recordings.ts keepRecording,
    // pruneTurnRecordings).
    readonly keep: (file: string, recorded: Recorded) => Promise<void>;
}

interface Take {
    readonly owner: string;
    readonly conversationId: string;
    readonly castd: Pick<Castd, "control" | "framing" | "moveCrop">;
    readonly startedAt: Date;
    running: Running;
    part: number;
    rect: CropRect;
    timer: NodeJS.Timeout | undefined;
}

const takes = new Map<string, Take>();
// Windows a turn could not record (no castd, castd would not record): not tried again on every call of the turn.
const declined = new Set<string>();
// One change to a take at a time: a turn's calls overlap, and two of them must not start two recordings.
const queues = new Map<string, Promise<void>>();

const keyOf = (conversationId: string, owner: string): string => `${conversationId}\u0000${owner}`;

const sameRect = (left: CropRect, right: CropRect): boolean => left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;

// Never rejects: a recording that failed is said in the log, and the turn's browsing goes on without it.
const serial = (key: string, work: () => Promise<void>, deps: Pick<TurnRecordingDeps, "log">): Promise<void> => {
    const guarded = async (): Promise<void> => {
        try {
            await work();
        } catch (error) {
            deps.log({ reason: errorMessage(error) }, "turn recording: failed");
        }
    };
    const next = (queues.get(key) ?? Promise.resolve()).then(guarded);
    queues.set(key, next);
    void next.finally(() => {
        if (queues.get(key) === next) {
            queues.delete(key);
        }
    });
    return next;
};

// Whether `take` is still its turn's: one the turn's end let go of starts nothing more.
const current = (take: Take): boolean => takes.get(keyOf(take.conversationId, take.owner)) === take;

// Keeps the take's current part and starts the next, when `more`.
const rotate = async (take: Take, deps: TurnRecordingDeps, more: boolean): Promise<void> => {
    clearTimeout(take.timer);
    take.timer = undefined;
    const file = turnRecordingPath(deps.outputDir, take.conversationId, take.owner, take.startedAt, take.part);
    const recorded = await stopRecording(take.running);
    if (recorded === undefined) {
        deps.log({ conversationId: take.conversationId, owner: take.owner, part: take.part }, "turn recording: castd held no recording to keep");
    } else {
        await deps.keep(file, recorded);
    }
    if (!more || !current(take)) {
        return;
    }
    const next = await startRecording(take.castd);
    if (next === undefined) {
        takes.delete(keyOf(take.conversationId, take.owner));
        return;
    }
    take.running = next;
    take.part += 1;
    arm(take, deps);
};

// The part ends a little before castd's longest, kept, and the next started.
const arm = (take: Take, deps: TurnRecordingDeps): void => {
    // Queued behind whatever the take is doing; by then the turn may have ended and kept it, which leaves nothing to do.
    const due = async (): Promise<void> => (current(take) ? rotate(take, deps, true) : undefined);
    take.timer = setTimeout(() => void serial(keyOf(take.conversationId, take.owner), due, deps), autoStopMs(take.running));
    take.timer.unref();
};

const begin = async (owner: string, conversationId: string, display: Display, rect: CropRect, deps: TurnRecordingDeps): Promise<void> => {
    const castd = deps.castd(owner, display, rect);
    if (castd === undefined || !(await castd.ready())) {
        declined.add(keyOf(conversationId, owner));
        deps.log({ conversationId, owner }, "turn recording: this window has no castd to record it");
        return;
    }
    if (castd.framing().kind === "crop") {
        await castd.moveCrop(rect);
    }
    const running = await startRecording(castd);
    if (running === undefined) {
        declined.add(keyOf(conversationId, owner));
        deps.log({ conversationId, owner }, "turn recording: castd would not record");
        return;
    }
    const take: Take = { owner, conversationId, castd, startedAt: deps.now(), running, part: 1, rect, timer: undefined };
    takes.set(keyOf(conversationId, owner), take);
    arm(take, deps);
    const file = turnRecordingPath(deps.outputDir, conversationId, owner, take.startedAt, 1);
    deps.note(conversationId, `Recording this turn's browsing in ${owner}'s window (recordAgentBrowsing is on): ${file} once the turn ends.`);
};

/** Told of a browser call of the turn that answered: starts its recording, or moves it with a window that moved. */
export const turnBrowsed = (owner: string, conversationId: string, deps: TurnRecordingDeps): Promise<void> =>
    serial(keyOf(conversationId, owner), async () => {
        const take = takes.get(keyOf(conversationId, owner));
        if (take === undefined && (declined.has(keyOf(conversationId, owner)) || !(await deps.enabled()))) {
            return;
        }
        const display = deps.display(owner);
        const page = deps.page(owner);
        const region = display === undefined || page === undefined ? undefined : await deps.region(page, display);
        if (display === undefined || region === undefined) {
            return;
        }
        const rect: CropRect = { x: region.x, y: region.y, width: region.width, height: region.height };
        if (take === undefined) {
            await begin(owner, conversationId, display, rect, deps);
        } else if (take.castd.framing().kind === "crop" && !sameRect(take.rect, rect)) {
            // A new crop ends castd's recording: what came before is kept as its own part.
            await rotate(take, deps, false);
            await take.castd.moveCrop(rect);
            take.rect = rect;
            const next = await startRecording(take.castd);
            if (next === undefined) {
                takes.delete(keyOf(conversationId, owner));
                return;
            }
            take.running = next;
            take.part += 1;
            arm(take, deps);
        }
    }, deps);

/** The turn ended: every window it recorded is kept, including one whose recording a call still under way starts. */
export const turnEnded = async (conversationId: string, deps: TurnRecordingDeps): Promise<void> => {
    const prefix = `${conversationId}\u0000`;
    const ours = (key: string): boolean => key.startsWith(prefix);
    for (const key of [...declined].filter(ours)) {
        declined.delete(key);
    }
    // A take, or a change still queued for one (its first recording starting): each is ended behind what is queued.
    const ending = new Set([...takes.keys(), ...queues.keys()].filter(ours));
    await Promise.all(
        [...ending].map((key) =>
            serial(
                key,
                async () => {
                    // A start that was under way and could not record said so for this turn only.
                    declined.delete(key);
                    const take = takes.get(key);
                    takes.delete(key);
                    if (take !== undefined) {
                        await rotate(take, deps, false);
                    }
                },
                deps,
            ),
        ),
    );
};
