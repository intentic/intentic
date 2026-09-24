import { frameOf, takeFrames } from "./front-link.js";

// The frame the front's own test pins (front-wire, `a_frame_is_its_length_then_its_json`): what Rust writes, Node reads.
const RUST_GOLDEN_JSON = `{"kind":"tunnel","connected":true}`;

const framed = (json: string): Buffer => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(Buffer.byteLength(json));
    return Buffer.concat([head, Buffer.from(json)]);
};

test("reads the front's golden frame back to its JSON", () => {
    const { frames, rest } = takeFrames(framed(RUST_GOLDEN_JSON));
    expect(frames.map((frame) => frame.toString("utf8"))).toEqual([RUST_GOLDEN_JSON]);
    expect(rest.length).toBe(0);
});

test("writes an absent option as an absent key, as the front's serde does", () => {
    expect(frameOf({ kind: "certificate" })).toEqual(framed(`{"kind":"certificate"}`));
});

test("keeps a partial frame for the next read and splits several whole ones", () => {
    const two = Buffer.concat([framed(`{"a":1}`), framed(`{"b":2}`)]);
    const cut = takeFrames(two.subarray(0, two.length - 3));
    expect(cut.frames.map((frame) => frame.toString("utf8"))).toEqual([`{"a":1}`]);
    expect(cut.rest).toEqual(framed(`{"b":2}`).subarray(0, 8));
    const whole = takeFrames(Buffer.concat([cut.rest, two.subarray(two.length - 3)]));
    expect(whole.frames.map((frame) => frame.toString("utf8"))).toEqual([`{"b":2}`]);
    expect(whole.rest.length).toBe(0);
});
