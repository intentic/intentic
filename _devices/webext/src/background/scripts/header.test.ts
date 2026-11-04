import { connectSource, matchSite, parseUserScript } from "./header.js";

// What a script's header may ask for, read the way the worker and the popup both read it. The refusals are the point:
// each is a way a script could reach further than the sites the person allowed, said back to the agent as what to write
// instead.

const script = (...lines: string[]): string =>
    ["// ==UserScript==", ...lines.map((line) => `// ${line}`), "// ==/UserScript==", "document.title = 'x';"].join("\n");

test("a header reads into the script's name, sites, hosts and timing", () => {
    const parsed = parseUserScript(
        script("@name   PR sizes", "@version 1.2", "@match https://github.com/*/pulls*", "@match https://github.com/*/pull/*", "@connect api.github.com", "@connect https://Example.org", "@run-at document-start"),
    );
    expect(parsed).toMatchObject({
        ok: true,
        script: {
            name: "PR sizes",
            version: "1.2",
            sites: ["https://github.com/*"],
            connects: ["https://api.github.com", "https://example.org"],
            runAt: "document_start",
            warnings: [],
        },
    });
});

test("a script runs at document idle unless it says otherwise, and its whole text is what is kept", () => {
    const source = script("@name Quiet", "@match https://example.com/*");
    const parsed = parseUserScript(source);
    expect(parsed.ok && parsed.script.runAt).toBe("document_idle");
    expect(parsed.ok && parsed.script.source).toBe(source);
});

test("every @match must name one site exactly", () => {
    expect(matchSite("https://github.com/*")).toEqual({ site: "https://github.com/*" });
    expect(matchSite("http://localhost:3000/app/*")).toEqual({ site: "http://localhost:3000/*" });
    for (const pattern of ["<all_urls>", "*://github.com/*", "https://*.github.com/*", "https://*/*", "file:///tmp/*", "github.com/*"]) {
        expect(matchSite(pattern)).toHaveProperty("message");
    }
});

test("@connect takes hosts, never everything", () => {
    expect(connectSource("api.example.com")).toEqual({ source: "https://api.example.com" });
    expect(connectSource("*.githubusercontent.com")).toEqual({ source: "https://*.githubusercontent.com" });
    expect(connectSource("http://localhost:8080")).toEqual({ source: "http://localhost:8080" });
    for (const value of ["*", "<all_urls>", "self", "*.com", "https://api.example.com/path", "not a host"]) {
        expect(connectSource(value)).toHaveProperty("message");
    }
});

test("what would fetch code, or reach sites by glob, is refused with what to write instead", () => {
    const refusal = (source: string): string => {
        const parsed = parseUserScript(source);
        return parsed.ok ? "" : parsed.message;
    };
    expect(refusal("document.title = 'x';")).toContain("==UserScript==");
    expect(refusal(script("@match https://example.com/*"))).toContain("@name");
    expect(refusal(script("@name x"))).toContain("@match");
    expect(refusal(script("@name x", "@match https://example.com/*", "@require https://cdn.example/lib.js"))).toContain("Bundle it");
    expect(refusal(script("@name x", "@include *"))).toContain("@match");
    expect(refusal(script("@name x", "@match https://example.com/*", "@connect *"))).toContain("every host");
    expect(refusal(script("@name x", "@match https://example.com/*", "@run-at whenever"))).toContain("document-idle");
    expect(refusal(["// ==UserScript==", "// @name x"].join("\n"))).toContain("never ends");
    expect(refusal(`${script("@name x", "@match https://example.com/*")}\n${"x".repeat(260_000)}`)).toContain("kB");
});

test("@grant is no error, but the agent is told there are no GM_ functions here", () => {
    const parsed = parseUserScript(script("@name x", "@match https://example.com/*", "@grant GM_xmlhttpRequest", "@grant none"));
    expect(parsed.ok && parsed.script.warnings.join(" ")).toContain("GM_xmlhttpRequest");
});
