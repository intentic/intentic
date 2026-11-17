import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { opt } from "../../../../opt.js";
import { memoryFleet } from "../../../../conversations/registry/agents-registry.testing.js";
import { untilFileAppears } from "../../file-appears.js";
import type { RpcMessage } from "../../turn-mounts.js";
import type { MountCall, MountEndpoints } from "../../turn-mounts.routes.js";
import { backgroundJobOf, jobStatusPath } from "../background-jobs.js";
import { CHATGPT_IMAGE_TOOL, chatgptImagesInBackground, IMAGE_JOB_DESCRIPTION, imageJobEnd } from "./chatgpt-image-jobs.js";
import { jobReport } from "../job-report.js";

// chatgpt_image at the owner's-browser door (2026-11-17, the shinobi-society audit): answered within seconds with a job
// id, the picture's path (or why there is none) collected from the job; queued per browser; a refusal still a refusal;
// and a turn with no conversation to wake still waits in the call.

const actors = memoryFleet().conversations;
const ROOT = mkdtempSync(join(tmpdir(), "chatgpt-image-jobs-test-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const seedOf = (conversationId: string) => ({ conversationId, profile: {}, conversations: actors, tmp: ROOT });
const target: Parameters<MountEndpoints["webext"]>[0] = { kind: "webext", id: "chrome" };
const callIn = (conversationId: string | undefined, clientCeilingMs?: number): MountCall => ({
    name: "chrome",
    conversationId,
    signal: new AbortController().signal,
    ...opt("clientCeilingMs", clientCeilingMs),
});
const image = (prompt: string, chat?: string): RpcMessage => ({
    jsonrpc: "2.0",
    id: prompt,
    method: "tools/call",
    params: { name: CHATGPT_IMAGE_TOOL, arguments: { prompt, ...opt("chat", chat) } },
});
const words = (text: string, isError = false): RpcMessage => ({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }], isError } });
const TextResultSchema = z.object({ content: z.array(z.object({ text: z.string() })) });
const ListingSchema = z.object({ tools: z.array(z.object({ name: z.string(), description: z.string() })) });
const ArgsSchema = z.object({ prompt: z.string() });
const textOf = (answer: RpcMessage | undefined): string => TextResultSchema.parse(answer?.result).content[0]?.text ?? "";
const listingOf = (answer: RpcMessage | undefined) => ListingSchema.parse(answer?.result).tools;
const jobIdOf = (answer: RpcMessage | undefined): string => /job "([^"]+)"/u.exec(textOf(answer))?.[1] ?? "";

// A browser whose every call waits until the test answers it, by prompt; `calls` is what reached it, in order.
const slowBrowser = () => {
    const calls: { readonly prompt: string; readonly call: MountCall }[] = [];
    const pending = new Map<string, (answer: RpcMessage) => void>();
    const door: MountEndpoints["webext"] = async (_target, message, call) => {
        if (message.method === "tools/list") {
            return { jsonrpc: "2.0", id: message.id ?? null, result: { tools: [{ name: CHATGPT_IMAGE_TOOL, description: "one call, up to 9 minutes" }, { name: "snapshot", description: "the page" }] } };
        }
        const { prompt } = ArgsSchema.parse(message.params?.["arguments"]);
        calls.push({ prompt, call });
        return await new Promise<RpcMessage>((resolve) => pending.set(prompt, resolve));
    };
    return { door, calls, answer: (prompt: string, answer: RpcMessage) => pending.get(prompt)?.(answer) };
};

const backgrounded = (door: MountEndpoints["webext"]) => chatgptImagesInBackground({ seedOf, quickMs: 20 }, door);

const ended = async (conversationId: string, id: string) => {
    const job = backgroundJobOf(actors, conversationId, id);
    if (job === undefined) {
        throw new Error(`no job ${id}`);
    }
    await untilFileAppears(jobStatusPath(job), 2_000);
    return await jobReport(actors, job);
};

test("a slow image is answered with a job id at once, and the job ends with the saved path the browser gave", async () => {
    const browser = slowBrowser();
    const answer = await backgrounded(browser.door)(target, image("Watercolor: a fox on a bridge"), callIn("conv-image-slow"));
    expect(textOf(answer)).toContain("Started: job");
    expect(textOf(answer)).toContain("mcp__subagents__wait");
    const id = jobIdOf(answer);
    const job = backgroundJobOf(actors, "conv-image-slow", id);
    if (job === undefined) {
        throw new Error(`no job ${id}`);
    }
    expect(await jobReport(actors, job)).toMatchObject({
        running: true,
        outputTail: expect.stringContaining(`ChatGPT image in browser "chrome": "Watercolor: a fox on a bridge"`),
    });
    browser.answer("Watercolor: a fox on a bridge", words("Made 1 image with ChatGPT and saved it:\n- /work/.intentic/records/artifacts/fox.png"));
    expect(await ended("conv-image-slow", id)).toMatchObject({ exitCode: 0, outputTail: "Made 1 image with ChatGPT and saved it:\n- /work/.intentic/records/artifacts/fox.png\n" });
});

test("a refusal that comes back at once is the call's answer, and no job is filed", async () => {
    const door: MountEndpoints["webext"] = async () => words("chatgpt.com is not allowed in this browser. Call ask_access.", true);
    const answer = await backgrounded(door)(target, image("a lotus"), callIn("conv-image-refused"));
    expect(textOf(answer)).toBe("chatgpt.com is not allowed in this browser. Call ask_access.");
    expect(actors.state("conv-image-refused")?.jobs ?? []).toEqual([]);
});

test("a failed image ends its job as failed, with ChatGPT's reason", async () => {
    const browser = slowBrowser();
    const id = jobIdOf(await backgrounded(browser.door)(target, image("a refused prompt"), callIn("conv-image-failed")));
    browser.answer("a refused prompt", words("ChatGPT refused on a usage limit.", true));
    expect(await ended("conv-image-failed", id)).toMatchObject({ exitCode: 1, outputTail: "ChatGPT refused on a usage limit.\n" });
});

test("images queue per browser: one at a time until one is made, then two at once, one chat's one after another", async () => {
    const browser = slowBrowser();
    const door = backgrounded(browser.door);
    const first = jobIdOf(await door(target, image("one"), callIn("conv-image-queue")));
    const second = await door(target, image("two"), callIn("conv-image-queue"));
    expect(textOf(second)).toContain("once the 1 image ahead of it there are done");
    expect(browser.calls.map((each) => each.prompt)).toEqual(["one"]);
    browser.answer("one", words("Made 1 image"));
    await ended("conv-image-queue", first);
    // Made once, so two run at once now: the queued one and the next.
    await door(target, image("three", "chat-a"), callIn("conv-image-queue"));
    expect(browser.calls.map((each) => each.prompt)).toEqual(["one", "two", "three"]);
    browser.answer("two", words("Made 1 image"));
    await door(target, image("four", "https://chatgpt.com/g/p/c/chat-a"), callIn("conv-image-queue"));
    // Same chat as "three", given as its address: it waits for "three" though a place is free.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(browser.calls.map((each) => each.prompt)).toEqual(["one", "two", "three"]);
    browser.answer("three", words("Made 1 image"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(browser.calls.map((each) => each.prompt)).toEqual(["one", "two", "three", "four"]);
    browser.answer("four", words("Made 1 image"));
});

test("the call the job makes is not bound to the client's ceiling, nor ended by the agent's request", async () => {
    const browser = slowBrowser();
    const asked = callIn("conv-image-ceiling", 60_000);
    const id = jobIdOf(await backgrounded(browser.door)(target, image("a heron"), asked));
    expect(browser.calls[0]?.call).not.toHaveProperty("clientCeilingMs");
    expect(browser.calls[0]?.call.signal).not.toBe(asked.signal);
    browser.answer("a heron", words("Made 1 image"));
    await ended("conv-image-ceiling", id);
});

test("with no conversation to wake, the call waits in the call and the listing keeps the browser's words", async () => {
    const browser = slowBrowser();
    const door = backgrounded(browser.door);
    const waiting = door(target, image("a crane"), callIn(undefined));
    await new Promise((resolve) => setTimeout(resolve, 40));
    browser.answer("a crane", words("Made 1 image"));
    expect(textOf(await waiting)).toBe("Made 1 image");
    const listed = listingOf(await door(target, { jsonrpc: "2.0", id: 2, method: "tools/list" }, callIn(undefined)));
    expect(listed[0]?.description).toBe("one call, up to 9 minutes");
});

test("a conversation's listing describes chatgpt_image as a job, and leaves every other tool as the browser said", async () => {
    const listed = listingOf(await backgrounded(slowBrowser().door)(target, { jsonrpc: "2.0", id: 3, method: "tools/list" }, callIn("conv-image-list")));
    expect(listed).toEqual([
        { name: CHATGPT_IMAGE_TOOL, description: IMAGE_JOB_DESCRIPTION },
        { name: "snapshot", description: "the page" },
    ]);
});

test("a transport failure reads as the job's failure, in its own words", () => {
    expect(imageJobEnd({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: `"chrome" is not connected right now` } })).toEqual({
        ok: false,
        output: `"chrome" is not connected right now`,
    });
    expect(imageJobEnd(undefined)).toEqual({ ok: false, output: "The browser gave no answer to read." });
});
