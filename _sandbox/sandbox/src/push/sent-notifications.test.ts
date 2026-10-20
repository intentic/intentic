import { createSentNotifications } from "./sent-notifications.js";

/* The words a native app reads back are held in memory under a bound: the newest 200 tags, by when each was last
 * written, so a sandbox that notifies all day keeps the recent ones and never grows. */

test("keeps the newest 200 tags, counting a tag written again as new", () => {
    const sent = createSentNotifications();
    for (let index = 0; index < 200; index++) {
        sent.remember({ title: `t${index}`, body: "", tag: `tag-${index}` }, ["bob@example.com"]);
    }
    // Written again, the oldest becomes the newest, and the next new tag pushes out the one after it instead.
    sent.remember({ title: "again", body: "", tag: "tag-0" }, ["ada@example.com"]);
    sent.remember({ title: "new", body: "", tag: "tag-200" }, ["bob@example.com"]);
    expect(sent.read("tag-0", "bob@example.com")?.title).toBe("t0");
    expect(sent.read("tag-0", "ada@example.com")?.title).toBe("again");
    expect(sent.read("tag-1", "bob@example.com")).toBeUndefined();
    expect(sent.read("tag-2", "bob@example.com")?.title).toBe("t2");
    expect(sent.read("tag-200", "bob@example.com")?.title).toBe("new");
});
