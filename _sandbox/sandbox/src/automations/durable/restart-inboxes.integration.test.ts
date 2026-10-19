import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTurn } from "@intentic/sandbox-contract/schemas/agent";
import { type ListenerMessage, ListenerMessageSchema } from "@intentic/sandbox-contract/protocol/doors/listener-protocol";
import type { WorkspaceEvent } from "@intentic/sandbox-contract/schemas/automations";
import { SETTLES, waitFor } from "@intentic/testing/bun";
import { z } from "zod";
import { automationConfig } from "../../harness/route-stores.testing.js";
import { WEBCHAT_PROVIDER } from "../../webchat/webchat-config.js";
import { listenerInboxDocument, workspaceInboxDocument } from "./inbox-store.js";
import { dispatchListenerMessage } from "../listeners.js";
import { answeringWake, bootAutomations, daemonOn, hangingWake } from "./restart.testing.js";
import { automationIdle } from "../scheduler.js";
import { dispatchWorkspaceEvent } from "../workspace-events.js";

// Restart durability of what waits before a fire is admitted (inbox-store.ts): a channel message in its debounce or
// behind a running fire, a workspace event in its chore's queue. Each test leaves a daemon dead with work waiting, then
// boots a second one on the same history with nothing of the first in memory.

// The inbox rows on disk, read through their own document's schema; no file yet is an empty inbox.
const rowsOf = <S extends z.ZodType>(root: string, document: { readonly path: string; readonly schema: S }): z.output<S>[] => {
    const file = join(root, "history", document.path);
    return z.array(document.schema).parse(existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : []);
};
const waitingMessages = (root: string): string[] => rowsOf(root, listenerInboxDocument).map((row) => ListenerMessageSchema.parse(JSON.parse(row.line)).id);
const waitingEvents = (root: string): string[] => rowsOf(root, workspaceInboxDocument).map((row) => row.event.agentId);

const said = (id: string, channelId: string, content: string): ListenerMessage => ({
    provider: WEBCHAT_PROVIDER,
    type: "message",
    id,
    channelId,
    author: { id: "u1", name: "alice" },
    content,
    timestamp: "2026-10-19T00:00:00.000Z",
});

const WORDS = ["first", "second", "third"];
const wordOf = (prompt: string): string => WORDS.find((word) => prompt.includes(`"content":"${word}"`)) ?? "";

test("channel messages waiting behind a running fire or in their debounce are answered once each after a restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "restart-inbox-"));
    const cut: AgentTurn[] = [];
    const before = daemonOn(root, hangingWake(cut));
    await before.services.automations.upsert(automationConfig("desk", { trigger: { kind: "listener", provider: WEBCHAT_PROVIDER } }));
    await dispatchListenerMessage(before.services, said("m1", "c1", "first"), 5);
    await waitFor(() => expect(cut).toHaveLength(1), SETTLES);
    // The turn running on c1 does not take it, so it waits for a fire of its own; c2's sits in a long debounce.
    await dispatchListenerMessage(before.services, said("m2", "c1", "second"), 5);
    await dispatchListenerMessage(before.services, said("m3", "c2", "third"), 60_000);
    // Answered {ok:true} already: what the senders were told is only true because these are on disk.
    expect(waitingMessages(root)).toEqual(["m2", "m3"]);
    before.crash();

    const ran: AgentTurn[] = [];
    const after = daemonOn(root, answeringWake(ran, (prompt) => `answer:${wordOf(prompt)}`));
    await bootAutomations(after.services);
    await waitFor(() => expect(ran).toHaveLength(3), SETTLES);
    await automationIdle("desk", after.services);

    // The cut fire comes back first, on its own conversation; the waiting message continues that thread's conversation.
    expect(ran.map((turn) => wordOf(turn.prompt))).toEqual(["first", "second", "third"]);
    expect(ran[0]?.conversationId).toBe(cut[0]?.conversationId);
    expect(ran[1]?.conversationId).toBe(cut[0]?.conversationId);
    const replies = async (channelId: string): Promise<string[]> =>
        (await after.services.webchatOutbox.since(`webchat:desk:${channelId}`, 0, Date.now())).replies.map((reply) => reply.text);
    expect(await replies("c1")).toEqual(["answer:first", "answer:second"]);
    expect(await replies("c2")).toEqual(["answer:third"]);
    expect(waitingMessages(root)).toEqual([]);
    expect(await after.services.turnJournal.list()).toEqual([]);
});

const settled = (agentId: string): WorkspaceEvent => ({
    event: "turn.settled",
    agentId,
    branch: `agent/${agentId}`,
    outcome: "landed",
    repos: [{ repo: "root", from: "abc123", dir: `/history/worktrees/${agentId}` }],
});

test("workspace events waiting on a busy chore run once each, in order, after a restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "restart-inbox-"));
    const cut: AgentTurn[] = [];
    const before = daemonOn(root, hangingWake(cut));
    await before.services.automations.upsert(automationConfig("review", { trigger: { kind: "workspace", event: "turn.settled" } }));
    await dispatchWorkspaceEvent(before.services, settled("agent-1"));
    await waitFor(() => expect(cut).toHaveLength(1), SETTLES);
    await dispatchWorkspaceEvent(before.services, settled("agent-2"));
    await dispatchWorkspaceEvent(before.services, settled("agent-3"));
    expect(waitingEvents(root)).toEqual(["agent-2", "agent-3"]);
    before.crash();

    const ran: AgentTurn[] = [];
    const after = daemonOn(root, answeringWake(ran, () => "reviewed"));
    await bootAutomations(after.services);
    await waitFor(() => expect(ran).toHaveLength(3), SETTLES);
    await automationIdle("review", after.services);

    const agentOf = (prompt: string): string => /"agentId":"([^"]+)"/.exec(prompt)?.[1] ?? "";
    expect(ran.map((turn) => agentOf(turn.prompt))).toEqual(["agent-1", "agent-2", "agent-3"]);
    expect(waitingEvents(root)).toEqual([]);
    expect(await after.services.turnJournal.list()).toEqual([]);
});
