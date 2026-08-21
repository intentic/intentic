import { describe, expect, it } from "vitest";
import { pruneAnnounced } from "./watermark.js";
import { addressedTo, newMessageIds } from "./poller.js";

describe("newMessageIds", () => {
    it("collects what Gmail added, across every page of history", () => {
        expect(
            newMessageIds([
                { history: [{ messagesAdded: [{ message: { id: "m1", labelIds: ["INBOX"] } }] }] },
                { history: [{ messagesAdded: [{ message: { id: "m2", labelIds: ["INBOX", "UNREAD"] } }] }] },
            ]),
        ).toEqual(["m1", "m2"]);
    });

    /* A message appears once per history record it touched, and Gmail emits several for one arrival (added,
     * then labelled). Dispatching each would wake an agent run per record for one email. */
    it("counts a message once however many history records mention it", () => {
        expect(
            newMessageIds([
                {
                    history: [
                        { messagesAdded: [{ message: { id: "m1", labelIds: ["INBOX"] } }] },
                        { messagesAdded: [{ message: { id: "m1", labelIds: ["INBOX"] } }] },
                    ],
                },
            ]),
        ).toEqual(["m1"]);
    });

    // Sent mail, drafts and anything filtered straight to a label are changes, not arrivals in the inbox.
    it("ignores anything that did not land in INBOX", () => {
        expect(newMessageIds([{ history: [{ messagesAdded: [{ message: { id: "m9", labelIds: ["SENT"] } }] }] }])).toEqual([]);
        expect(newMessageIds([{ history: [{ messagesAdded: [{ message: { id: "m9" } }] }] }])).toEqual([]);
    });

    it("reads an empty stretch of history as nothing new", () => {
        expect(newMessageIds([{ historyId: "9" }])).toEqual([]);
        expect(newMessageIds([])).toEqual([]);
    });
});

describe("addressedTo", () => {
    it("is true only when this account is an actual addressee", () => {
        expect(addressedTo("ana@x.com", "Ana <ana@x.com>, sam@x.com")).toBe(true);
        expect(addressedTo("ana@x.com", "ANA@X.COM")).toBe(true);
        expect(addressedTo("ana@x.com", "team@x.com")).toBe(false);
        expect(addressedTo("ana@x.com", "")).toBe(false);
    });
});

describe("pruneAnnounced", () => {
    const now = Date.parse("2026-08-09T12:00:00Z");

    /* Unpruned this map is the only thing in the watcher that grows forever: a year of meetings in a file
     * re-read every few minutes. */
    it("forgets events whose start is well past the window that could surface them", () => {
        expect(
            pruneAnnounced({ old: "2026-08-09T09:00:00Z", recent: "2026-08-09T11:45:00Z", soon: "2026-08-09T12:05:00Z" }, now, 60 * 60_000),
        ).toEqual({ recent: "2026-08-09T11:45:00Z", soon: "2026-08-09T12:05:00Z" });
    });

    it("keeps nothing out of nothing", () => {
        expect(pruneAnnounced({}, now, 60_000)).toEqual({});
    });
});
