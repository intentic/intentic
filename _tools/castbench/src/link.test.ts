import { bottleneck, bytesInMs, DIRECT, parseLink, serializeMs, slices, STANDARD_LINKS } from "./link.js";

// The bottleneck's arithmetic: what the shaping proxy delivers when, by value.

describe("parseLink", () => {
    it("knows direct and reads <rate>mbit-<rtt>ms", () => {
        expect(parseLink("direct")).toBe(DIRECT);
        expect(parseLink("10mbit-40ms")).toEqual({ name: "10mbit-40ms", mbps: 10, rttMs: 40 });
        expect(parseLink("2.5mbit-120ms")).toEqual({ name: "2.5mbit-120ms", mbps: 2.5, rttMs: 120 });
    });

    it("refuses anything else, and a zero rate", () => {
        expect(() => parseLink("10mbps")).toThrow('a link is "direct" or "<rate>mbit-<rtt>ms" (e.g. 10mbit-40ms), not "10mbps"');
        expect(() => parseLink("0mbit-40ms")).toThrow("a link's rate must be above zero");
    });

    it("lists the two links the budgets name beside direct", () => {
        expect(STANDARD_LINKS.map((link) => link.name)).toEqual(["direct", "10mbit-40ms", "5mbit-60ms"]);
    });
});

describe("serializeMs and bytesInMs", () => {
    it("puts 1250 bytes on a 10 Mbit/s wire in 1 ms", () => {
        expect(serializeMs(1250, 10)).toBe(1);
        expect(bytesInMs(1, 10)).toBe(1250);
    });

    it("takes no time and holds without end on an uncapped link", () => {
        expect(serializeMs(1_000_000, null)).toBe(0);
        expect(bytesInMs(200, null)).toBe(Infinity);
    });
});

describe("bottleneck", () => {
    it("delivers a chunk after its serialization plus the one-way delay", () => {
        const link = bottleneck(10, 20);
        // 12,500 bytes at 10 Mbit/s is 10 ms on the wire.
        expect(link.arrival(12_500, 100)).toBe(130);
    });

    it("queues a chunk behind what the link still holds", () => {
        const link = bottleneck(10, 20);
        link.arrival(12_500, 100);
        // Handed over at 105, it waits until 110 for the wire, then 10 ms on it, then the delay.
        expect(link.arrival(12_500, 105)).toBe(140);
        // Handed over after the link went idle, it starts at once.
        expect(link.arrival(1250, 200)).toBe(221);
    });

    it("reads its backlog as bytes not yet on the wire, and how long until it is down to a size", () => {
        const link = bottleneck(10, 20);
        link.arrival(25_000, 0);
        expect(link.backlogBytes(0)).toBe(25_000);
        expect(link.backlogBytes(10)).toBe(12_500);
        expect(link.backlogBytes(30)).toBe(0);
        expect(link.msUntilBacklog(12_500, 4)).toBe(6);
        expect(link.msUntilBacklog(12_500, 15)).toBe(0);
    });

    it("on an uncapped link only delays", () => {
        const link = bottleneck(null, 30);
        expect(link.arrival(10_000_000, 5)).toBe(35);
        expect(link.backlogBytes(5)).toBe(0);
    });
});

describe("slices", () => {
    it("cuts a chunk into pieces of at most the size, the last one short", () => {
        expect(slices(10_000, 4096)).toEqual([
            [0, 4096],
            [4096, 8192],
            [8192, 10_000],
        ]);
        expect(slices(0, 4096)).toEqual([]);
    });
});
