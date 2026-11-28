import { RESERVED_MCP_SERVER_NAMES } from "@intentic/sandbox-contract/policy/reserved-servers";
import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import type { AgentTool } from "../../agent/tools/agent-tools.js";
import type { InProcessServer, TurnLease } from "../../agent/tools/turn-mounts.js";
import type { ChildSupervisor } from "../../agent/subagents/children.js";
import type { ServerTool } from "../../agent/subagents/waiting/subagent-wait.js";
import { toolAnnotations } from "@intentic/sandbox-contract/peer-mcp-server";
import { sdk } from "../../engines/claude-sdk.js";
import { opt } from "../../opt.js";
import type { S2sCallInput, S2sCallMethod } from "@intentic/sandbox-contract/schemas/s2s";
import type { CallContact, CallResult } from "../calls/call-client.js";
import { contactCallTools } from "../calls/call-tools.js";
import { contactTaskTools } from "../tasks/task-tools.js";
import type { ContactRow } from "./contacts-store.js";

/* EACH CONTACT AS A TURN SEES IT (2026-11-27, docs/architecture/messages.md "Calls", last bullet): one tool server per
 * accepted contact this turn may use, named after it (`mcp__<contact>__…`, sanitised as a card's id), mounted on the
 * turn's lease beside the linked sandboxes' (links/link-mounts.ts). What the server carries is composed from tool groups,
 * each adding the tools the contact gives this sandbox the grant for; a contact for which no group adds anything is not
 * mounted at all.
 *
 * THE EXTENSION POINT is CONTACT_TOOL_GROUPS: a `ContactToolGroup` takes the contact and the turn and answers its tools.
 * Tasks (`delegate`, s2s/tasks/task-tools.ts) are the first; the calls (the records tools, and where granted
 * `run_command`, `read_file` and `write_file`, s2s/calls/call-tools.ts) the second, reaching the contact by `call`. A
 * mounted contact's server also carries `about` (below), what the contact said it allows, read off its row.
 *
 * A contact names itself, so its server's name is never one the daemon or the owner already uses: never a daemon server's
 * (RESERVED_MCP_SERVER_NAMES, the control ones whose answers go unwrapped among them), never a card's id, never another
 * server the turn mounts, never another contact's. A name taken goes to the next free `-2`, `-3`… in the contacts' order,
 * so the same contacts always get the same names; and every answer a contact's server gives is outside content
 * (guard/outside-results.ts wraps every server but the daemon's control ones). */

// One contact as its tools see it: its row, the server name its tools go by, and a call to it over its session.
export interface MountedContact {
    readonly row: ContactRow;
    readonly server: string;
    readonly name: string;
    readonly call: <M extends S2sCallMethod>(method: M, input: S2sCallInput<M>, signal?: AbortSignal) => Promise<CallResult<M>>;
}

// The turn a contact's server is mounted for: its conversation, and its supervisor while it may hand work on (armed at
// planning, agent/subagents/children.ts); a turn started by outside content, or whose role does not delegate, has none.
export interface ContactTurn {
    readonly conversationId: string | undefined;
    readonly supervisor: () => ChildSupervisor | undefined;
}

// One group of a contact's tools: none when the contact gives this sandbox nothing the group needs.
export type ContactToolGroup = (contact: MountedContact, turn: ContactTurn) => readonly ServerTool[];

/** Every group a contact's server is composed from, in the order its tools are listed. */
export const CONTACT_TOOL_GROUPS: readonly ContactToolGroup[] = [contactTaskTools, contactCallTools];

// What the layer above fills in: the turn engine's half (its supervisors, and the door an in-process server is served
// through), so this module stands below it (_sandbox/sandbox/layers.json).
export interface ContactMountDeps {
    // The accepted contacts a conversation may use (s2s/tasks/asking.ts, the askers' rule), read as the turn is planned.
    readonly usable: (conversationId: string) => Promise<readonly ContactRow[]>;
    // The supervisor a conversation's turn armed, while it may hand work on (agent/subagents/children.ts supervisorFor).
    readonly supervisorOf: (conversationId: string) => ChildSupervisor | undefined;
    // An in-process server as the turn's lease serves one (runtimes/daemon-tools/sdk-door.ts sdkServerDoor).
    readonly door: (server: ReturnType<ReturnType<typeof sdk>["createSdkMcpServer"]>) => InProcessServer;
    // A call to a contact over its session (s2s/calls/call-client.ts).
    readonly call: CallContact;
}

/** The name a contact goes by for an agent: its tool server's name, and what `delegate`'s `to` may say. */
export const contactServerName = (row: Pick<ContactRow, "id" | "name" | "document">): string => {
    const cleaned = (row.name ?? row.document.name)
        .toLowerCase()
        .replaceAll(/[^a-z0-9_-]+/gu, "-")
        .replaceAll(/-+/gu, "-")
        .replace(/^[^a-z0-9]+/u, "")
        .replace(/-+$/u, "")
        .slice(0, 60);
    return cleaned === "" ? `contact-${row.id.slice(0, 8).toLowerCase()}` : cleaned;
};

// How many suffixes a contact's name tries before it is left unmounted: past this many namesakes, a name says nothing.
const SUFFIXES_MAX = 20;

/**
 * Each contact its server name, never a daemon server's, nor one a granted card or any other server the turn mounts
 * already holds, nor another contact's: the first free of its name, `-2`, `-3`… in the contacts' order.
 */
export const contactServerNames = (rows: readonly ContactRow[], taken: ReadonlySet<string>): ReadonlyMap<string, string> => {
    const used = new Set([...RESERVED_MCP_SERVER_NAMES, ...taken]);
    const names = new Map<string, string>();
    for (const row of rows) {
        const base = contactServerName(row);
        const server = [base, ...Array.from({ length: SUFFIXES_MAX - 1 }, (_, at) => `${base}-${at + 2}`)].find((candidate) => !used.has(candidate));
        if (server !== undefined) {
            used.add(server);
            names.set(row.id, server);
        }
    }
    return names;
};

const named = (rows: readonly ContactRow[], taken: ReadonlySet<string>, call: CallContact): MountedContact[] => {
    const names = contactServerNames(rows, taken);
    return rows.flatMap((row) => {
        const server = names.get(row.id);
        return server === undefined ? [] : [{ row, server, name: row.name ?? row.document.name, call: (method, input, signal) => call(row, method, input, signal) }];
    });
};

// `about`, on every mounted contact's server: what the contact said it allows this sandbox (its grants as it sent them,
// informational: what it actually allows is decided over there), its address, its key's fingerprint, when last heard from.
const aboutTool = (contact: MountedContact) => {
    const { name, row } = contact;
    const theirs = row.theirGrants;
    return sdk().tool(
        "about",
        `What the contact "${name}" said it allows this sandbox (messages, reports, tasks with the role they wear there, ` +
            "whether each waits for its owner and how many turns an hour, records, operating), its address, its key's " +
            "fingerprint, and when it was last heard from. Read off this sandbox's own record: nothing is sent.",
        {},
        async () => ({
            content: [
                {
                    type: "text" as const,
                    text: JSON.stringify({
                        ok: true,
                        to: contact.server,
                        contact: name,
                        address: row.address,
                        fingerprint: row.document.fingerprint,
                        scope: row.scope.kind === "person" ? row.scope.person : "sandbox",
                        allows: {
                            message: theirs?.message ?? false,
                            report: theirs?.report ?? false,
                            ...opt(
                                "task",
                                theirs?.task === undefined
                                    ? undefined
                                    : { ...opt("role", theirs.task.actsAs), approve: theirs.task.approve, turnsPerHour: theirs.task.turnsPerHour },
                            ),
                            records: theirs?.records ?? false,
                            operate: theirs?.operate ?? false,
                        },
                        ...opt("lastSeenAt", row.lastSeenAt === undefined ? undefined : new Date(row.lastSeenAt).toISOString()),
                    }),
                },
            ],
        }),
        { annotations: toolAnnotations("read") },
    );
};

/**
 * The turn's contacts, one server each on its lease, each carrying what its groups add; none for a turn with no
 * conversation. `taken` is every other server name the turn mounts, which no contact's may take.
 */
export const contactMountsOf = async (
    deps: ContactMountDeps,
    granted: readonly Capability[],
    lease: Pick<TurnLease, "open">,
    conversationId: string | undefined,
    taken: ReadonlySet<string> = new Set(),
    groups: readonly ContactToolGroup[] = CONTACT_TOOL_GROUPS,
): Promise<AgentTool[]> => {
    if (conversationId === undefined) {
        return [];
    }
    const turn: ContactTurn = { conversationId, supervisor: () => deps.supervisorOf(conversationId) };
    const names = new Set([...taken, ...granted.map((capability) => capability.id)]);
    return named(await deps.usable(conversationId), names, deps.call).flatMap((contact) => {
        const tools = groups.flatMap((group) => group(contact, turn));
        return tools.length === 0
            ? []
            : [
                  lease.open({
                      name: contact.server,
                      target: { kind: "daemon", server: deps.door(sdk().createSdkMcpServer({ name: contact.server, tools: [...tools, aboutTool(contact)] })) },
                  }),
              ];
    });
};
