import { CHANNEL, pageMessage } from "./protocol.js";

// The viewer reads only what the editor page may say: a media problem it knows, on this channel.

it(`reads a media problem the page reports`, () => {
    expect(pageMessage({ channel: CHANNEL, type: `media-problem`, problem: `too-large` })).toEqual({ channel: CHANNEL, type: `media-problem`, problem: `too-large` });
    expect(pageMessage({ channel: CHANNEL, type: `media-problem`, problem: `unplayable` })?.type).toBe(`media-problem`);
});

it(`ignores a media problem it does not know, or one on another channel`, () => {
    expect(pageMessage({ channel: CHANNEL, type: `media-problem`, problem: `on-fire` })).toBeUndefined();
    expect(pageMessage({ channel: CHANNEL, type: `media-problem` })).toBeUndefined();
    expect(pageMessage({ channel: `elsewhere`, type: `media-problem`, problem: `too-large` })).toBeUndefined();
});
