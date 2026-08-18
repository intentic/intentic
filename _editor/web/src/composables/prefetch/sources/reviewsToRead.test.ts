import { describe, expect, it } from "vitest";
import { reviewsToRead } from "./reviewsToRead";

/* WHICH REVIEWS ARE READ BEFORE THEY ARE OPENED, and how deeply. Worth pinning because nothing else can catch a
 * regression here: drop a lane and the app still works — reviews just open with their numbers unsettled and fill in
 * while the reader scans them, which is the exact fault the reading-ahead exists to prevent. And read every lane
 * deeply and the plan's ceiling silently drops the workspace review's own rows, which fails the same way somewhere
 * else. */

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

        // The cost of guessing wrong stays small, and a guess that comes good is read whole the moment it is opened.
        expect(open!.rows).toBeGreaterThan(waiting!.rows);
    });

    it(`still reaches the likely-next reviews when the reader is nowhere near an agent page`, () => {
        // Standing in the workspace, or on the board itself: nothing is open, and this is the case the counts used
        // to have no chance in — a review was read only after its own page had been opened.
        expect(reviewsToRead(undefined, undefined, [`waiting`]).map((review) => review.agentId)).toEqual([`waiting`]);
    });

    it(`lets the open page take the nearer band when it is also the focused conversation`, () => {
        // The usual case. Both entries are declared; warmPlan takes the first, so the order here IS the band.
        const [first] = reviewsToRead(`same`, `same`, []);
        expect(first).toMatchObject({ agentId: `same`, band: `now` });
    });

    it(`treats an empty id as no review at all`, () => {
        // A draft conversation has no agent id yet; asking the daemon for its diff would 404 on every beat.
        expect(reviewsToRead(``, ``, [])).toEqual([]);
    });

    it(`bounds the attention lane, which is unbounded, so its rows cannot crowd out the workspace's`, () => {
        const waiting = Array.from({ length: 9 }, (_, index) => `waiting-${index}`);
        const read = reviewsToRead(undefined, undefined, waiting);

        expect(read).toHaveLength(3);
        expect(read.map((review) => review.agentId)).toEqual([`waiting-0`, `waiting-1`, `waiting-2`]);
    });

    /* WORK THAT HAS LANDED IS READ ONCE, through the workspace review. The two reads are different questions over
     * the same file (see the header), so this is not a cache sharing its answer — it is the plan declining to buy
     * the same bytes twice under two different names, on the surface that is no longer the one being reviewed. */
    it(`leaves a landed agent's review to the workspace review that now holds the same work`, () => {
        expect(reviewsToRead(undefined, `chatting`, [`waiting`], new Set([`chatting`, `waiting`]))).toEqual([]);
    });

    it(`still reads a landed agent's review whole when its own page is open`, () => {
        // The reader is looking at it. "The same bytes are warm somewhere else, under a different question" is no
        // answer to a pane that is on screen.
        const [first] = reviewsToRead(`open`, undefined, [], new Set([`open`]));

        expect(first).toMatchObject({ agentId: `open`, band: `now` });
    });

    it(`keeps reading work that is HELD on the branch, which no other review can reach`, () => {
        // Auto-land off: the delta never entered the workspace, so this review is the only place it exists.
        expect(reviewsToRead(undefined, `holding`, [], new Set([`someone-else`])).map((review) => review.agentId)).toEqual([`holding`]);
    });

    it(`fills the attention lane's three places from the reviews it is still reading`, () => {
        // The cap is on what is WORTH reading, so a landed card must not spend one of its places — the lane would
        // otherwise go shallow for the agents that are actually waiting on the user.
        const read = reviewsToRead(
            undefined,
            undefined,
            [`landed-a`, `waiting-a`, `landed-b`, `waiting-b`, `waiting-c`],
            new Set([`landed-a`, `landed-b`]),
        );

        expect(read.map((review) => review.agentId)).toEqual([`waiting-a`, `waiting-b`, `waiting-c`]);
    });
});
