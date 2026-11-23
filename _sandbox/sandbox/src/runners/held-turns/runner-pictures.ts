import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { ToolCallContent } from "@intentic/sandbox-contract/events/requests";
import type { Logger } from "pino";
import { opt } from "../../opt.js";
import { ARTIFACTS_DIR, artifactDigest, keepArtifactCopy } from "../../workspace/files/stored/stored-artifacts.js";
import type { RunnerHub } from "../runner-peer.js";

/* THE PICTURES A RUNNER'S TURN SHOWED, BROUGHT HOME. A screenshot or a generated picture is written into the artifacts
   folder of the machine running the turn, and its tool card names it by workspace path; the chat reads every picture
   from this sandbox's workspace, and neither the relay nor the branch's push carries that folder. So every screenshot a
   runner's turn took drew as "No longer available" (boat-pjdf, bird-mdu4 and arena-6hpr on omen, 2026-11-23). Each card
   naming one now waits while the file is fetched from the runner and filed here, so the card reaches the chat with its
   picture in place: a picture asked for before it lands is refused, and the chat keeps that refusal for the session. */

const ASK_MS = 30_000;

export interface PicturesHomeContext {
    readonly hub: Pick<RunnerHub, "client">;
    readonly logger: Pick<Logger, "warn">;
    readonly runnerId: string;
    readonly workspaceRoot: string;
}

// The workspace paths of the pictures a frame's card carries that live in the artifacts folder; a picture elsewhere is
// in the conversation's checkout, which the branch's push brings back.
const picturesOf = (event: AgentEvent): readonly string[] =>
    event.kind === "tool_call" || event.kind === "tool_call_update"
        ? [...new Set((event.content ?? []).flatMap((entry) => (entry.type === "image" && entry.path.startsWith(ARTIFACTS_DIR) ? [entry.path] : [])))]
        : [];

// Where one picture is filed here: its own path, or another when this workspace already held different bytes under it;
// its own path again when it cannot be fetched, so the card still says what the turn took.
const fileHome = async (context: PicturesHomeContext, path: string): Promise<string> => {
    const client = context.hub.client(context.runnerId);
    if (client === undefined) {
        return path;
    }
    try {
        const have = await artifactDigest(context.workspaceRoot, path);
        const { bytesBase64 } = await client.readArtifact({ path, ...opt("have", have) }, { signal: AbortSignal.timeout(ASK_MS) });
        if (bytesBase64 === undefined) {
            return path;
        }
        const filed = await keepArtifactCopy(context.workspaceRoot, path, Buffer.from(bytesBase64, "base64"));
        if (filed === undefined) {
            context.logger.warn({ runner: context.runnerId, path }, "runner dispatch: a picture the runner showed had nowhere to be filed");
        }
        return filed ?? path;
    } catch (error) {
        context.logger.warn({ err: error, runner: context.runnerId, path }, "runner dispatch: a picture the runner showed could not be brought home");
        return path;
    }
};

/**
 * Files the pictures a frame's card shows before the frame goes on, and answers the frame as it is relayed: unchanged,
 * or with a picture renamed where it was filed under another name. A picture that cannot be fetched is logged and the
 * frame still goes.
 */
export const bringPicturesHome = async (context: PicturesHomeContext, event: AgentEvent): Promise<AgentEvent> => {
    const paths = picturesOf(event);
    if (paths.length === 0 || (event.kind !== "tool_call" && event.kind !== "tool_call_update")) {
        return event;
    }
    const renamed = new Map<string, string>();
    for (const path of paths) {
        const filed = await fileHome(context, path);
        if (filed !== path) {
            renamed.set(path, filed);
        }
    }
    if (renamed.size === 0) {
        return event;
    }
    const content = (event.content ?? []).map((entry): ToolCallContent => (entry.type === "image" ? { ...entry, path: renamed.get(entry.path) ?? entry.path } : entry));
    return { ...event, content };
};
