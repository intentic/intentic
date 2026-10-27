// What the editor does with a guarded preview's ask for a pass: whose ask it takes (the tab's own frame, about the
// preview's own origin, in the guarded page's shape), which answer it follows, what `/preview-pass?url=` may name, and
// the window inside which a second ask means the browser did not keep the first pass.
import "@intentic/testing/dom";
import type { LocationQuery } from "vue-router";
import {
    forgetPass,
    PASS_AGAIN_MS,
    passAskedTooSoon,
    passAskFrom,
    passedTooRecently,
    passLinkFor,
    passRequestOf,
    rememberPass,
} from "./previewPassRules";

const PREVIEW = `https://preview-shop-0123456789ab.example.test`;
// Any two message sources stand for the tab's own frame and some other window; a port is one.
const frame = new MessageChannel().port1;
const elsewhere = new MessageChannel().port1;
const ask = (href: unknown) => ({ intentic: `preview-pass`, href });

afterEach(() => {
    sessionStorage.clear();
});

describe(`a framed preview's ask`, () => {
    it(`is taken from the tab's own frame, about the preview's own origin, at whatever path it was on`, () => {
        expect(passAskFrom({ source: frame, data: ask(`${PREVIEW}/cart?step=2`) }, frame, PREVIEW)).toBe(`${PREVIEW}/cart?step=2`);
    });

    it(`is ignored from any other window, or before the frame is there to compare with`, () => {
        expect(passAskFrom({ source: elsewhere, data: ask(PREVIEW) }, frame, PREVIEW)).toBeUndefined();
        expect(passAskFrom({ source: null, data: ask(PREVIEW) }, null, PREVIEW)).toBeUndefined();
        expect(passAskFrom({ source: frame, data: ask(PREVIEW) }, frame, undefined)).toBeUndefined();
    });

    // The frame may have been navigated anywhere; the editor acts for the preview's own name and no other.
    it(`is ignored for any other origin, scheme or port, and for an address with no origin`, () => {
        for (const href of [
            `https://preview-other-0123456789ab.example.test/`,
            `https://evil.test/?to=${PREVIEW}`,
            `http://preview-shop-0123456789ab.example.test/`,
            `${PREVIEW}:8443/`,
            `javascript:alert(1)`,
            `data:text/html,hi`,
            `/relative`,
        ]) {
            expect(passAskFrom({ source: frame, data: ask(href) }, frame, PREVIEW)).toBeUndefined();
        }
    });

    it(`is ignored in any other shape`, () => {
        for (const data of [ask(42), ask(``), { intentic: `preview-other`, href: PREVIEW }, { href: PREVIEW }, `preview-pass`, null]) {
            expect(passAskFrom({ source: frame, data }, frame, PREVIEW)).toBeUndefined();
        }
    });
});

it(`follows the daemon's answer only where it leads to the asked preview's origin`, () => {
    const link = `${PREVIEW}/__intentic/preview-pass?ticket=t1&to=%2Fcart`;
    expect(passLinkFor(link, `${PREVIEW}/cart`)).toBe(link);
    expect(passLinkFor(`${PREVIEW}/cart`, `${PREVIEW}/cart`)).toBe(`${PREVIEW}/cart`);
    expect(passLinkFor(`https://evil.test/`, `${PREVIEW}/cart`)).toBeUndefined();
    expect(passLinkFor(`javascript:alert(1)`, `${PREVIEW}/cart`)).toBeUndefined();
});

describe(`what /preview-pass may name`, () => {
    it(`reads one https address on a sandbox's name, with the sandbox it belongs to`, () => {
        expect(passRequestOf({ url: `${PREVIEW}/cart?step=2` })).toEqual({
            url: `${PREVIEW}/cart?step=2`,
            host: `preview-shop-0123456789ab.example.test`,
            sandboxId: `0123456789ab`,
        });
        expect(passRequestOf({ url: `https://port-x7k2-0123456789ab.example.test` })?.sandboxId).toBe(`0123456789ab`);
    });

    it(`names nothing for a missing, repeated or blank key, a plain-http or unparseable address, or a name with no sandbox in it`, () => {
        const queries: readonly LocationQuery[] = [
            {},
            { url: null },
            { url: [`${PREVIEW}/`, `${PREVIEW}/other`] },
            { url: `` },
            { url: `http://preview-shop-0123456789ab.example.test/` },
            { url: `not an address` },
            { url: `https://example.test/` },
            { url: `https://0123456789ab.local.example.test/` },
        ];
        for (const query of queries) {
            expect(passRequestOf(query)).toBeUndefined();
        }
    });
});

describe(`asking again too soon`, () => {
    it(`is an ask inside the window after the last pass, and nothing before any pass`, () => {
        expect(passAskedTooSoon(undefined, 1_000)).toBe(false);
        expect(passAskedTooSoon(1_000, 1_000 + PASS_AGAIN_MS - 1)).toBe(true);
        expect(passAskedTooSoon(1_000, 1_000 + PASS_AGAIN_MS)).toBe(false);
    });

    it(`is remembered for the tab, per preview host, until it runs out or is forgotten`, () => {
        const host = `preview-shop-0123456789ab.example.test`;
        expect(passedTooRecently(host, 5_000)).toBe(false);
        rememberPass(host, 5_000);
        expect(passedTooRecently(host, 6_000)).toBe(true);
        expect(passedTooRecently(`port-x7k2-0123456789ab.example.test`, 6_000)).toBe(false);
        expect(passedTooRecently(host, 5_000 + PASS_AGAIN_MS)).toBe(false);
        forgetPass();
        expect(passedTooRecently(host, 6_000)).toBe(false);
    });

    it(`reads a memory in any other shape as none`, () => {
        sessionStorage.setItem(`intentic.previewPass`, `{"host":5}`);
        expect(passedTooRecently(`preview-shop-0123456789ab.example.test`, 6_000)).toBe(false);
    });
});
