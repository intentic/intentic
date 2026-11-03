import { type BackgroundJob, type Holders, JOBS, jobFinished, portJobOf } from "./background-jobs.js";

// WHOSE AGENT LISTENS ON A PORT, for its row on the ports list (ports/ports.routes.ts) and through it the desktop mirror,
// which leaves an agent's own server off the owner's computers. (2026-11-03) In the owner's shinobi workspace 53
// conversations ran ss and pgrep to find whose server held which port, and one agent's scratch server sat on the
// owner's 7878, which the mirror had put on his own localhost.

export interface PortOwner {
    readonly conversationId: string;
    readonly jobId?: string;
    readonly label?: string;
}

/**
 * The job left for the person on the port; else the conversation whose jobs ran in the tmux session the listener is in
 * (`conversationOf` names it for a session no job ran in), with the job itself when exactly one of that session's jobs
 * is still running.
 */
export const portOwnerOf = (
    actors: Holders,
    listener: { readonly port: number; readonly session?: string | undefined },
    conversationOf: (session: string) => string | undefined,
): PortOwner | undefined => {
    const handed = portJobOf(actors, listener.port);
    if (handed !== undefined) {
        return handed;
    }
    const session = listener.session;
    if (session === undefined) {
        return undefined;
    }
    const inSession: BackgroundJob[] = actors
        .holdings(JOBS)
        .entries()
        .map(([, record]) => record.job)
        .filter((job) => job.session === session);
    const conversationId = inSession.at(-1)?.conversationId ?? conversationOf(session);
    if (conversationId === undefined) {
        return undefined;
    }
    const running = inSession.filter((job) => job.conversationId === conversationId && !jobFinished(job));
    const [only] = running;
    return running.length === 1 && only !== undefined ? { conversationId, jobId: only.id, label: only.label } : { conversationId };
};
