import type { CiFeedEvent } from "@intentic/sandbox-contract/schemas/ci";
import { SETTLES, waitFor } from "@intentic/testing/bun";
import { Hono } from "hono";
import type { AppEnv } from "../../app-env.js";
import { ciFeedRoute, publishCiFeed } from "./ci-feed.js";

// The CI feed as a program reads it (ci-feed.ts): Server-Sent Events, a comment as it opens, one `data:` line of JSON per
// frame in the order published, a comment on a beat while nothing is said, and nothing kept for a reader once it lets go.

const JOB: CiFeedEvent = {
    kind: "job",
    repo: "web",
    host: "github",
    project: "acme/web",
    runId: 7,
    workflow: "CI",
    job: "publish-images",
    branch: "main",
    sha: "abc1234def",
    status: "success",
    url: "https://github.com/acme/web/actions/runs/7/job/70",
};

// The stream on a beat short enough to hear, and what it has said so far as text.
const open = async (keepAliveMs: number) => {
    const app = new Hono<AppEnv>();
    app.get("/ci/feed", ciFeedRoute(keepAliveMs));
    const response = await app.request("/ci/feed");
    const reader = response.body?.getReader();
    if (reader === undefined) {
        throw new Error("the feed answered no body");
    }
    let said = "";
    const decoder = new TextDecoder();
    const reading = (async () => {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) {
                return;
            }
            said += decoder.decode(value);
        }
    })();
    return { response, said: () => said, close: async () => {
        await reader.cancel();
        await reading;
    } };
};

test("a frame published while a reader is subscribed reaches it as one data line, after the opening comment", async () => {
    const feed = await open(60_000);
    expect(feed.response.headers.get("content-type")).toContain("text/event-stream");
    await waitFor(() => expect(feed.said()).toBe(": ci feed\n\n"), SETTLES);
    const failed: CiFeedEvent = { ...JOB, job: "verify", status: "failed" };
    publishCiFeed(JOB);
    publishCiFeed(failed);
    await waitFor(() => expect(feed.said()).toBe(`: ci feed\n\ndata: ${JSON.stringify(JOB)}\n\ndata: ${JSON.stringify(failed)}\n\n`), SETTLES);
    await feed.close();
});

test("an idle stream says a keep-alive comment on its beat, and a reader that let go is told nothing more", async () => {
    const feed = await open(20);
    await waitFor(() => expect(feed.said()).toContain(": keep-alive\n\n"), SETTLES);
    await feed.close();
    const before = feed.said();
    publishCiFeed(JOB);
    expect(feed.said()).toBe(before);
    expect(before).not.toContain("data:");
});
