import type { FetchMessageObject } from "imapflow";
import { expect, test } from "vitest";
import { CATCH_UP_MAX, configKeyOf, desiredAccounts, mailboxOf, syncNewMail, type SyncOptions, type SyncSource } from "./connection.js";

const config = { provider: "imap", host: "imap.example.com", port: "993", username: "me@example.com", password: "pw" };

test("mailboxOf defaults to INBOX", () => {
    expect(mailboxOf(config)).toBe("INBOX");
    expect(mailboxOf({ ...config, mailbox: "" })).toBe("INBOX");
    expect(mailboxOf({ ...config, mailbox: "Archive" })).toBe("Archive");
});

test("configKeyOf changes when any connection-relevant field changes", () => {
    expect(configKeyOf(config)).toBe(configKeyOf({ ...config }));
    expect(configKeyOf(config)).not.toBe(configKeyOf({ ...config, password: "other" }));
    expect(configKeyOf(config)).not.toBe(configKeyOf({ ...config, mailbox: "Archive" }));
});

test("desiredAccounts filters unconfigured connectors", () => {
    const connectors = [
        { id: "work", config },
        { id: "blank", config: { ...config, password: "" } },
    ];
    // The no-automations gate lives in the shared gateway shell now — this only judges config completeness.
    expect(desiredAccounts(connectors)).toEqual([{ id: "work", config }]);
});

interface Fake {
    readonly source: SyncSource;
    readonly dispatched: number[];
    readonly saved: number[];
    readonly warned: string[];
    readonly opts: SyncOptions;
}

const fake = (uids: number[], overrides: Partial<SyncOptions> = {}): Fake => {
    const dispatched: number[] = [];
    const saved: number[] = [];
    const warned: string[] = [];
    const source: SyncSource = {
        search: async (range) => {
            const from = Number(range.split(":")[0] ?? "");
            const matched = uids.filter((uid) => uid >= from);
            // RFC 3501 `N:*` semantics: the highest-uid message always matches, even when N exceeds it.
            return uids.length > 0 && matched.length === 0 ? [Math.max(...uids)] : matched;
        },
        fetch: async (uid): Promise<FetchMessageObject> => ({ uid, seq: uid }),
    };
    const opts: SyncOptions = {
        capabilityId: "work",
        // A minimal conforming envelope: syncNewMail only threads it through, and the uid rides in extra.
        payloadOf: async (msg) => ({
            provider: "imap",
            type: "message",
            id: String(msg.uid),
            channelId: "INBOX",
            author: { id: "a", name: "a" },
            content: "",
            timestamp: "2026-01-01T00:00:00.000Z",
            extra: { uid: msg.uid },
        }),
        dispatch: async (payload) => {
            dispatched.push(payload.extra?.["uid"] as number);
        },
        save: async (lastUid) => {
            saved.push(lastUid);
        },
        warn: (_fields, msg) => {
            warned.push(msg);
        },
        ...overrides,
    };
    return { source, dispatched, saved, warned, opts };
};

test("syncNewMail dispatches everything above the mark, oldest first, persisting per message", async () => {
    const { source, dispatched, saved, opts } = fake([12, 11, 13]);
    const mark = { lastUid: 10 };
    await syncNewMail(source, mark, opts);
    expect(dispatched).toEqual([11, 12, 13]);
    expect(saved).toEqual([11, 12, 13]);
    expect(mark.lastUid).toBe(13);
});

test("syncNewMail drops the already-seen top message a `N:*` search always returns", async () => {
    // RFC 3501: `11:*` on a mailbox whose highest uid is 10 still matches uid 10.
    const { source, dispatched, saved, opts } = fake([10]);
    const mark = { lastUid: 10 };
    await syncNewMail(source, mark, opts);
    expect(dispatched).toEqual([]);
    expect(saved).toEqual([]);
    expect(mark.lastUid).toBe(10);
});

test("syncNewMail aborts without advancing when a dispatch fails", async () => {
    const { source, dispatched, saved, opts } = fake([11, 12, 13], {
        dispatch: async (payload) => {
            if (payload.extra?.["uid"] === 12) {
                throw new Error("daemon down");
            }
        },
    });
    const mark = { lastUid: 10 };
    await expect(syncNewMail(source, mark, opts)).rejects.toThrow("daemon down");
    expect(saved).toEqual([11]);
    expect(mark.lastUid).toBe(11);
    expect(dispatched).toEqual([]);
});

test("syncNewMail skips a message expunged between search and fetch", async () => {
    const { source, dispatched, saved, opts } = fake([11, 12]);
    const gone: SyncSource = { ...source, fetch: async (uid) => (uid === 11 ? false : source.fetch(uid)) };
    const mark = { lastUid: 10 };
    await syncNewMail(gone, mark, opts);
    expect(dispatched).toEqual([12]);
    expect(saved).toEqual([12]);
});

test("syncNewMail caps a huge backlog to the newest messages and says so", async () => {
    const uids = Array.from({ length: CATCH_UP_MAX + 20 }, (_, index) => index + 100);
    const { source, dispatched, warned, opts } = fake(uids);
    const mark = { lastUid: 10 };
    await syncNewMail(source, mark, opts);
    expect(dispatched).toHaveLength(CATCH_UP_MAX);
    expect(dispatched[0]).toBe(120);
    expect(mark.lastUid).toBe(uids[uids.length - 1]);
    expect(warned).toEqual(["imap catch-up capped to the newest messages"]);
});
