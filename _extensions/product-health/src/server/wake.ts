import { randomUUID } from "node:crypto";
import { errorMessage } from "@intentic/base/errors";
import { z } from "zod";
import type { Finding } from "../wire.js";
import { briefOf, impactWords } from "./brief.js";
import { type HealthDaemon, type ListenerMessage, POSTHOG_PROVIDER } from "./daemon.js";
import type { Transition } from "./poller.js";
import type { StateDocument } from "./state.js";

/* WAKING AN AGENT ON WHAT POSTHOG FOUND, through this extension's own listener source (`posthog`), the way the Issues
   extension wakes its intake: the sandbox's scheduler decides, not this backend. The daemon's listener door runs the
   message through each automation's filters (its channel is the connection), the owner's floor for a stranger's report
   (the listener declares `strangers: "report"`: an exception's message is whatever a user's browser sent), the day's
   ceiling, held wakes and the fire journal. One thread per finding, so its later turns continue one conversation.
   No automation listening is the ordinary case, and costs nothing: the door answers with no frames.

   The frames say what became of the wake; the conversation it opened (or will open, once a person lets a held one) is
   kept by finding, so the row shows that agent too. */

// How long a wake is followed for the conversation it opens; the turn itself runs on regardless.
const FOLLOW_MS = 10 * 60_000;

const FrameSchema = z.looseObject({
    opened: z.looseObject({ conversationId: z.string().optional() }).optional(),
    heldWake: z.looseObject({ conversationId: z.string().optional() }).optional(),
    failed: z.string().optional(),
    steered: z.boolean().optional(),
    end: z.boolean().optional(),
});
type Frame = z.infer<typeof FrameSchema>;

const frameOf = (line: string): Frame | undefined => {
    try {
        const parsed = FrameSchema.safeParse(JSON.parse(line));
        return parsed.success ? parsed.data : undefined;
    } catch {
        // allow(silent-catch): a line that is not JSON is not one of the door's decisions; the next line may be.
        return undefined;
    }
};

export interface WakeDeps {
    readonly daemon: Pick<HealthDaemon, `dispatch`>;
    readonly state: StateDocument;
    readonly log: (message: string) => void;
    readonly project: (connection: string) => string | undefined;
    readonly now: () => number;
}

/** The message a finding's wake carries: the brief in `extra`, with what came from outside under `untrusted`. */
const messageOf = (finding: Finding, transition: Transition, project: string | undefined, now: number): ListenerMessage => ({
    provider: POSTHOG_PROVIDER,
    type: transition,
    id: randomUUID(),
    // The connection, as the automation's channel filter names it.
    channelId: finding.connection,
    thread: finding.id,
    author: { id: finding.connection, name: `PostHog` },
    content: finding.title,
    timestamp: new Date(now).toISOString(),
    extra: {
        findingId: finding.id,
        kind: finding.source,
        severity: finding.severity,
        lane: finding.lane,
        link: finding.link,
        impact: impactWords(finding.impact) ?? ``,
        since: finding.since === undefined ? `` : new Date(finding.since).toISOString(),
        code: finding.code.map((link) => `${link.repo}/${link.path}${link.line === undefined ? `` : `:${link.line}`}`),
        // What came from users' browsers and devices, or a project-supplied value; the brief fences the same text.
        untrusted: { title: finding.title, ...finding.untrusted },
        brief: briefOf(finding, { project, now }),
    },
});

// Reads the door's frames until they say what became of the wake, then lets the stream go.
const follow = async (deps: WakeDeps, response: Response, findingId: string): Promise<void> => {
    const reader = response.body?.getReader();
    if (reader === undefined) {
        return;
    }
    const decoder = new TextDecoder();
    const deadline = deps.now() + FOLLOW_MS;
    let buffer = ``;
    const note = async (conversationId: string): Promise<void> => {
        await deps.state.update((state) => ({ ...state, woken: { ...state.woken, [findingId]: conversationId } }));
    };
    try {
        for (let chunk = await reader.read(); !chunk.done && deps.now() < deadline; chunk = await reader.read()) {
            buffer += decoder.decode(chunk.value, { stream: true });
            const lines = buffer.split(`\n`);
            buffer = lines.pop() ?? ``;
            for (const frame of lines.map(frameOf)) {
                const conversationId = frame?.opened?.conversationId ?? frame?.heldWake?.conversationId;
                if (conversationId !== undefined) {
                    await note(conversationId);
                    return;
                }
                if (frame?.failed !== undefined) {
                    deps.log(`the wake on ${findingId} failed: ${frame.failed}`);
                }
                if (frame?.steered === true || frame?.end === true) {
                    return;
                }
            }
        }
    } finally {
        // allow(silent-catch): the stream may already be closed, and the turn runs on regardless.
        await reader.cancel().catch(() => undefined);
    }
};

/** Hands one finding's transition to the listener door, and follows it for the conversation it opens. */
export const wakeOn = async (deps: WakeDeps, finding: Finding, transition: Transition): Promise<void> => {
    try {
        const response = await deps.daemon.dispatch(messageOf(finding, transition, deps.project(finding.connection), deps.now()));
        if (!response.ok) {
            deps.log(`the sandbox refused the wake on ${finding.id} (${response.status}): ${(await response.text()).slice(0, 300)}`);
            return;
        }
        await follow(deps, response, finding.id);
    } catch (error) {
        deps.log(`could not wake anyone on ${finding.id}: ${errorMessage(error)}`);
    }
};
