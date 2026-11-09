import { relaySaysGone } from "./relay.js";
import { proxyPage, type RelayAnswer, relayRefusal } from "./relay.testing.js";

// A relay channel is forgotten only on the relay's own word that it is gone: the relay sits behind the platform's proxy,
// and a platform that is down answers 403s and 404s of its own, which must never unregister a phone.

const says = ({ status, body }: RelayAnswer): boolean => relaySaysGone(status, body);

test("the relay's marked refusals forget the channel: a dead device, an unknown one, a rotated secret", () => {
    expect(says(relayRefusal(410, "GONE", true))).toBe(true);
    expect(says(relayRefusal(404, "NOT_FOUND", true))).toBe(true);
    expect(says(relayRefusal(403, "FORBIDDEN", true))).toBe(true);
});

test("a proxy's 403, 404 or 410 in front of a platform that is down keeps the channel", () => {
    expect(says(proxyPage(404))).toBe(false);
    expect(says(proxyPage(403))).toBe(false);
    expect(says(proxyPage(410))).toBe(false);
    expect(relaySaysGone(404, "")).toBe(false);
    expect(relaySaysGone(404, `{"error":"not found"}`)).toBe(false);
});

test("the relay's own unmarked refusals keep it: no credential for the push service, a passing failure", () => {
    expect(says(relayRefusal(404, "NOT_FOUND", false))).toBe(false);
    expect(says(relayRefusal(502, "BAD_GATEWAY", false))).toBe(false);
});

// A platform from before the marker forgot a dead device's row as it answered 410, so that answer is the last chance to
// forget the channel; its 403 and 404 stay ambiguous with a proxy's and keep it.
test("a relay from before the marker is believed on its own 410 alone", () => {
    expect(says(relayRefusal(410, "GONE", false))).toBe(true);
    expect(says(relayRefusal(404, "NOT_FOUND", false))).toBe(false);
    expect(says(relayRefusal(403, "FORBIDDEN", false))).toBe(false);
});
