import { describe, expect, it } from "vitest";
import { bytesOf } from "./sync-ssh.js";

/* Reading a frame off the wire is the one thing on this route that can corrupt an SSH stream silently. Every
 * other failure announces itself — a refused socket, a closed connection — but bytes that are the wrong bytes
 * arrive as a handshake that fails with no reason given, on a transport that looks perfectly healthy. */
describe("bytesOf", () => {
    it("takes a Buffer as it is — what `ws` hands over for a binary frame", () => {
        expect(bytesOf(Buffer.from("SSH-2.0-OpenSSH_9.6"))?.toString()).toBe("SSH-2.0-OpenSSH_9.6");
    });

    it("takes a whole ArrayBuffer — what a browser-shaped client sends", () => {
        const bytes = new TextEncoder().encode("hello");
        expect(bytesOf(bytes.buffer)?.toString()).toBe("hello");
    });

    /* The case that matters. A view over a larger buffer must contribute ITS bytes and no others: reading the
     * backing buffer instead would hand sshd whatever else is in that allocation. */
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
