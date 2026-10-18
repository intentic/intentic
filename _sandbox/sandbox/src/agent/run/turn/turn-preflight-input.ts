import { resolveExistingWithin, resolveWithin } from "../../../workspace/files/workspace-files-paths.js";
import type { TranscriptRow } from "@intentic/sandbox-contract/events/transcript";
import type { Services } from "../../../composition.js";
import type { RoutedTurn } from "../../../seams/turn-starter.js";
import { AgentDomainRefusedError, type AgentExecutionContext } from "../../../workload/agent-execution.js";
import { handoffHistory } from "../../../sessions/turn-transcript.js";

// The session to resume, or none if the runtime no longer holds it, which opens a fresh session seeded from the record
// instead. A store that can't be probed is trusted, not doubted.
// Only a backstop: which session a turn continues is decided before it gets here, on the runtime and account that minted it
// (conversations/registry/routing.ts sessionFor). What this probe catches is a session that decision rightly named and the
// runtime has since lost (a pruned store, a recreated container), never one named for the wrong provider.
export const sessionToResume = async (services: Services, input: RoutedTurn, execution: AgentExecutionContext): Promise<string | undefined> => {
    const { sessionId } = input;
    if (sessionId === undefined) {
        return undefined;
    }
    const adapter = services.adapters.for(input.agent, input.harness);
    const held = await services.perf
        .track("turn.preflight.session", {}, () => adapter.holdsSession(services, sessionId, execution))
        .catch((error: unknown) => {
            if (error instanceof AgentDomainRefusedError) {
                throw error;
            }
            services.logger.warn({ err: error, sessionId }, "session probe failed, resuming as asked");
            return true;
        });
    return held ? sessionId : undefined;
};

// Resuming no session is a runtime handoff, seeded from the record read before this turn appends its own, less the
// runs the door turned away before this turn sent their words again: the model never saw those rows.
export const handoffOf = async (services: Services, input: RoutedTurn, resumed: string | undefined): Promise<readonly TranscriptRow[]> => {
    if (resumed !== undefined || input.conversationId === undefined) {
        return [];
    }
    const rows = await handoffHistory(services, { ...input, conversationId: input.conversationId });
    const unseen = new Set(input.unseenRuns ?? []);
    return unseen.size === 0 ? rows : rows.filter((row) => row.run === undefined || !unseen.has(row.run));
};

// Attachments arrive workspace-relative; resolved to absolute paths for the provider, escapes rejected. The run route
// refuses these at the door, so reaching a refusal is a turn replayed from a record (resume, fork, a runner). Mentions
// are a tokenizer's reading of the message, not files the user picked: one that escapes or names nothing is dropped,
// since a `@path` pasted inside terminal output must not be able to kill the turn.
export const attachmentsOf = async (root: string, input: RoutedTurn): Promise<{ readonly paths: string[] } | { readonly refused: string }> => {
    const paths: string[] = [];
    for (const rel of input.attachments ?? []) {
        const abs = resolveWithin(root, rel);
        if (abs === undefined) {
            return { refused: `invalid attachment path: ${rel}` };
        }
        paths.push(abs);
    }
    const mentioned = await resolveExistingWithin(root, input.mentions);
    paths.push(...mentioned.filter((abs) => !paths.includes(abs)));
    // The editor-context chip's file rides workspace-relative too, same escape guard as attachments.
    if (input.editorContext !== undefined && resolveWithin(root, input.editorContext.file) === undefined) {
        return { refused: `invalid editor context path: ${input.editorContext.file}` };
    }
    return { paths };
};
