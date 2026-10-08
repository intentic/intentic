import { activeWindow, clientCount, clientIds, windowPlace } from "./agent-desktop.js";

/* What is on the sandbox desktop, read off `xprop -root -spy _NET_CLIENT_LIST _NET_ACTIVE_WINDOW` as it prints: the
   lines below are the ones it printed on a live display as windows opened, took the focus and closed. */

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

describe(`clientIds`, () => {
    // The spy spells an id without wmctrl's zero padding; as numbers the two spellings are one window.
    it(`reads each window the list names as a number`, () => {
        expect(clientIds(`_NET_CLIENT_LIST(WINDOW): window id # 0x600020, 0x800020`)).toEqual([0x600020, 0x800020]);
        expect(clientIds(`_NET_CLIENT_LIST(WINDOW): window id # `)).toEqual([]);
        expect(clientIds(`_NET_ACTIVE_WINDOW(WINDOW): window id # 0x600020`)).toBeUndefined();
    });
});

describe(`activeWindow`, () => {
    it(`reads the window with the keyboard, none as 0, and nothing off another line`, () => {
        expect(activeWindow(`_NET_ACTIVE_WINDOW(WINDOW): window id # 0x800020`)).toBe(0x800020);
        expect(activeWindow(`_NET_ACTIVE_WINDOW(WINDOW): window id # 0x0`)).toBe(0);
        expect(activeWindow(`_NET_ACTIVE_WINDOW:  not found.`)).toBeUndefined();
        expect(activeWindow(`_NET_CLIENT_LIST(WINDOW): window id # 0x600020`)).toBeUndefined();
    });
});

// `xwininfo -id 0x400020` on a live display, an xmessage that openbox framed: the inside sits 1 px right of and 18 px
// below the frame it was asked for at 50,60.
const XWININFO = `
xwininfo: Window id: 0x400020 "xmessage"

  Absolute upper-left X:  51
  Absolute upper-left Y:  78
  Relative upper-left X:  1
  Relative upper-left Y:  18
  Width: 300
  Height: 100
  Depth: 24
  Visual: 0x21
  Border width: 0
  Map State: IsViewable
  Corners:  +51+78  -929+78  -929-622  +51-622
  -geometry 300x100+50+60
`;

describe(`windowPlace`, () => {
    it(`is the window's inside on the screen, not its relative place or its geometry hint`, () => {
        expect(windowPlace(XWININFO)).toEqual({ x: 51, y: 78, width: 300, height: 100 });
    });

    it(`keeps a place left of or above the screen`, () => {
        expect(windowPlace(XWININFO.replace(`Absolute upper-left X:  51`, `Absolute upper-left X:  -12`))).toEqual({ x: -12, y: 78, width: 300, height: 100 });
    });

    it(`is nothing for output that does not say`, () => {
        expect(windowPlace(``)).toBeUndefined();
        expect(windowPlace(XWININFO.replace(/\s*Height: 100/, ``))).toBeUndefined();
    });
});
