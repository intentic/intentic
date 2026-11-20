import { addressOf, addressParts, securityOf, toUrl, wrappedUrl } from "./address";

// The address bar is the client's own now, so what a typed line becomes is decided here, not by an omnibox.
describe("toUrl", () => {
    test("an address with a scheme is taken as written", () => {
        expect(toUrl(`https://example.com/a?b=1`)).toBe(`https://example.com/a?b=1`);
        expect(toUrl(`about:blank`)).toBe(`about:blank`);
        expect(toUrl(`data:text/html,<p>hi</p>`)).toBe(`data:text/html,<p>hi</p>`);
        expect(toUrl(`  http://x.test  `)).toBe(`http://x.test`);
    });

    test("a host is asked over https, a local one over http", () => {
        expect(toUrl(`example.com`)).toBe(`https://example.com`);
        expect(toUrl(`docs.example.com/guide#top`)).toBe(`https://docs.example.com/guide#top`);
        expect(toUrl(`localhost:5173/app`)).toBe(`http://localhost:5173/app`);
        expect(toUrl(`10.0.0.2:8080`)).toBe(`http://10.0.0.2:8080`);
    });

    test("anything else is a search, spaces included", () => {
        expect(toUrl(`how to center a div`)).toBe(`https://search.brave.com/search?q=how%20to%20center%20a%20div`);
        // Host-like first word, but a sentence: a search, not an address.
        expect(toUrl(`example.com pricing`)).toBe(`https://search.brave.com/search?q=example.com%20pricing`);
        expect(toUrl(`intentic`)).toBe(`https://search.brave.com/search?q=intentic`);
    });

    test("nothing typed goes nowhere", () => {
        expect(toUrl(`   `)).toBeUndefined();
    });

    test("a search goes to the engine the sandbox's settings name", () => {
        expect(toUrl(`vue router`, `google`)).toBe(`https://www.google.com/search?q=vue%20router`);
        expect(toUrl(`vue router`, `duckduckgo`)).toBe(`https://duckduckgo.com/?q=vue%20router`);
        expect(toUrl(`vue router`, `bing`)).toBe(`https://www.bing.com/search?q=vue%20router`);
        expect(toUrl(`vue router`, `kagi`)).toBe(`https://kagi.com/search?q=vue%20router`);
        // An address is an address whichever engine is chosen.
        expect(toUrl(`192.168.0.168`, `google`)).toBe(`http://192.168.0.168`);
    });
});

describe("addressOf", () => {
    test("names the address typed text stands for, and nothing for a search", () => {
        expect(addressOf(`192.168.0.168`)).toBe(`http://192.168.0.168`);
        expect(addressOf(`github.com/intentic`)).toBe(`https://github.com/intentic`);
        expect(addressOf(`router login`)).toBeUndefined();
        expect(addressOf(`intentic`)).toBeUndefined();
        expect(addressOf(``)).toBeUndefined();
    });
});

describe("wrappedUrl", () => {
    test("Ctrl+Enter makes a bare word a .com site", () => {
        expect(wrappedUrl(`intentic`)).toBe(`https://www.intentic.com`);
        expect(wrappedUrl(` my-shop `)).toBe(`https://www.my-shop.com`);
    });

    test("anything already an address, or more than one word, is left to Enter", () => {
        expect(wrappedUrl(`example.com`)).toBeUndefined();
        expect(wrappedUrl(`two words`)).toBeUndefined();
        expect(wrappedUrl(`https://x`)).toBeUndefined();
        expect(wrappedUrl(``)).toBeUndefined();
    });
});

describe("addressParts", () => {
    test("drops the scheme and sets the host apart from the rest", () => {
        expect(addressParts(`https://checkout.stripe.com/c/pay/cs_test?x=1#top`)).toEqual({
            host: `checkout.stripe.com`,
            rest: `/c/pay/cs_test?x=1#top`,
        });
        expect(addressParts(`http://localhost:5173/app`)).toEqual({ host: `localhost:5173`, rest: `/app` });
    });

    test("a site's root is just the site", () => {
        expect(addressParts(`https://example.com/`)).toEqual({ host: `example.com`, rest: `` });
        expect(addressParts(`https://example.com/?q=1`)).toEqual({ host: `example.com`, rest: `/?q=1` });
    });

    test("anything without a web host is shown as written", () => {
        expect(addressParts(`about:blank`)).toBeUndefined();
        expect(addressParts(`data:text/html,<p>hi</p>`)).toBeUndefined();
        expect(addressParts(`file:///tmp/a.html`)).toBeUndefined();
        expect(addressParts(``)).toBeUndefined();
    });
});

describe("securityOf", () => {
    test("https is secure, plain http is flagged, the rest says nothing", () => {
        expect(securityOf(`https://example.com`)).toBe(`secure`);
        expect(securityOf(`http://example.com`)).toBe(`insecure`);
        expect(securityOf(`about:blank`)).toBeUndefined();
        expect(securityOf(`not an address`)).toBeUndefined();
    });
});
