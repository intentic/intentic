import { bytesOf, streamSilent } from "../desktop-sync-ssh.js";

/* Reading a frame off the wire is the one thing on this route that can corrupt an SSH stream silently. */
describe("bytesOf", () => {
    it("takes a Buffer as it is: what `ws` hands over for a binary frame", () => {
        expect(bytesOf(Buffer.from("SSH-2.0-OpenSSH_9.6"))?.toString()).toBe("SSH-2.0-OpenSSH_9.6");
    });

    it("takes a whole ArrayBuffer: what a browser-shaped client sends", () => {
        const bytes = new TextEncoder().encode("hello");
        expect(bytesOf(bytes.buffer)?.toString()).toBe("hello");
    });

    /* The case that matters. */
    it("takes exactly a view's own window, never its backing buffer", () => {
        const backing = new TextEncoder().encode("XXXpayloadXXX");
        const view = new Uint8Array(backing.buffer, 3, 7);

        expect(bytesOf(view)?.toString()).toBe("payload");
    });

    it("ignores a text frame rather than guessing at an encoding for it", () => {
        expect(bytesOf("not part of this protocol")).toBeUndefined();
        expect(bytesOf(undefined)).toBeUndefined();
    });
});

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
