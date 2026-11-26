import { NO_ATTENTION } from "../../../../../models/agent-status/agentStatus-lanes";
import type { FleetAgent } from "../../../../../models/fleet/useAgents-fleet";
import { type BoardPicture, FLIPS, flickerWatch, WINDOW_MS } from "../laneFlicker";

// Pins the flicker report: a board alternating between the same two pictures is reported once, naming the cards that
// moved and their sort facts in each; a board that only moves on (a turn starting, a draft typed) is never reported.

const card = (id: string, over: Partial<FleetAgent> = {}): FleetAgent => ({
    id,
    title: `agent ${id}`,
    status: `draft`,
    provider: `claude`,
    harness: `native`,
    updatedAt: 0,
    attention: NO_ATTENTION,
    open: true,
    unread: false,
    unsent: false,
    ...over,
});

const picture = (active: readonly FleetAgent[], layout = `three`): BoardPicture => ({ layout, lanes: { attention: [], active, finished: [] } });

const watching = () => {
    let clock = 0;
    const reports: Record<string, string | number>[] = [];
    const hear = flickerWatch(
        (fields) => reports.push(fields),
        () => clock,
    );
    return { reports, hear, tick: (ms: number) => (clock += ms) };
};

it(`reports a board flipping between two orders, once, with each moved card's facts in both`, () => {
    const { reports, hear, tick } = watching();
    const typed = card(`mine`, { unsent: true, draftAt: 5_000 });
    const empty = card(`mine`);
    const other = card(`other`, { draftAt: 3_000 });
    for (let flip = 0; flip < FLIPS * 3; flip++) {
        hear(flip % 2 === 0 ? picture([typed, other]) : picture([other, empty]));
        tick(16);
    }
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ flips: FLIPS, moved: `mine,other`, layout: `three`, card0: `mine` });
    expect(reports[0]?.[`card0A`]).toBe(`active:0 draft draft started=- goes=Infinity draft=5000 updated=0 unsent=true open=true by=-`);
    expect(reports[0]?.[`card0B`]).toBe(`active:1 draft draft started=- goes=Infinity draft=- updated=0 unsent=false open=true by=-`);
});

it(`reports a layout flipping under unchanged lanes, naming both layouts`, () => {
    const { reports, hear, tick } = watching();
    const cards = [card(`a`), card(`b`)];
    for (let flip = 0; flip <= FLIPS; flip++) {
        hear(picture(cards, flip % 2 === 0 ? `three` : `paired`));
        tick(100);
    }
    expect(reports).toEqual([{ flips: FLIPS, spanMs: FLIPS * 100, moved: ``, layoutA: `three`, layoutB: `paired` }]);
});

it(`stays quiet for a board that moves on, or flips back only now and then`, () => {
    const { reports, hear, tick } = watching();
    const [a, b, c] = [card(`a`), card(`b`), card(`c`)];
    // Three different pictures, each drawn many times: re-renders of one picture are not flips.
    for (const shown of [picture([a, b, c]), picture([b, a, c]), picture([c, b, a])]) {
        hear(shown);
        hear(shown);
        tick(10);
    }
    // Two pictures alternating, but slower than the window: a real back and forth, not a flicker.
    for (let flip = 0; flip < FLIPS * 2; flip++) {
        hear(flip % 2 === 0 ? picture([a, b]) : picture([b, a]));
        tick(WINDOW_MS / 2);
    }
    expect(reports).toEqual([]);
});
