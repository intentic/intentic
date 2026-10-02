import { chromium } from "playwright";
import { browserSessionFixture } from "../../testing.js";
import { browserSessionContext, closeBrowserSession, listBrowserSessions, openBrowserSession } from "./browser-sessions.js";
import * as feed from "../../seams/runtime-feed.js";

test("closing the active tab announces the remaining tab strip", async () => {
    const fixture = browserSessionFixture();
    const attach = jest.spyOn(chromium, "connectOverCDP").mockResolvedValue(fixture.browser);
    const publish = jest.spyOn(feed, "publishRuntimeChange");
    const name = openBrowserSession({ sessionId: "c105ed00-2222", server: "web", port: 43210 })!;
    try {
        await browserSessionContext(name);
        await Promise.resolve();
        publish.mockClear();
        fixture.second.events.emit("close");
        expect(listBrowserSessions().find((session) => session.name === name)?.pages).toEqual([
            { id: "p1", url: "about:blank", active: true },
        ]);
        expect(publish).toHaveBeenCalledWith("browsers");
        publish.mockClear();
        fixture.first.events.emit("close");
        expect(listBrowserSessions().find((session) => session.name === name)?.pages).toEqual([]);
        expect(publish).toHaveBeenCalledWith("browsers");
        publish.mockClear();
        openBrowserSession({ sessionId: "c105ed00-2222", server: "web", port: 43210 });
        expect(publish).toHaveBeenCalledWith("browsers");
    } finally {
        await closeBrowserSession(name);
        attach.mockRestore();
        publish.mockRestore();
    }
});


test("pruning an expired browser announces its disappearance", async () => {
    const fixture = browserSessionFixture();
    const attach = jest.spyOn(chromium, "connectOverCDP").mockResolvedValue(fixture.browser);
    const publish = jest.spyOn(feed, "publishRuntimeChange");
    const name = openBrowserSession({ sessionId: "e7f1eed0-2222", server: "web", port: 43211 })!;
    const clock = jest.spyOn(Date, "now");
    try {
        await browserSessionContext(name);
        await closeBrowserSession(name);
        const finishedAt = listBrowserSessions().find((session) => session.name === name)!.finishedAt!;
        publish.mockClear();
        clock.mockReturnValue(finishedAt + 2 * 3_600_000);
        expect(listBrowserSessions().map((session) => session.name)).not.toContain(name);
        expect(publish).toHaveBeenCalledWith("browsers");
    } finally {
        clock.mockRestore();
        publish.mockRestore();
        attach.mockRestore();
    }
});
