import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LINK_TOKEN_PREFIX } from "@intentic/sandbox-contract";
import { fileInboundLinks, inboundLinksDocument } from "../inbound-links.js";

// The inbound-link store is the whole of a link's credential and reach: a hashed token, the terms the owner wrote on it,
// and the conversations it opened, which are the only ones its doors answer for.

const store = () => {
    const path = join(mkdtempSync(join(tmpdir(), "links-")), inboundLinksDocument.path);
    return { links: fileInboundLinks(path), path };
};

const task = (requestId: string, held = false) => ({
    requestId,
    conversationId: `link-${requestId}`,
    title: `do ${requestId}`,
    task: `the whole of ${requestId}`,
    hops: 0,
    held,
});

test("a minted token is shown once and kept only as its hash, and resolves to the link with its terms", async () => {
    const { links, path } = store();
    const minted = await links.mint("dev", { terms: { approve: true }, createdBy: "owner@example.com" });
    expect(minted.token.startsWith(LINK_TOKEN_PREFIX)).toBe(true);
    expect(readFileSync(path, "utf8")).not.toContain(minted.token);
    expect(await links.resolve(minted.token)).toEqual({ id: minted.id, label: "dev", terms: { approve: true, turnsPerHour: 20 } });
    expect(await links.resolve(`${LINK_TOKEN_PREFIX}nope`)).toBeUndefined();
    // A control token, or anything else, is never read as a link.
    expect(await links.resolve("ict_whatever")).toBeUndefined();
});

test("terms change field by field, an undefined field keeps what is there, and a revoked link resolves to nothing", async () => {
    const { links } = store();
    const minted = await links.mint("dev", { terms: { actsAs: "ops", turnsPerHour: 5 } });
    const changed = await links.update(minted.id, { approve: true, turnsPerHour: undefined, label: "dev box" });
    expect(changed?.terms).toEqual({ actsAs: "ops", approve: true, turnsPerHour: 5 });
    expect(changed?.label).toBe("dev box");
    expect(await links.update("lnk-none", { approve: true })).toBeUndefined();
    expect(await links.revoke(minted.id)).toBe(true);
    expect(await links.resolve(minted.token)).toBeUndefined();
    expect(await links.revoke(minted.id)).toBe(false);
});

test("a task asked twice under one id is filed once, and a link finds only the tasks it opened", async () => {
    const { links } = store();
    const one = await links.mint("one", {});
    const two = await links.mint("two", {});
    const first = await links.addTask(one.id, task("r1"));
    const again = await links.addTask(one.id, { ...task("r1"), conversationId: "link-other" });
    expect(again?.conversationId).toBe(first?.conversationId);
    expect(await links.task(one.id, { conversationId: "link-r1" })).toMatchObject({ requestId: "r1", state: "running" });
    // The other link's doors answer for none of this one's conversations.
    expect(await links.task(two.id, { conversationId: "link-r1" })).toBeUndefined();
    expect(await links.linkOf("link-r1")).toMatchObject({ linkId: one.id });
});

test("a held task keeps its words for the owner's yes and lists them; a start forgets them; a move bumps the version", async () => {
    const { links } = store();
    const minted = await links.mint("dev", {});
    await links.addTask(minted.id, task("r1", true));
    const listed = (await links.list())[0];
    expect(listed?.requests).toEqual([expect.objectContaining({ id: "r1", task: "the whole of r1", title: "do r1" })]);
    expect(listed?.conversations).toBe(0);
    const started = await links.moveTask(minted.id, "link-r1", { state: "running", forgetTask: true });
    expect(started).toMatchObject({ state: "running", version: 2 });
    expect(started?.task).toBeUndefined();
    const finished = await links.moveTask(minted.id, "link-r1", { state: "finished", report: "done: x" });
    expect(finished).toMatchObject({ state: "finished", report: "done: x", version: 3 });
    // A move naming no report keeps the last one; a move naming no error clears the last error.
    const failed = await links.moveTask(minted.id, "link-r1", { state: "failed", error: "boom" });
    expect(failed).toMatchObject({ report: "done: x", error: "boom" });
    expect((await links.moveTask(minted.id, "link-r1", { state: "running" }))?.error).toBeUndefined();
    expect((await links.list())[0]?.conversations).toBe(1);
});
