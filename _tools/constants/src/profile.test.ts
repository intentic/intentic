import { sharedCookieDomain } from "./profile.js";

// The site writes its edition cookie on this domain so the app's origin reads it; a wrong answer here is a reader who
// took the installer from /maker and opened the app as a developer.

test("the site and the app share the registrable domain, and that is what the cookie is set on", () => {
    expect(sharedCookieDomain("https://intentic.dev", "https://app.intentic.dev")).toBe("intentic.dev");
    expect(sharedCookieDomain("https://www.example.co.uk", "https://app.example.co.uk")).toBe("example.co.uk");
});

test("one host needs no domain: a host-only cookie is shared across ports already", () => {
    expect(sharedCookieDomain("http://localhost:4321", "http://localhost:5173")).toBeUndefined();
    expect(sharedCookieDomain("https://intentic.dev", "https://intentic.dev")).toBeUndefined();
});

test("nothing shareable answers nothing, rather than a domain no browser would accept", () => {
    expect(sharedCookieDomain("https://intentic.dev", "https://example.com")).toBeUndefined();
    expect(sharedCookieDomain("http://127.0.0.1:4321", "http://127.0.0.2:5173")).toBeUndefined();
    // A bare TLD is not a domain a cookie may be set on.
    expect(sharedCookieDomain("https://intentic.dev", "https://other.dev")).toBeUndefined();
});
