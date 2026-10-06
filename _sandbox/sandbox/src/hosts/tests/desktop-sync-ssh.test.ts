import { streamSilent } from "../desktop-sync-ssh.js";

/* (2026-10-05) A half-open stream held one of the route's 32 slots for good. One that answered nothing since its last
   ping is dropped at the next; one that is merely quiet still answers pings, and stays. */
describe("streamSilent", () => {
    it("never drops a stream that has not been pinged yet", () => {
        expect(streamSilent(0, undefined)).toBe(false);
    });

    it("drops a stream that said nothing since its last ping", () => {
        expect(streamSilent(1_000, 2_000)).toBe(true);
    });

    it("keeps a stream that answered the ping, or sent anything, after it", () => {
        expect(streamSilent(2_001, 2_000)).toBe(false);
    });
});
