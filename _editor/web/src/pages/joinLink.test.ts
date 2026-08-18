import { describe, expect, it } from "vitest";
import { joinRefusal, readJoinLink } from "./joinLink";

/* The link's shape and the box's refusals — the two things a guest meets before anything else, and the two
 * this app cannot see going wrong: a link is read on somebody else's machine, and a refusal is the only
 * sentence they get. */

describe("reading a link", () => {
    it("takes the box address and the secret from the fragment", () => {
        expect(readJoinLink(`#s=${encodeURIComponent(`https://sandbox-abc.sbx.example.dev`)}&k=ijl_secret`)).toEqual({
            daemonUrl: `https://sandbox-abc.sbx.example.dev`,
            secret: `ijl_secret`,
        });
    });

    it("normalizes the address to an origin, so a trailing path in the link cannot bend where /join is sent", () => {
        expect(readJoinLink(`#s=${encodeURIComponent(`https://sandbox-abc.sbx.example.dev/somewhere/else`)}&k=ijl_secret`)?.daemonUrl).toBe(
            `https://sandbox-abc.sbx.example.dev`,
        );
    });

    it("refuses a link with either half missing — the truncation a chat app causes", () => {
        expect(readJoinLink(`#s=${encodeURIComponent(`https://sandbox-abc.sbx.example.dev`)}`)).toBeUndefined();
        expect(readJoinLink(`#k=ijl_secret`)).toBeUndefined();
        expect(readJoinLink(``)).toBeUndefined();
    });

    it("refuses a plain-http box: the sign-in and the session both cross that hop", () => {
        expect(readJoinLink(`#s=${encodeURIComponent(`http://sandbox-abc.sbx.example.dev`)}&k=ijl_secret`)).toBeUndefined();
    });

    it("refuses an address that is not a URL at all rather than throwing on it", () => {
        expect(readJoinLink(`#s=not-a-url&k=ijl_secret`)).toBeUndefined();
    });
});

describe("what a refusal says", () => {
    it("tells the three link failures apart, because they mean different things to the person holding it", () => {
        expect(joinRefusal(404, `unknown`)).toContain(`does not work any more`);
        expect(joinRefusal(410, `expired`)).toContain(`expired`);
        expect(joinRefusal(410, `full`)).toContain(`as many people as it was meant for`);
    });

    it("names the owner's missing step when the box has nobody to admit them", () => {
        expect(joinRefusal(409, ``)).toContain(`no owner yet`);
    });

    it("points a rejected sign-in at the account, which is the usual mistake", () => {
        expect(joinRefusal(401, ``)).toContain(`Google account`);
    });

    it("falls back to naming the status rather than inventing a cause", () => {
        expect(joinRefusal(500, ``)).toContain(`500`);
    });
});
