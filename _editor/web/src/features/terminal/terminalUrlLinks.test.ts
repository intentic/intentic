import { describe, expect, it } from "vitest";
import { findUrls, type RowAt, runStart } from "./terminalUrlLinks";

// Pins the stitching rules on plain, right-trimmed row strings, exactly what the buffer-cell read hands the scan.

const rows =
    (...lines: string[]): RowAt =>
    (row) =>
        lines[row];

// claude's login panel: prose, then the OAuth URL hard-wrapped at the panel's width, then the prompt.
const OAUTH_LINES = [
    `Browser didn't open? Use the url below to sign in:`,
    `  https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9&`,
    `  response_type=code&redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth&`,
    `  scope=org%3Acreate_api_key+user%3Aprofile&code_challenge=E9Melhoa2Ow&`,
    `  state=af0ifjsldkj`,
    `Paste code here if prompted >`,
];
const OAUTH_URL =
    `https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9&` +
    `response_type=code&redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth&` +
    `scope=org%3Acreate_api_key+user%3Aprofile&code_challenge=E9Melhoa2Ow&` +
    `state=af0ifjsldkj`;

describe(`findUrls`, () => {
    it(`rejoins a hard-wrapped URL across a panel's real newlines and indents`, () => {
        const [span, ...rest] = findUrls(rows(...OAUTH_LINES), 0, 1);
        expect(rest).toEqual([]);
        expect(span?.url).toBe(OAUTH_URL);
        // Starts after the indent on row 1, ends on the last character of row 4.
        expect(span?.startRow).toBe(1);
        expect(span?.startIndex).toBe(2);
        expect(span?.endRow).toBe(4);
        expect(span?.endIndex).toBe(`  state=af0ifjsldkj`.length - 1);
    });

    it(`rejoins a soft wrap, where the fragment fills the row with no indent`, () => {
        const [span] = findUrls(rows(`https://example.com/a/very/long/path?x=1&`, `y=2&z=3`, ``), 0, 0);
        expect(span?.url).toBe(`https://example.com/a/very/long/path?x=1&y=2&z=3`);
        expect(span?.endRow).toBe(1);
    });

    it(`stops at the prose under a URL rather than swallowing it`, () => {
        const [span] = findUrls(rows(`https://example.com/authorize?code=true&`, `Waiting for authentication...`), 0, 0);
        expect(span?.url).toBe(`https://example.com/authorize?code=true&`);
        expect(span?.endRow).toBe(0);
    });

    it(`stops at a blank row, and at the end of the buffer`, () => {
        expect(findUrls(rows(`https://example.com/a&`, ``, `b=2`), 0, 0)[0]?.url).toBe(`https://example.com/a&`);
        expect(findUrls(rows(`https://example.com/a&`), 0, 0)[0]?.endRow).toBe(0);
    });

    it(`does not continue a URL that has anything after it on its row`, () => {
        const [span] = findUrls(rows(`see https://example.com/a (docs)`, `unrelated-solid-run`), 0, 0);
        expect(span?.url).toBe(`https://example.com/a`);
        expect(span?.endRow).toBe(0);
    });

    it(`trims the sentence punctuation a run collected, keeping the span in step`, () => {
        const [span] = findUrls(rows(`see https://example.com/docs.`), 0, 0);
        expect(span?.url).toBe(`https://example.com/docs`);
        expect(span?.startIndex).toBe(4);
        expect(span?.endIndex).toBe(`see https://example.com/docs`.length - 1);
    });

    it(`finds every URL on a row, and only the last one can wrap`, () => {
        const found = findUrls(rows(`a https://one.example and https://two.example/x&`, `y=1`), 0, 0);
        expect(found.map((span) => span.url)).toEqual([`https://one.example`, `https://two.example/x&y=1`]);
    });

    it(`does not re-scan a URL's own fragments as new URLs`, () => {
        // A fragment carrying a literal scheme would otherwise be picked up a second time on its own row.
        const found = findUrls(rows(`https://example.com/r?next=&`, `https%3A%2F%2Fx&u=https://inner.example`, `tail`), 0, 2);
        expect(found).toHaveLength(1);
        expect(found[0]?.endRow).toBe(2);
    });

    it(`rejects a match the browser would not open as the row shows it`, () => {
        // Unparseable, or a host that would be rewritten before opening (an IDN to punycode), never opens as shown.
        expect(findUrls(rows(`https://[bad`), 0, 0)).toEqual([]);
        expect(findUrls(rows(`https://例え.jp/x`), 0, 0)).toEqual([]);
        // Userinfo survives: `origin` drops it, so the check spells out the shown form.
        expect(findUrls(rows(`https://user:pw@example.com/x`), 0, 0)[0]?.url).toBe(`https://user:pw@example.com/x`);
    });

    it(`reports a span that starts above the scanned range and reaches into it`, () => {
        // The provider relies on this: it scans from the run's first row down to the hovered row.
        const [span] = findUrls(rows(...OAUTH_LINES), 0, 3);
        expect(span?.startRow).toBe(1);
        expect(span?.endRow).toBe(4);
    });
});

describe(`runStart`, () => {
    it(`walks up from a mid-URL fragment to the row the URL starts on`, () => {
        const rowAt = rows(...OAUTH_LINES);
        // Any hovered fragment walks back to row 1, the prose line that stops it.
        expect(runStart(rowAt, 4)).toBe(0);
        expect(runStart(rowAt, 2)).toBe(0);
    });

    it(`stays put on a row that is not a bare fragment`, () => {
        const rowAt = rows(...OAUTH_LINES);
        expect(runStart(rowAt, 0)).toBe(0);
        expect(runStart(rowAt, 5)).toBe(5);
    });

    it(`stops at a blank row above, and at the top of the buffer`, () => {
        expect(runStart(rows(`prose here`, ``, `solid-run`), 2)).toBe(2);
        expect(runStart(rows(`solid-run`, `more-run`), 1)).toBe(0);
    });
});
