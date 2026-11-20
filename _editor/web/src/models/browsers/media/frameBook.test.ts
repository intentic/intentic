// What castd's bitrate control runs on: one ack per frame, once every stripe of it that arrived has decoded, with the
// time from the first stripe in to the last stripe out; a frame nothing of which decoded is still acked (so castd's
// queue drains) without a decode time, and counted as dropped. And the overlay's arithmetic.
import { ackBook, captureEpoch, frameAge, statsBook } from "./frameBook";

it("acks a whole frame once, with its decode time, the moment its only stripe decodes", () => {
    const book = ackBook();
    book.arrived(7, 0, 100);
    expect(book.settled(7, 0, 104.5, true)).toEqual({ id: 7, decodeMs: 4.5 });
    expect(book.dropped()).toBe(0);
});

it("acks a striped frame once, after its last stripe, timed from its first stripe's arrival", () => {
    const book = ackBook();
    book.arrived(3, 0, 10);
    book.arrived(3, 1, 11);
    book.arrived(3, 2, 12);
    expect(book.settled(3, 1, 14, true)).toBeUndefined();
    expect(book.settled(3, 0, 15, true)).toBeUndefined();
    expect(book.settled(3, 2, 17, true)).toEqual({ id: 3, decodeMs: 7 });
    // An output the book has no stripe waiting for is not a second ack.
    expect(book.settled(3, 2, 18, true)).toBeUndefined();
});

it("never acks a frame twice, even when a stripe of it arrives after it was acked", () => {
    const book = ackBook();
    book.arrived(5, 0, 0);
    expect(book.settled(5, 0, 2, true)).toEqual({ id: 5, decodeMs: 2 });
    book.arrived(5, 1, 3);
    expect(book.settled(5, 1, 4, true)).toBeUndefined();
    // Nor an older frame once a newer one went.
    book.arrived(4, 0, 5);
    expect(book.settled(4, 0, 6, true)).toBeUndefined();
});

it("acks a frame nothing of which decoded without a decode time, and counts it dropped", () => {
    const book = ackBook();
    book.arrived(9, 0, 0);
    expect(book.settled(9, 0, 1, false)).toEqual({ id: 9 });
    book.arrived(10, 0, 2);
    book.arrived(10, 1, 2);
    // One stripe painted: the frame decoded, and its time is its painted stripe's.
    expect(book.settled(10, 0, 3, false)).toBeUndefined();
    expect(book.settled(10, 1, 6, true)).toEqual({ id: 10, decodeMs: 4 });
    expect(book.dropped()).toBe(1);
});

it("settles every frame waiting on a stripe whose decoder was reset", () => {
    const book = ackBook();
    book.arrived(1, 0, 0);
    book.arrived(1, 1, 0);
    book.arrived(2, 1, 1);
    book.settled(1, 0, 2, true);
    expect(book.lostStripe(1, 3)).toEqual([{ id: 1, decodeMs: 3 }, { id: 2 }]);
    expect(book.dropped()).toBe(1);
});

it("settles a frame whose outputs never came once it is two seconds old, and not before", () => {
    const book = ackBook();
    book.arrived(1, 0, 1000);
    expect(book.sweep(3000)).toEqual([]);
    expect(book.sweep(3001)).toEqual([{ id: 1 }]);
});

it("compares ids across their wrap as castd does", () => {
    const book = ackBook();
    book.arrived(0xffff_ffff, 0, 0);
    expect(book.settled(0xffff_ffff, 0, 1, true)).toEqual({ id: 0xffff_ffff, decodeMs: 1 });
    book.arrived(0, 0, 2);
    expect(book.settled(0, 0, 3, true)).toEqual({ id: 0, decodeMs: 1 });
});

it("starts over with a fresh stream, whose ids may begin again", () => {
    const book = ackBook();
    book.arrived(50, 0, 0);
    book.settled(50, 0, 1, true);
    book.reset();
    book.arrived(1, 0, 2);
    expect(book.settled(1, 0, 3, true)).toEqual({ id: 1, decodeMs: 1 });
});

it("reads a frame's age off castd's capture epoch: the hello's arrival less half the round trip", () => {
    // castd sent hello at its t=0, which arrived here at 1000 after 10 ms, so its capture clock started at 990 here; a
    // frame captured at castd's t=500 and drawn at 1530 is 40 ms old.
    const epoch = captureEpoch(1000, 10, Number.POSITIVE_INFINITY);
    expect(epoch).toBe(990);
    expect(frameAge(1530, epoch, 500)).toBe(40);
});

it("takes the epoch from the pictures when the hello came late, so no age reads negative", () => {
    // The hello queued 30 ms behind a large picture: arriving at 1030, it would put the epoch at 1020. A picture
    // captured at castd's t=20 arrived here at 1015, so the epoch is at most 995.
    const epoch = captureEpoch(1030, 10, 1015 - 20);
    expect(epoch).toBe(995);
    expect(frameAge(1016, epoch, 20)).toBe(1);
});

it("reports the last second's frames, the median decode, the age percentiles and the rate", () => {
    const stats = statsBook();
    for (let at = 0; at < 20; at += 1) {
        stats.drawn(1000 + at * 50, 30 + at);
        stats.decoded(1000 + at * 50, at < 10 ? 2 : 4);
    }
    stats.bytes(1900, 12_500);
    const snapshot = stats.snapshot(1950, { dropped: 0, width: 2560, height: 1600, scale: 2, stripes: 1 });
    expect(snapshot.fps).toBe(20);
    expect(snapshot.decodeMs).toBe(4);
    expect(snapshot.ageMs).toBe(40);
    expect(snapshot.ageP95Ms).toBe(49);
    expect(snapshot.kbps).toBe(100);
    // A second later the frames have aged out of the window, the ages not yet.
    const later = stats.snapshot(2960, { dropped: 0, width: 2560, height: 1600, scale: 2, stripes: 1 });
    expect(later.fps).toBe(0);
    expect(later.decodeMs).toBeUndefined();
    expect(later.ageMs).toBe(40);
});
