import type { Services } from "../../../composition.js";
import { worktreeOf } from "../../../conversations/registry/agents-store.js";
import { opt } from "../../../opt.js";
import { inlineFiles } from "../../../runners/files/runner-files.js";
import type { Steer, Unsteered } from "../../../seams/turn-starter.js";

/* WORDS FOR A TURN RUNNING ON A RUNNER. The live turn there is the runner's, and the parent's own run of it (the relay)
   has a steering queue nothing drains: words pushed into it were reported delivered and never arrived. Only the person's
   own steer used to cross; an agent's message to a working child, a wake while a turn ran and a page's error report went
   into that queue (2026-11-23). Every steer for a conversation placed on a runner now goes through its `steer` door, the
   files it names carried as bytes, and says whose words they are. */

const NOT_STEERABLE: Unsteered = { why: "no steerable turn running for that conversation" };

/** The runner a conversation's turns run on, when it is placed on one. */
export const runnerOfConversation = (services: Partial<Pick<Services, "agents">>, conversationId: string): string | undefined =>
    services.agents === undefined ? undefined : worktreeOf(services.agents.entry(conversationId))?.runner;

/** Hands words to the turn the runner runs for this conversation: true once its live turn took them. */
export const steerOnRunner = async (
    services: Pick<Services, "runnerHub" | "workspace" | "logger">,
    runnerId: string,
    conversationId: string,
    steer: Steer,
): Promise<true | Unsteered> => {
    const client = services.runnerHub.client(runnerId);
    if (client === undefined) {
        return { why: `the runner "${runnerId}" is offline, so nothing is running to say this to.` };
    }
    // By the rule composing them here applies: an escaping attachment refuses the words, an escaping mention is dropped.
    const inlined = await inlineFiles(services.workspace.root, services.logger, steer);
    if (inlined.invalid !== undefined) {
        return { invalid: inlined.invalid };
    }
    const files = inlined.files;
    let delivered;
    try {
        delivered = await client.steer({
            conversationId,
            text: steer.text,
            attachments: steer.attachments?.slice(),
            mentions: steer.mentions?.slice(),
            editorContext: steer.editorContext,
            // The person's needs no saying: an older runner takes every steer as theirs.
            ...opt("voice", steer.voice === "person" ? undefined : steer.voice),
            ...opt("outside", steer.outside),
            ...opt("errand", steer.errand),
            ...opt("files", files),
        });
    } catch (error) {
        services.logger.warn({ err: error, runner: runnerId, id: conversationId }, "runner: a steer did not reach the runner");
        return { why: `the runner "${runnerId}" did not take the words: the link to it dropped.` };
    }
    if (delivered.invalid !== undefined) {
        return { invalid: delivered.invalid };
    }
    return delivered.applied || NOT_STEERABLE;
};
