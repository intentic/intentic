import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { ToolCallContent } from "@intentic/sandbox-contract/events/requests";
import { opt } from "../../opt.js";
import { ARTIFACTS_DIR } from "../../workspace/files/stored/stored-artifacts.js";
import { type ArtifactsHomeContext, askOptions, fetchHome } from "./runner-artifacts.js";

/* THE PICTURES A RUNNER'S TURN SHOWED, BROUGHT HOME. A screenshot or a generated picture is written into the artifacts
   folder of the machine running the turn, and its tool card names it by workspace path; the chat reads every picture
   from this sandbox's workspace, and neither the relay nor the branch's push carries that folder. So every screenshot a
   runner's turn took drew as "No longer available" (boat-pjdf, bird-mdu4 and arena-6hpr on omen, 2026-11-23). Each card
   naming one now waits while the file is fetched from the runner and filed here, so the card reaches the chat with its
   picture in place: a picture asked for before it lands is refused, and the chat keeps that refusal for the session. A
   picture the turn Read from its own checkout is fetched from that checkout and filed under the artifacts folder's
   runner/<conversation>/, the card renamed to it (2026-11-23): the mirror here has no file the checkout never committed. */

export interface PicturesHomeContext extends ArtifactsHomeContext {
    // The conversation whose turn showed them: a picture its turn Read from its own checkout is asked for there.
    readonly conversationId?: string;
}

// The workspace paths of the pictures a frame's card carries.
const picturesOf = (event: AgentEvent): readonly string[] =>
    event.kind === "tool_call" || event.kind === "tool_call_update"
        ? [...new Set((event.content ?? []).flatMap((entry) => (entry.type === "image" ? [entry.path] : [])))]
        : [];

// Where a picture is asked for and filed: one in the artifacts folder under its own path; one the turn Read from its own
// checkout, which the runner resolves in that checkout, under the artifacts folder's runner/<conversation>/, since the
// mirror here lacks what the checkout never committed (an ignored or uncommitted file) and has nothing of it mid-turn.
const sourceOf = (context: PicturesHomeContext, path: string): { readonly filedAs: string; readonly conversationId?: string } | undefined => {
    if (path.startsWith(ARTIFACTS_DIR)) {
        return { filedAs: path };
    }
    const id = context.conversationId;
    return id === undefined ? undefined : { filedAs: `${ARTIFACTS_DIR}runner/${id}/${path}`, conversationId: id };
};

// Where one picture is filed here: its own path, or another when this workspace already held different bytes under it;
// its own path again when it cannot be fetched, so the card still says what the turn took.
const fileHome = async (context: PicturesHomeContext, path: string): Promise<string> => {
    const client = context.hub.client(context.runnerId);
    const source = sourceOf(context, path);
    if (client === undefined || source === undefined) {
        return path;
    }
    try {
        // An older runner ignores `conversationId` and answers NOT_FOUND for a path outside its artifacts folder.
        const fetched = await fetchHome(context, source.filedAs, (range) =>
            client.readArtifact({ path, ...opt("conversationId", source.conversationId), ...range }, askOptions()),
        );
        if (fetched.kind !== "filed") {
            context.logger.warn({ runner: context.runnerId, path, why: fetched.kind }, "runner dispatch: a picture the runner showed was not filed here");
            return path;
        }
        return fetched.path;
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
