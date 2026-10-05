import { clientCount } from "./agent-desktop.js";

/* What is on the sandbox desktop, read off `xprop -root -spy _NET_CLIENT_LIST` as it prints: the lines below are the
   ones it printed on a live display as a window opened and closed. */

describe(`clientCount`, () => {
    it(`counts one window per id the list names`, () => {
        expect(clientCount(`_NET_CLIENT_LIST(WINDOW): window id # 0x400024`)).toBe(1);
        expect(clientCount(`_NET_CLIENT_LIST(WINDOW): window id # 0x400024, 0xa00003, 0x1c00007`)).toBe(3);
    });

    it(`reads an empty list as an empty desktop, trailing space and all`, () => {
        expect(clientCount(`_NET_CLIENT_LIST(WINDOW): window id # `)).toBe(0);
        expect(clientCount(`_NET_CLIENT_LIST(WINDOW): window id #`)).toBe(0);
    });

    // No window manager has set the list yet: not an empty desktop, an unknown one.
    it(`counts nothing it cannot read`, () => {
        expect(clientCount(`_NET_CLIENT_LIST:  not found.`)).toBeUndefined();
        expect(clientCount(`Warning: Missing charsets in String to FontSet conversion`)).toBeUndefined();
        expect(clientCount(``)).toBeUndefined();
    });
});
