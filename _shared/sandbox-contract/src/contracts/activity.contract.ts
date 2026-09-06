import { oc } from "@orpc/contract";
import { ActivityListSchema, ActivityQuerySchema, ActivityStatusSchema } from "../schemas/activity.js";

// The activity audit feed (provider-agnostic; Discord is the first source). Read-only by design,
// events are appended daemon-side only, so the log stays a trustworthy record of what the agent did.
export const activityContract = {
    list: oc
        .route({
            method: "GET",
            path: "/activity",
            summary: "What the agent has done out in the world",
            description:
                "The audit trail of actions taken on outside services. Read-only on purpose: entries are written by the sandbox alone, which is what makes it a record worth trusting.",
        })
        .input(ActivityQuerySchema)
        .output(ActivityListSchema),
    status: oc
        .route({
            method: "GET",
            path: "/activity/status",
            summary: "Whether the audit trail is being kept",
            description: "Which sources are feeding the record and whether each is working.",
        })
        .output(ActivityStatusSchema),
};
