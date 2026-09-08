import { Terminal } from "@xterm/headless";
import type { Terminal as DomTerminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";
import { urlLinksAt } from "./terminalUrlLinks";

// Covers the buffer step plain-string tests can't: reading a real xterm buffer and mapping indices to columns. Uses
// @xterm/headless, the real core minus the renderer.

const activate = (): void => {};

// Writes to the terminal and waits for the async parser to drain.
const render = async (cols: number, lines: readonly string[]): Promise<DomTerminal> => {
    const term = new Terminal({ cols, rows: 24, allowProposedApi: true });
    await new Promise<void>((resolve) => term.write(lines.join(`\r\n`), resolve));
    // Headless core exposes the same buffer API the provider reads, just without a DOM.
    return term as unknown as DomTerminal;
};

// claude's login panel: the OAuth URL hard-wrapped at the panel's width, each continuation indented.
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
        // Wide enough that xterm itself never wraps; every break here is the panel's own newline.
        const term = await render(120, OAUTH_PANEL);
        // Rows are 1-based; the URL spans rows 2-4, prose sits on rows 1 and 5.
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
        // 你好 is two characters in four cells; the URL starts at string index 3 but column 6.
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
        // Clicks the last fragment, the row reading `scope=...&state=...`, alone not a URL.
        const [link] = urlLinksAt(term, 4, (_event, uri) => opened.push(uri));
        // xterm activates a link with the link's own text; the handler leaves the event untouched.
        link?.activate({} as MouseEvent, link.text);
        expect(opened).toEqual([OAUTH_URL]);
    });
});
