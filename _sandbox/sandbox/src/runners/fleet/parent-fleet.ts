import { errorMessage } from "@intentic/base/errors";
import {
    RUNNER_FLEET_CONVERSATION_HEADER,
    RUNNER_FLEET_DOOR_HEADER,
    RunnerFleetNotPlacedSchema,
    runnerFleetUrl,
} from "@intentic/sandbox-contract/protocol/doors/runner-protocol";
import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../app-env.js";
import type { Services } from "../../composition.js";
import { provesOwner } from "../../seams/workload-stamp.js";
import type { RunnerIdentity } from "../runner-identity.js";

/* A RUNNER'S TURN READS THE FLEET AT ITS PARENT (2026-11-22). Its `agents ls|find|show|bundle` reach this daemon, which
   holds only the turns this runner ran: asked here, a session on a runner could not see what any other conversation did,
   nor this one's own turns that ran at the parent, and could not help with the rest of the work. The parent holds every
   record, so a read a proven turn makes is asked of the parent's fleet door (runner-fleet.routes.ts) for its conversation,
   and answered as the parent answered. A conversation the parent did not place here, a person at this runner, a shell
   naming no turn, and a parent too old to have the door are all read here, as before. */

// A search across a large fleet takes a while; a parent past this is one to say is not answering.
const FLEET_READ_TIMEOUT_MS = 60_000;

export type ParentFleetAnswer =
    | { readonly kind: "answered"; readonly status: number; readonly body: string }
    // The parent placed no such conversation on this runner: it is this runner's own, read here.
    | { readonly kind: "not-placed" }
    // The parent has no door for this (an older build), or refused this runner's token: read here, as before it existed.
    | { readonly kind: "no-door"; readonly status: number }
    | { readonly kind: "unreachable"; readonly message: string };

/** One fleet read asked of the parent: `rest` is the read's path after `/fleet` with its query. */
export type ParentFleetRead = (rest: string, conversationId: string, signal?: AbortSignal) => Promise<ParentFleetAnswer>;

const notPlaced = (body: string): boolean => {
    try {
        return RunnerFleetNotPlacedSchema.safeParse(JSON.parse(body)).success;
    } catch {
        // allow(silent-catch): a body that is not JSON is no refusal of the door's own
        return false;
    }
};

export const parentFleetRead =
    (identity: RunnerIdentity): ParentFleetRead =>
    async (rest, conversationId, signal) => {
        const timeout = AbortSignal.timeout(FLEET_READ_TIMEOUT_MS);
        try {
            const response = await fetch(runnerFleetUrl(identity.parentUrl, rest), {
                headers: { authorization: `Bearer ${identity.token}`, [RUNNER_FLEET_CONVERSATION_HEADER]: conversationId },
                signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
            });
            if (response.headers.get(RUNNER_FLEET_DOOR_HEADER) === null) {
                // A proxy's 502 or a daemon that cannot read its enrollments is a parent not answering, not one without the door.
                return response.status >= 500 ? { kind: "unreachable", message: `it answered ${response.status}` } : { kind: "no-door", status: response.status };
            }
            const body = await response.text();
            return response.status === 404 && notPlaced(body) ? { kind: "not-placed" } : { kind: "answered", status: response.status, body };
        } catch (error) {
            return { kind: "unreachable", message: timeout.aborted ? `no answer in ${FLEET_READ_TIMEOUT_MS / 1000}s` : errorMessage(error) };
        }
    };

export type FleetRelayDeps = Pick<Services, "runnerParent" | "logger">;

// A path as this runner's shell saw it, made workspace-relative by this runner's own layout (fleet-overlap.ts indexedPath,
// which the fleet routes hand in).
export type WorkspaceRelative = (path: string) => string;

// The read's path after `/fleet` and its query, as the parent's door takes it. `on` is a link of this runner's, which the
// parent does not have; `touching` is made workspace-relative here, where the parent's reader leaves a relative path as
// it is.
const parentRest = (url: URL, relative: WorkspaceRelative): string => {
    const query = new URLSearchParams(url.searchParams);
    query.delete("on");
    const touching = query.get("touching");
    if (touching !== null && touching !== "") {
        query.set("touching", relative(touching));
    }
    const search = query.toString();
    return `${url.pathname.slice("/fleet".length)}${search === "" ? "" : `?${search}`}`;
};

const json = (body: string, status: number): Response => new Response(body, { status, headers: { "content-type": "application/json" } });

// Marked as the parent's answer, so the `agents` command says the paths it prints (a worktree, a record) are on the
// parent's machine, not this one, where a turn looking for them would find nothing.
const AnswerObjectSchema = z.record(z.string(), z.unknown());
const fromParent = (body: string): string => {
    try {
        const parsed = AnswerObjectSchema.safeParse(JSON.parse(body));
        return parsed.success ? JSON.stringify({ ...parsed.data, answeredBy: "parent" }) : body;
    } catch {
        // allow(silent-catch): a body that is not JSON is relayed as it came
        return body;
    }
};

/** A fleet read made on a runner, answered by its parent; undefined to read it here. */
export const relayFleetToParent = async (services: FleetRelayDeps, c: Context<AppEnv>, relative: WorkspaceRelative): Promise<Response | undefined> => {
    const fleet = services.runnerParent.current?.fleet;
    if (fleet === undefined || c.get("identity") !== undefined) {
        return undefined;
    }
    const url = new URL(c.req.url);
    if (!url.pathname.startsWith("/fleet")) {
        return undefined;
    }
    // Only a turn that proves which it is reads as its conversation at the parent, as it would read here (turn-reader.ts).
    const named = c.req.header("x-intentic-conversation");
    if (named === undefined || named === "" || !provesOwner(named, c.req.header("x-intentic-turn-proof"))) {
        return undefined;
    }
    const answer = await fleet(parentRest(url, relative), named, c.req.raw.signal);
    switch (answer.kind) {
        case "answered":
            return json(fromParent(answer.body), answer.status);
        case "not-placed":
            return undefined;
        case "no-door":
            services.logger.warn(
                { conversationId: named, status: answer.status },
                "runner: the parent has no fleet door for runners (an older build) or refused this runner's token, so the fleet is read here",
            );
            return undefined;
        case "unreachable":
            // Never this runner's few conversations in its place: a partial fleet read as the whole is what this replaced.
            return json(
                JSON.stringify({
                    ok: false,
                    message: `This conversation runs on a runner, and the fleet's records are in the sandbox it runs for, which did not answer (${answer.message}). Ask again once it is back: this runner holds only the turns it ran itself.`,
                }),
                502,
            );
    }
};
