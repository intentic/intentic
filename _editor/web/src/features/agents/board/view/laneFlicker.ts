import { reportClient } from "../../../../app/clientDiagnostics";
import type { FleetLane } from "../../../../models/agent-status/agentStatus-lanes";
import { ownReading } from "../../../../models/fleet/board/activePhase";
import type { FleetAgent } from "../../../../models/fleet/useAgents-fleet";

// A BOARD THAT WILL NOT SETTLE, CAUGHT IN THE ACT. Reported 2026-11-26: with a new chat's message box emptied, the cards
// of Active kept swapping places at frame rate until a word was typed again, and no reading of the code or the demo
// reproduced it. Every lane order is a pure function of the cards' facts and the board's layout of its width and its
// corner, so a board that flips between two pictures has some input flipping with it. This watches the picture (the
// layout and every lane's order) and, the first time it alternates between the same two within a few seconds, reports
// both pictures and every input that differs between them for each card that moved, so the next sighting names the
// cause in client.jsonl (event `board.flicker`) instead of being described from memory.

/** One picture of the board: what decides where each card stands. */
export interface BoardPicture {
    // The lanes' grid and card fit, the corner, and whether the chat's own rail holds Usage left: the layout inputs.
    readonly layout: string;
    readonly lanes: Readonly<Record<FleetLane, readonly FleetAgent[]>>;
}

// Alternations between the same two pictures, within WINDOW_MS, that count as a board not settling. A real change
// (a turn starting, a draft typed) moves the board once; four returns in three seconds is no reader's doing.
export const FLIPS = 4;
export const WINDOW_MS = 3_000;
// How many card ids a report names; a flicker is usually one or two cards fighting.
const MOVED_KEPT = 4;

const LANES: readonly FleetLane[] = [`attention`, `active`, `finished`];

/** The picture as one comparable string: the layout, then each lane's ids in order. */
const pictureKey = (picture: BoardPicture): string =>
    `${picture.layout}#${LANES.map((lane) => picture.lanes[lane].map((card) => card.id).join(`,`)).join(`|`)}`;

const placeOf = (picture: BoardPicture, id: string): string => {
    for (const lane of LANES) {
        const at = picture.lanes[lane].findIndex((card) => card.id === id);
        if (at !== -1) {
            return `${lane}:${at}`;
        }
    }
    return `absent`;
};

const cardOf = (picture: BoardPicture, id: string): FleetAgent | undefined =>
    LANES.flatMap((lane) => picture.lanes[lane]).find((card) => card.id === id);

// Every input a lane's order reads off a card (laneOf, activeLaneOrder, finishedLaneOrder, attentionLaneOrder), as text.
const sortFacts = (card: FleetAgent | undefined): string => {
    if (card === undefined) {
        return `absent`;
    }
    const reading = ownReading(card);
    return [
        card.status,
        reading.phase,
        `started=${card.startedAt ?? `-`}`,
        `goes=${reading.goesAt}`,
        `draft=${card.draftAt ?? `-`}`,
        `updated=${card.updatedAt}`,
        `unsent=${card.unsent}`,
        `open=${card.open}`,
        `by=${card.startedBy ?? `-`}`,
    ].join(` `);
};

/** What differs between two pictures that alternate: the layout, and each card standing somewhere else in them. */
export const flickerFields = (a: BoardPicture, b: BoardPicture, flips: number, spanMs: number) => {
    const ids = new Set([...LANES.flatMap((lane) => a.lanes[lane]), ...LANES.flatMap((lane) => b.lanes[lane])].map((card) => card.id));
    const moved = [...ids].filter((id) => placeOf(a, id) !== placeOf(b, id)).slice(0, MOVED_KEPT);
    return Object.fromEntries<string | number>([
        [`flips`, flips],
        [`spanMs`, spanMs],
        [`moved`, moved.join(`,`)],
        ...(a.layout === b.layout ? [[`layout`, a.layout] as const] : [[`layoutA`, a.layout] as const, [`layoutB`, b.layout] as const]),
        ...moved.flatMap((id, at) => [
            [`card${at}`, id] as const,
            [`card${at}A`, `${placeOf(a, id)} ${sortFacts(cardOf(a, id))}`] as const,
            [`card${at}B`, `${placeOf(b, id)} ${sortFacts(cardOf(b, id))}`] as const,
        ]),
    ]);
};

/**
 * Hears every picture the board draws and calls `report` once, the first time it alternates between the same two
 * pictures FLIPS times within WINDOW_MS. Returns what to call with each picture.
 */
export const flickerWatch = (
    report: (fields: ReturnType<typeof flickerFields>) => void,
    now: () => number = Date.now,
): ((picture: BoardPicture) => void) => {
    // The distinct pictures drawn, newest last, each with when it was first drawn.
    let seen: { readonly key: string; readonly picture: BoardPicture; readonly at: number }[] = [];
    let reported = false;
    return (picture) => {
        if (reported) {
            return;
        }
        const key = pictureKey(picture);
        if (seen.at(-1)?.key === key) {
            return;
        }
        const at = now();
        seen = [...seen.filter((entry) => at - entry.at <= WINDOW_MS), { key, picture, at }].slice(-(FLIPS + 1));
        if (seen.length < FLIPS + 1) {
            return;
        }
        // A, B, A, B, A: every picture is the one two before it, and the two differ.
        const [first, second] = seen;
        const alternating = seen.every((entry, index) => entry.key === (index % 2 === 0 ? first!.key : second!.key));
        if (alternating && first!.key !== second!.key) {
            reported = true;
            report(flickerFields(first!.picture, second!.picture, FLIPS, at - first!.at));
        }
    };
};

/** A flickerWatch that reports to client.jsonl as `board.flicker`, for the board to hand every picture it draws. */
export const flickerReporter = (): ((picture: BoardPicture) => void) =>
    flickerWatch((fields) => reportClient(`board.flicker`, `the board kept flipping between two pictures`, { level: `warn`, fields }));
