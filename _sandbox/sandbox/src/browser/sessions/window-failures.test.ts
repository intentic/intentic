import { EventEmitter } from "node:events";
import type { BrowserFingerprint } from "./fingerprint.js";
import { describeLaunch } from "./owner-browser.js";
import { createFailureRing, watchWindowFailures } from "./window-failures.js";

// The owner window's own record: the launch line it writes, and what it keeps of the failures inside it until it
// closes.

const request = (url: string, resourceType: string, errorText?: string) => ({
    method: () => "POST",
    url: () => url,
    resourceType: () => resourceType,
    failure: () => (errorText === undefined ? null : { errorText }),
});

const response = (url: string, status: number, resourceType = "xhr") => ({
    status: () => status,
    url: () => url,
    request: () => request(url, resourceType),
});

const consoleMessage = (type: string, text: string) => ({ type: () => type, text: () => text });

test("failed pages and API calls are kept with their query values masked; images and successes are not", () => {
    const ring = createFailureRing(() => new Date("2026-10-11T00:00:00Z"));
    ring.response(response("https://x.com/i/api/onboarding?flow_token=abc123&lang=de#frag", 403));
    ring.response(response("https://x.com/ok", 200));
    ring.response(response("https://x.com/pixel.gif", 404, "image"));
    ring.requestFailed(request("https://accounts.google.com/signin?code=secret", "document", "net::ERR_CONNECTION_RESET"));
    ring.console(consoleMessage("warning", "just a warning"));
    ring.console(consoleMessage("error", "refresh failed: token=AbC9xY2kLmN0pQrS7tUvWxYz12345678"));
    const summary = ring.summary();
    expect(summary).toMatchObject({ total: 3, responses: 1, requestsFailed: 1, consoleErrors: 1 });
    expect(summary.recent[0]).toEqual({
        at: "2026-10-11T00:00:00.000Z",
        kind: "response",
        method: "POST",
        url: "https://x.com/i/api/onboarding?flow_token=***&lang=***",
        status: 403,
    });
    expect(summary.recent[1]).toMatchObject({ kind: "requestfailed", url: "https://accounts.google.com/signin?code=***", error: "net::ERR_CONNECTION_RESET" });
    expect(summary.recent[2]?.text).toBe("refresh failed: token=***");
});

test("only the newest twenty are kept, while the totals count all of them", () => {
    const ring = createFailureRing();
    for (let index = 0; index < 25; index += 1) {
        ring.response(response(`https://site.test/${String(index)}`, 500));
    }
    const summary = ring.summary();
    expect(summary.total).toBe(25);
    expect(summary.recent).toHaveLength(20);
    expect(summary.recent[0]?.url).toBe("https://site.test/5");
});

test("watching stops listening once stopped", () => {
    const context = new EventEmitter();
    const watch = watchWindowFailures(context);
    context.emit("response", response("https://site.test/a", 502));
    watch.stop();
    context.emit("response", response("https://site.test/b", 502));
    expect(watch.summary().total).toBe(1);
    expect(context.listenerCount("response")).toBe(0);
});

const device: BrowserFingerprint = {
    webglVendor: "Google Inc. (Intel)",
    webglRenderer: "ANGLE (Intel)",
    hardwareConcurrency: 8,
    deviceMemory: 8,
    locale: "de-DE",
    timezoneId: "Europe/Berlin",
    languages: ["de-DE", "de"],
};

test("the launch line says how the window started and with what, the exit's address left out", () => {
    const line = describeLaunch({ userDataDir: "/state/p", display: ":7", fingerprint: device, proxy: "socks5://127.0.0.1:4100", windowArgs: ["--window-size=1,1"] }, 42);
    expect(line).toMatchObject({ launch: "spawn+cdp", pid: 42, profile: "/state/p", display: ":7", proxy: true, locale: "de-DE", timezone: "Europe/Berlin" });
    expect(line["args"]).toContain("--proxy-server=<exit>");
    expect(line["args"]).toContain("--window-size=1,1");
    expect(JSON.stringify(line)).not.toContain("4100");
});
