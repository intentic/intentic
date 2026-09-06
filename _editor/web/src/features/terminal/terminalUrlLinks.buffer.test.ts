import { Terminal } from "@xterm/headless";
import type { Terminal as DomTerminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";
import { urlLinksAt } from "./terminalUrlLinks";

/* The rules are pinned on plain strings in terminalUrlLinks.test.ts; what THIS suite covers is the step those
 * can't reach: reading a real xterm buffer cell by cell and mapping a string index back onto buffer columns.
 * A wrong range doesn't merely misplace the underline: xterm decides what the pointer is over from that range,
 * so an off-by-a-cell link is an unclickable one.
 *
 * @xterm/headless is the same core the browser terminal runs, minus the renderer, so the buffer these
 * assertions read is produced by the real parser (wrapping, wide-cell layout, null cells) rather than a fake. */

const activate = (): void => {};

// Feed the parser and wait for it to drain: xterm writes are asynchronous.
const render = async (cols: number, lines: readonly string[]): Promise<DomTerminal> => {
    const term = new Terminal({ cols, rows: 24, allowProposedApi: true });
    await new Promise<void>((resolve) => term.write(lines.join(`\r\n`), resolve));
    // The headless core exposes the same buffer API the provider reads; it just has no DOM half.
    return term as unknown as DomTerminal;
};

// A `claude` login panel: the OAuth URL hard-wrapped at the panel's own width, every continuation indented.
const OAUTH_PANEL = [
    `Browser didn't open? Use the url below to sign in:`,
    `  https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a&`,
    `  response_type=code&redirect_uri=https%3A%2F%2Fconsole.anthropic&`,
    `  scope=org%3Acreate_api_key&state=af0ifjsldkj`,
    `Paste code here if prompted >`,
];
const OAUTH_URL =
    `https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a&` +
    `response_type=code&redirect_uri=https%3A%2F%2Fconsole.anthropic&` +
    `scope=org%3Acreate_api_key&state=af0ifjsldkj`;

describe(`urlLinksAt`, () => {
    it(`links the whole hard-wrapped URL, from any row it covers`, async () => {
        // Wide enough that the terminal itself never wraps: every break here is the panel's own newline.
        const term = await render(120, OAUTH_PANEL);
        // Rows are 1-based: the URL occupies rows 2..4, the prose around it rows 1 and 5.
        for (const row of [2, 3, 4]) {
            const [link, ...rest] = urlLinksAt(term, row, activate);
            expect(rest).toEqual([]);
            expect(link?.text).toBe(OAUTH_URL);
            // Starts past the two-space indent on row 2, ends on the last character of row 4.
            expect(link?.range.start).toEqual({ x: 3, y: 2 });
            expect(link?.range.end).toEqual({ x: OAUTH_PANEL[3]?.length, y: 4 });
        }
        expect(urlLinksAt(term, 1, activate)).toEqual([]);
        expect(urlLinksAt(term, 5, activate)).toEqual([]);
    });

    it(`still links a URL the TERMINAL soft-wrapped at its own width`, async () => {
        // 40 cols forces xterm to wrap this one itself, across three rows.
        const term = await render(40, [`https://example.com/oauth/authorize?client_id=abcdef&state=ghijkl`]);
        const [link] = urlLinksAt(term, 2, activate);
        expect(link?.text).toBe(`https://example.com/oauth/authorize?client_id=abcdef&state=ghijkl`);
        expect(link?.range.start).toEqual({ x: 1, y: 1 });
        expect(link?.range.end).toEqual({ x: 65 - 40, y: 2 });
    });

    it(`maps columns past wide glyphs, which occupy two cells but one character`, async () => {
        // 你好 is two characters in four cells, so the URL starts at string index 3 but column 6 (1-based).
        const term = await render(120, [`你好 https://example.com/x`]);
        const [link] = urlLinksAt(term, 1, activate);
        expect(link?.text).toBe(`https://example.com/x`);
        expect(link?.range.start).toEqual({ x: 6, y: 1 });
        expect(link?.range.end).toEqual({ x: 26, y: 1 });
    });

    it(`links each URL on a row independently`, async () => {
        const term = await render(120, [`see https://one.example/a and https://two.example/b done`]);
        const links = urlLinksAt(term, 1, activate);
        expect(links.map((link) => link.text)).toEqual([`https://one.example/a`, `https://two.example/b`]);
        expect(links[0]?.range).toEqual({ start: { x: 5, y: 1 }, end: { x: 25, y: 1 } });
    });

    it(`opens the stitched URL, not the fragment that was clicked`, async () => {
        const term = await render(120, OAUTH_PANEL);
        const opened: string[] = [];
        // Click the LAST fragment: the row reading `scope=…&state=…`, which alone is not a URL at all.
        const [link] = urlLinksAt(term, 4, (_event, uri) => opened.push(uri));
        // xterm activates a link with the link's own text; the event is untouched by this handler.
        link?.activate({} as MouseEvent, link.text);
        expect(opened).toEqual([OAUTH_URL]);
    });
});
