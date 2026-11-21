import { describe, expect, test } from "vitest";
import { startInputFor } from "./remote-device.js";

const input = {
    device: "rog",
    uplinkToken: "uplink-token",
    mediaKey: "A".repeat(43),
    iceServers: ["stun:stun.example.test:3478"],
};

describe("what remoteStart sends an agent", () => {
    test("carries the STUN servers to an agent that advertises remote-ice", () => {
        expect(startInputFor({ features: ["remote", "remote-ice"] }, input)).toEqual(input);
    });

    test("leaves them out for an older agent, whose strict schema would refuse the call", () => {
        const { iceServers: _left, ...older } = input;
        expect(startInputFor({ features: ["remote"] }, input)).toEqual(older);
        expect(startInputFor(undefined, input)).toEqual(older);
        // Nothing to leave out: the input as it was.
        expect(startInputFor({ features: ["remote"] }, older)).toBe(older);
    });
});
