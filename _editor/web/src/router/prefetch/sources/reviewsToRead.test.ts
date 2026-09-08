import { describe, expect, it } from "vitest";
import { reviewsToRead } from "./reviewsToRead";

// Pins which reviews are read ahead and how deeply. A dropped lane leaves numbers unsettled on open;
// reading every lane deeply lets the ceiling silently drop the workspace review's own rows.

describe(`reviewsToRead`, () => {
    it(`reads the open review first, then the one the chat points at, then the attention lane`, () => {
        expect(reviewsToRead(`open`, `chatting`, [`waiting-a`, `waiting-b`]).map((review) => [review.agentId, review.band])).toEqual([
            [`open`, `now`],
            [`chatting`, `near`],
            [`waiting-a`, `work`],
            [`waiting-b`, `work`],
        ]);
    });

    it(`reads a review it is sure about whole, and one it is only guessing at shallowly`, () => {
        const [open, , waiting] = reviewsToRead(`open`, `chatting`, [`waiting`]);

        expect(open!.rows).toBeGreaterThan(waiting!.rows);
    });

    it(`still reaches the likely-next reviews when the reader is nowhere near an agent page`, () => {
        // undefined/undefined means standing in the workspace or on the board itself: nothing is open.
        expect(reviewsToRead(undefined, undefined, [`waiting`]).map((review) => review.agentId)).toEqual([`waiting`]);
    });

    it(`lets the open page take the nearer band when it is also the focused conversation`, () => {
        // Both entries are declared; warmPlan takes the first, so order here decides the band.
        const [first] = reviewsToRead(`same`, `same`, []);
        expect(first).toMatchObject({ agentId: `same`, band: `now` });
    });

    it(`treats an empty id as no review at all`, () => {
        // A draft conversation has no agent id yet.
        expect(reviewsToRead(``, ``, [])).toEqual([]);
    });

    it(`bounds the attention lane, which is unbounded, so its rows cannot crowd out the workspace's`, () => {
        const waiting = Array.from({ length: 9 }, (_, index) => `waiting-${index}`);
        const read = reviewsToRead(undefined, undefined, waiting);

        expect(read).toHaveLength(3);
        expect(read.map((review) => review.agentId)).toEqual([`waiting-0`, `waiting-1`, `waiting-2`]);
    });

    it(`leaves a landed agent's review to the workspace review that now holds the same work`, () => {
        expect(reviewsToRead(undefined, `chatting`, [`waiting`], new Set([`chatting`, `waiting`]))).toEqual([]);
    });

    it(`still reads a landed agent's review whole when its own page is open`, () => {
        const [first] = reviewsToRead(`open`, undefined, [], new Set([`open`]));

        expect(first).toMatchObject({ agentId: `open`, band: `now` });
    });

    it(`keeps reading work that is HELD on the branch, which no other review can reach`, () => {
        // Auto-land off: the delta never entered the workspace.
        expect(reviewsToRead(undefined, `holding`, [], new Set([`someone-else`])).map((review) => review.agentId)).toEqual([`holding`]);
    });

    it(`fills the attention lane's three places from the reviews it is still reading`, () => {
        // The cap counts only what's still worth reading; a landed card must not spend one of its three places.
        const read = reviewsToRead(
            undefined,
            undefined,
            [`landed-a`, `waiting-a`, `landed-b`, `waiting-b`, `waiting-c`],
            new Set([`landed-a`, `landed-b`]),
        );

        expect(read.map((review) => review.agentId)).toEqual([`waiting-a`, `waiting-b`, `waiting-c`]);
    });
});
