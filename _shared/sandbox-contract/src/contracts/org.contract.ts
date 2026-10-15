import { procedure } from "../protocol/route-meta.js";
import { OrgPolicyStateSchema } from "../schemas/organisation.js";

// The organisation this sandbox belongs to, as the daemon enforces it (docs/architecture/organisations.md). The
// platform hands the policy over the sandbox's own connect token; this is the editor's read of the copy that decides,
// so the hub hides and locks what the daemon will refuse rather than what the platform last said. A guest may read it:
// it names the organisation and which sections are held, nothing about anyone.
export const orgContract = {
    policy: procedure
        .route({
            method: "GET",
            path: "/org/policy",
            summary: "Which organisation manages this sandbox, and what it holds",
            description:
                "Unbound for a personal sandbox. For one an organisation manages: its policy as this sandbox enforces it, section by section, and when that edition arrived.",
        })
        .meta({ guest: true })
        .output(OrgPolicyStateSchema),
};
