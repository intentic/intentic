import { oc } from "@orpc/contract";
import { SafetyLogEntrySchema, SafetyPolicySchema } from "../safety-policy.js";
import { OkSchema } from "../schemas/shared.js";
import { z } from "zod";

/* The owner's safety policy (.intentic/config/safety.md) and the log of what it decided.
 *
 * ITS OWN ROUTES RATHER THAN A FIELD ON /settings, and the split is the same one `rule-firings` already draws
 * next door: the policy is a DOCUMENT edited at human speed, and the log is a value that changes on its own
 * several times a turn. Folding either into the settings object would put a self-changing value inside the
 * thing a screen optimistically patches, and would make every judged command a settings write.
 *
 * The policy is also the only config file here whose reader is a model rather than a parser, so it travels as
 * text and is never parsed on the way through: whatever the owner wrote is what the judge reads.
 */
export const safetyContract = {
    policy: oc
        .route({
            method: "GET",
            path: "/safety/policy",
            summary: "The safety policy this sandbox is judged against",
            description:
                "The document that decides when an agent stops to ask you before running something. Prose, not settings: it is read by the model that judges each command. When nobody has written one, this is the text the product ships with, and it describes the behaviour a fresh sandbox already has.",
        })
        .output(SafetyPolicySchema),
    setPolicy: oc
        .route({
            method: "POST",
            path: "/safety/policy",
            summary: "Rewrite the safety policy",
            description:
                "Replaces the document whole. Nothing in it can widen what the sandbox is structurally allowed to do: it decides which of the things an agent may already do are worth interrupting you about.",
        })
        .input(z.object({ text: z.string().describe("The policy, as you want it written.") }))
        .output(OkSchema),
    // What the policy actually did, newest first. The half of the Safety page that makes the other half
    // writable: nobody can author a policy for behaviour they cannot see, and a column of verdicts is what
    // teaches an owner which line to add next.
    log: oc
        .route({
            method: "GET",
            path: "/safety/log",
            summary: "Recent safety verdicts",
            description:
                "What was judged lately, what the judge decided, and whether you were interrupted. Newest first. This is where you find out why you were not asked about something, which is the question a policy page otherwise cannot answer.",
        })
        .output(z.array(SafetyLogEntrySchema)),
};
