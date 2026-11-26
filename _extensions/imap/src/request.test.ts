import { cardFromConfig } from "./card.js";
import { requestArgs } from "./request.js";

// `imap curl` runs in the backend with the card's login, so only a request to the card's own server, and only options
// that cannot carry the login elsewhere or print it, reach curl.

const card = cardFromConfig("office", { host: "imap.example.org", port: "993", username: "me@example.org", password: "pw" });

test("a request to the card's own server keeps its IMAP command, gains TLS and a time limit", () => {
    expect(requestArgs(card, ["-s", "--url", "imaps://imap.example.org:993/INBOX", "-X", "SEARCH UNSEEN"])).toEqual([
        "--ssl-reqd",
        "--max-time",
        "540",
        "-s",
        "-X",
        "SEARCH UNSEEN",
        "--url",
        "imaps://imap.example.org:993/INBOX",
    ]);
    expect(requestArgs(card, ["imaps://IMAP.example.org/INBOX;UID=7", "-XFETCH", "-m", "9000"])).toEqual([
        "--ssl-reqd",
        "-X",
        "FETCH",
        "-m",
        "540",
        "--url",
        "imaps://IMAP.example.org/INBOX;UID=7",
    ]);
});

test("another server, another port, a login in the URL, or an option outside the set is refused", () => {
    expect(() => requestArgs(card, ["--url", "imaps://evil.example.org:993/INBOX"])).toThrow("reaches only this card's server, imap.example.org:993");
    expect(() => requestArgs(card, ["--url", "imap://imap.example.org/INBOX"])).toThrow("reaches only this card's server");
    expect(() => requestArgs(card, ["--url", "smtp://imap.example.org:993"])).toThrow("imaps:// URL");
    expect(() => requestArgs(card, ["--url", "imaps://me:pw@imap.example.org:993/"])).toThrow("leave it out of the URL");
    for (const option of ["-v", "--trace", "-K", "--upload-file", "-u", "--proxy", "-k", "--resolve"]) {
        expect(() => requestArgs(card, ["--url", "imaps://imap.example.org:993/", option, "x"])).toThrow(`does not take ${option}`);
    }
    expect(() => requestArgs(card, ["-s"])).toThrow("exactly one mailbox URL");
    expect(() => requestArgs(card, ["imaps://imap.example.org:993/A", "imaps://imap.example.org:993/B"])).toThrow("exactly one mailbox URL");
});
