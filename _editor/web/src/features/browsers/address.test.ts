import { addressParts, securityOf, toUrl } from "./address";

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
        expect(toUrl(`how to center a div`)).toBe(`https://duckduckgo.com/?q=how%20to%20center%20a%20div`);
        // Host-like first word, but a sentence: a search, not an address.
        expect(toUrl(`example.com pricing`)).toBe(`https://duckduckgo.com/?q=example.com%20pricing`);
        expect(toUrl(`intentic`)).toBe(`https://duckduckgo.com/?q=intentic`);
    });

    test("nothing typed goes nowhere", () => {
        expect(toUrl(`   `)).toBeUndefined();
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
