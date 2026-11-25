import { parseJsonWith } from "@intentic/base/json";
import { type DeviceFeature, deviceSupports } from "@intentic/sandbox-contract/schemas/hosts";
import { ORPCError } from "@orpc/server";
import type { z } from "zod";
import type { Services } from "../../composition.js";
import { callFailure } from "../../peers/call-failure.js";
import { callTool } from "../device-reports.js";
import type { HostClient } from "../host-peer.js";

// ONE OF THE MACHINE'S OWN TOOLS, CALLED FOR A ROUTE (stacks/device-stacks.ts, ci-fleet/device-ci-fleet.ts): the
// computer must be connected and its agent must advertise what the call needs, the answer is its text, a refusal is
// passed on in the machine's own words, and a call that got no answer says what that means for the call. Each route
// module states its own needs and deadlines; this is only the way every one of them reaches the machine.

export type RelayServices = Pick<Services, "hostHub">;

/** What one part of a feature needs of the computer's agent, and how a refusal says what it could not do. */
export interface DeviceNeed {
    readonly feature: DeviceFeature;
    readonly to: string;
}

/** The computer's client, once it is connected and its agent has every tool the call needs. An older agent would
 *  answer an unknown tool with an error the reader cannot act on, so it is refused here, saying how to update it. */
export const deviceClientFor = (services: RelayServices, id: string, needs: readonly DeviceNeed[]): HostClient => {
    const client = services.hostHub.client(id);
    if (client === undefined || !services.hostHub.online(id)) {
        throw new ORPCError("CONFLICT", { message: services.hostHub.offline(id) });
    }
    const facts = services.hostHub.state(id).facts;
    const missing = needs.find((need) => !deviceSupports(facts, need.feature));
    if (missing !== undefined) {
        throw new ORPCError("CONFLICT", {
            message: `The agent on "${id}" is too old to ${missing.to}: update it there (\`intentic-machine upgrade\`, or Update on its Devices card), then try again.`,
        });
    }
    return client;
};

/** What a relayed tool takes: names, ops, counts, paths, and lists of names (a new runner's labels). (2026-11-25) And a
 *  managed deploy's nested parts (registry logins, hooks, health, image pins: stacks/device-stacks.ts), so JSON as the MCP
 *  call carries it; an absent field is left out of the call. */
export type ToolArg = string | number | boolean | readonly ToolArg[] | { readonly [key: string]: ToolArg | undefined };
export type ToolArgs = Readonly<Record<string, ToolArg | undefined>>;

/** One of the machine's tools, its answer as text. A refusal (a switch that is off) is FORBIDDEN in the machine's own
 *  words; a call that got no answer is BAD_GATEWAY, said as what it means for the call (it may have run). */
export const relayTool = async (services: RelayServices, id: string, tool: string, args: ToolArgs, deadlineMs: number): Promise<string> => {
    const answer = await callTool(services, id, tool, args, AbortSignal.timeout(deadlineMs)).catch((error: Error) => {
        throw new ORPCError("BAD_GATEWAY", { message: callFailure("device", id, tool, error, deadlineMs).text });
    });
    if (answer.refused) {
        throw new ORPCError("FORBIDDEN", { message: answer.text.trim() === "" ? `"${id}" refused ${tool} without saying why.` : answer.text });
    }
    return answer.text;
};

// How much of an answer that is not what the tool promised is quoted back: enough to recognise it, never a whole log.
const QUOTED_CHARS = 300;

/** A tool's JSON answer, read against what it promises; anything else is the computer's fault, named by what came back. */
export const parsedToolAnswer = <T>(id: string, tool: string, text: string, schema: z.ZodType<T>): T => {
    const value = parseJsonWith(text, schema);
    if (value === undefined) {
        const quoted = text.trim() === "" ? "nothing" : JSON.stringify(text.length > QUOTED_CHARS ? `${text.slice(0, QUOTED_CHARS)}…` : text);
        throw new ORPCError("BAD_GATEWAY", { message: `"${id}" answered ${tool} with something other than what it promises: ${quoted}` });
    }
    return value;
};
