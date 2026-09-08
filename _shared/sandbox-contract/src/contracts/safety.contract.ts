import { oc } from "@orpc/contract";
import { SafetyLogEntrySchema, SafetyPolicySchema } from "../policy/safety-policy.js";
import { OkSchema } from "../schemas/shared.js";
import { z } from "zod";

// Owner's safety policy (.intentic/config/safety.md) and the log of what it decided. Own routes, not a /settings field:
// the policy is a document edited at human speed, the log changes on its own mid-turn. The policy travels as text,
// never parsed, since its reader is a model, not a parser.
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
    // Verdicts teach the owner which policy line to add next; answers why you weren't asked about something.
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
