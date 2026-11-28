import { keySetFor } from "@intentic/sandbox-contract/protocol/s2s/s2s.testing";
import { signIdentity } from "@intentic/sandbox-contract/s2s";
import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import { S2sGrantsSchema, type S2sContactScope, type S2sGrants,type S2sCallMethod } from "@intentic/sandbox-contract/schemas/s2s";
import { unstubbed } from "@intentic/testing";
import { z } from "zod";
import { armSupervisor, type ChildSupervisor, supervisorFor } from "../../agent/subagents/children.js";
import { sdkServerDoor } from "../../runtimes/daemon-tools/sdk-door.js";
import type { AgentTool } from "../../agent/tools/agent-tools.js";
import type { InProcessServer, MountSpec } from "../../agent/tools/turn-mounts.js";
import { memoryFleet } from "../../conversations/registry/agents-registry.testing.js";
import type { DelegateAsk } from "../../links/linked-children.js";
import { sdk } from "../../engines/claude-sdk.js";
import type { CallContact, CallResult } from "../calls/call-client.js";
import { outsideSourceOf } from "../../guard/outside-results.js";
import { CONTACT_TOOL_GROUPS, contactMountsOf, contactServerNames, type ContactToolGroup } from "./contact-mounts.js";
import type { ContactRow } from "./contacts-store.js";

// A contact reaches a turn the way a linked sandbox does: one tool server named after it (sanitised as a card's id), on
// the turn's lease, composed from the tool groups. The task group mounts for a contact that gives this sandbox tasks;
// handing it work is spawning's sibling, so a turn no supervisor was armed for is refused, and an armed one hands the
// task to that very contact.

const TASKS: S2sGrants = S2sGrantsSchema.parse({ task: { approve: true, turnsPerHour: 5, actsAs: "oncall" } });
const MESSAGES_ONLY: S2sGrants = S2sGrantsSchema.parse({});

const row = (id: string, name: string, theirGrants: S2sGrants, scope: S2sContactScope = { kind: "sandbox" }): ContactRow => ({
    id,
    address: `${id}.example`,
    document: signIdentity({ sandbox: id, name, host: `${id}.example`, domains: [], issuedAt: 1 }, keySetFor(id)),
    scope,
    state: "accepted",
    grants: MESSAGES_ONLY,
    theirGrants,
    notices: [],
    origin: "paired",
    createdAt: 1,
    updatedAt: 1,
});

// A call no test here expects to make: one made names itself.
const noCalls: CallContact = async (_row, method) => {
    throw new Error(`no call expected here, but ${method} was made`);
};

const AnswerSchema = z.object({
    result: z.object({ content: z.array(z.object({ text: z.string() })).optional(), tools: z.array(z.object({ name: z.string() })).optional() }).optional(),
});

// The servers a turn's lease was handed, by name, without a door: each is called as the door would call it.
const mounted = async (
    rows: readonly ContactRow[],
    options: {
        readonly granted?: readonly Capability[];
        readonly conversations?: ReturnType<typeof memoryFleet>["conversations"];
        readonly groups?: readonly ContactToolGroup[];
        readonly call?: CallContact;
        readonly taken?: ReadonlySet<string>;
    } = {},
) => {
    const opened: MountSpec[] = [];
    const lease = {
        open: (spec: MountSpec): AgentTool => {
            opened.push(spec);
            return unstubbed<AgentTool>("tool", { name: spec.name });
        },
    };
    const conversations = options.conversations ?? memoryFleet().conversations;
    const deps = { usable: async () => rows, supervisorOf: (id: string) => supervisorFor(conversations, id), door: sdkServerDoor, call: options.call ?? noCalls };
    await contactMountsOf(deps, options.granted ?? [], lease, "conv-a", options.taken, options.groups);
    return opened;
};

const serverOf = (spec: MountSpec | undefined): InProcessServer => {
    if (spec?.target.kind !== "daemon") {
        throw new Error("a contact is mounted as a daemon server");
    }
    return spec.target.server;
};

let next = 0;
const call = async (server: InProcessServer, method: string, params: Record<string, unknown> = {}) => {
    next += 1;
    return AnswerSchema.parse(await server.handle({ jsonrpc: "2.0", id: next, method, params }));
};
const started = async (server: InProcessServer) => {
    await call(server, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    return server;
};
const textOf = (answer: z.infer<typeof AnswerSchema>): string => (answer.result?.content ?? []).map((part) => part.text).join("");

test("each contact that gives tasks is a server named after it; one that gives none, and a name a card holds, are left alone", async () => {
    const card: Capability = { id: "ops-box", kind: "link", config: { url: "https://ops.sbx.test", token: "ilk_x", name: "Ops" } };
    const opened = await mounted([row("c1", "Ops Box!", TASKS), row("c2", "Quiet one", MESSAGES_ONLY), row("c3", "ops box", TASKS), row("c4", "Acme Ops", TASKS)], { granted: [card] });
    // `ops-box` is the card's; the two contacts that would take it go by their next free names.
    expect(opened.map((spec) => spec.name)).toEqual(["ops-box-2", "ops-box-3", "acme-ops"]);
    const server = await started(serverOf(opened[0]));
    expect((await call(server, "tools/list")).result?.tools?.map((tool) => tool.name).toSorted()).toEqual(["about", "delegate"]);
    expect(JSON.parse(textOf(await call(server, "tools/call", { name: "about", arguments: {} })))).toEqual({
        ok: true,
        to: "ops-box-2",
        contact: "Ops Box!",
        address: "c1.example",
        fingerprint: expect.stringMatching(/^isk1:/u),
        scope: "sandbox",
        allows: { message: true, report: false, task: { role: "oncall", approve: true, turnsPerHour: 5 }, records: false, operate: false },
    });
    server.close();
});

test("a second group adds its tools to the same server, and a contact no group serves is not mounted", async () => {
    // A stand-in for a later group: one tool, for a contact that takes reports.
    const reports: ContactToolGroup = (contact) =>
        contact.row.theirGrants?.report === true ? [sdk().tool("report", "Report a problem.", {}, async () => ({ content: [{ type: "text", text: "{}" }] }))] : [];
    const both = S2sGrantsSchema.parse({ task: {}, report: true });
    const reportsOnly = S2sGrantsSchema.parse({ report: true });
    const opened = await mounted([row("c1", "Both", both), row("c2", "Reports", reportsOnly), row("c3", "Quiet", MESSAGES_ONLY)], { groups: [...CONTACT_TOOL_GROUPS, reports] });
    expect(opened.map((spec) => spec.name)).toEqual(["both", "reports"]);
    const toolsOf = async (spec: MountSpec | undefined) => {
        const server = await started(serverOf(spec));
        const names = (await call(server, "tools/list")).result?.tools?.map((tool) => tool.name).toSorted();
        server.close();
        return names;
    };
    expect(await toolsOf(opened[0])).toEqual(["about", "delegate", "report"]);
    // Every mounted contact's server answers `about` too, whatever group put it there.
    expect(await toolsOf(opened[1])).toEqual(["about", "report"]);
});

// The servers' tool names, by server, for these contacts.
const toolNames = async (rows: readonly ContactRow[], options: Parameters<typeof mounted>[1] = {}) => {
    const names: Record<string, string[] | undefined> = {};
    for (const spec of await mounted(rows, options)) {
        const server = await started(serverOf(spec));
        names[spec.name] = (await call(server, "tools/list")).result?.tools?.map((tool) => tool.name).toSorted();
        server.close();
    }
    return names;
};

test("the calls group adds the records tools where a contact shares its records, and operating only for a sandbox's own contact", async () => {
    const reads = S2sGrantsSchema.parse({ records: true });
    const operates = S2sGrantsSchema.parse({ task: {}, records: true, operate: true });
    expect(
        await toolNames([row("c1", "Reads", reads), row("c2", "Ops", operates), row("c3", "Ada ops", operates, { kind: "person", person: "ada@acme.test" })]),
    ).toEqual({
        reads: ["about", "conversation", "conversations", "diagnostics"],
        ops: ["about", "conversation", "conversations", "delegate", "diagnostics", "read_file", "run_command", "write_file"],
        // A person's route never operates, whatever it says it allows.
        "ada-ops": ["about", "conversation", "conversations", "delegate", "diagnostics"],
    });
});

test("the call tools reach the contact by call, and operating is refused to a turn that may not hand work on", async () => {
    const asked: { readonly contact: string; readonly method: string; readonly input: unknown }[] = [];
    const answers: CallContact = async (contact, method, input) => {
        asked.push({ contact: contact.id, method, input });
        const answer: CallResult<S2sCallMethod> =
            method === "records.diagnostics"
                ? { ok: true, value: { text: "3 restarts", sandbox: "Ops" } }
                : { ok: false, status: 404, message: "no such conversation", body: { ok: false, message: "No conversation answers to `nobody`." } };
        // SAFETY: the one method answered by value is records.diagnostics, and that is its output's shape.
        return answer as CallResult<typeof method>;
    };
    const { conversations } = memoryFleet();
    const opened = await mounted([row("c1", "Ops", S2sGrantsSchema.parse({ records: true, operate: true }))], { conversations, call: answers });
    const server = await started(serverOf(opened[0]));
    expect(textOf(await call(server, "tools/call", { name: "diagnostics", arguments: { ask: { query: "restarts" } } }))).toBe("3 restarts");
    // The far side's own refusal comes back as it worded it, as a link's records doors' does.
    expect(JSON.parse(textOf(await call(server, "tools/call", { name: "conversation", arguments: { handle: "nobody", transcript: true } })))).toEqual({
        ok: false,
        message: "No conversation answers to `nobody`.",
    });
    expect(asked).toEqual([
        { contact: "c1", method: "records.diagnostics", input: { query: "restarts" } },
        { contact: "c1", method: "records.show", input: { handle: "nobody", query: { transcript: "1" } } },
    ]);
    const refused = JSON.parse(textOf(await call(server, "tools/call", { name: "run_command", arguments: { command: "git status" } })));
    expect(refused).toMatchObject({ ok: false, message: expect.stringContaining("may not operate another sandbox") });
    expect(asked).toHaveLength(2);
    server.close();
});

test("a turn no supervisor was armed for may not hand work on; an armed one hands it to that contact, by its id", async () => {
    const { conversations } = memoryFleet();
    const contacts = [row("c1", "Ops", TASKS, { kind: "person", person: "ada@acme.test" })];
    const refused = await started(serverOf((await mounted(contacts, { conversations }))[0]));
    const no = JSON.parse(textOf(await call(refused, "tools/call", { name: "delegate", arguments: { task: "Count incidents." } })));
    expect(no).toMatchObject({ ok: false, message: expect.stringContaining("may not hand work on") });

    const asked: DelegateAsk[] = [];
    armSupervisor(
        conversations,
        "conv-a",
        unstubbed<ChildSupervisor>("supervisor", {
            delegate: async (ask) => {
                asked.push(ask);
                return { ok: true, id: "linked-brave-otter-1", note: "Handed over." };
            },
        }),
    );
    const server = await started(serverOf((await mounted(contacts, { conversations }))[0]));
    const yes = JSON.parse(textOf(await call(server, "tools/call", { name: "delegate", arguments: { task: "Count incidents.", description: "incidents" } })));
    expect(yes).toEqual({ ok: true, child: "linked-brave-otter-1", note: "Handed over." });
    expect(asked).toEqual([{ to: "c1", via: "contact", task: "Count incidents.", description: "incidents" }]);
    refused.close();
    server.close();
});

test("a contact never takes a daemon server's name, another server's the turn mounts, or another contact's", async () => {
    const contacts = [row("c1", "subagents", TASKS), row("c2", "Watch", TASKS), row("c3", "web", TASKS), row("c4", "GitHub", TASKS), row("c5", "github", TASKS), row("c6", "devices", TASKS)];
    const opened = await mounted(contacts, { taken: new Set(["github"]) });
    expect(opened.map((spec) => spec.name)).toEqual(["subagents-2", "watch-2", "web-2", "github-2", "github-3", "devices-2"]);
    // The same contacts name the same servers on every turn.
    expect(contactServerNames(contacts, new Set(["github"]))).toEqual(
        new Map([
            ["c1", "subagents-2"],
            ["c2", "watch-2"],
            ["c3", "web-2"],
            ["c4", "github-2"],
            ["c5", "github-3"],
            ["c6", "devices-2"],
        ]),
    );
    // And what any of them answers is outside content, never a control server's own: the daemon's `subagents` is not wrapped.
    expect([outsideSourceOf("mcp__subagents-2__about", {}), outsideSourceOf("mcp__watch-2__delegate", {}), outsideSourceOf("mcp__subagents__wait", {})]).toEqual([
        "subagents-2",
        "watch-2",
        undefined,
    ]);
});
