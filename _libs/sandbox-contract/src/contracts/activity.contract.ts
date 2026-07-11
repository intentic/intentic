import { oc } from "@orpc/contract";
import { ActivityListSchema, ActivityQuerySchema, ActivityStatusSchema } from "../schemas.js";

// The agent-activity audit feed (provider-agnostic; Discord is the first source). Read-only by design —
// events are appended daemon-side only, so the log stays a trustworthy record of what the agent did.
export const activityContract = {
    list: oc.route({ method: "GET", path: "/activity" }).input(ActivityQuerySchema).output(ActivityListSchema),
    status: oc.route({ method: "GET", path: "/activity/status" }).output(ActivityStatusSchema),
};
