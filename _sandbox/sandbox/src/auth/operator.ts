import { roleAtLeast } from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";

/* IS THE PERSON BEHIND THIS REQUEST ONE WHO MAY SEE A CREDENTIAL, the question every route that attaches a
 * door token, a webhook secret or an ingest key to its answer has to ask, and asks the same way.
 *
 * "Operator" is the maintainer-or-owner tier, the same line owner-gates.ts draws for the privileged controls:
 * the highest revokable grant has the owner's operating authority, and a viewer or a collaborator does not. A
 * PROGRAM never does, whatever its scope: a control token reaches a route by its scope and carries no member
 * identity, so `identity` is unset and the answer is no, which is what keeps a `read` token from harvesting the
 * webhook tokens off the very list it is allowed to read.
 *
 * Loopback mode (no `auth` composed) has no identities at all and every caller is the owner at their own
 * terminal, so the answer there is yes, exactly as owner-gates.ts admits everyone. */
export const operatorHere = (services: Pick<Services, "auth">, context: Pick<OrpcContext, "identity">): boolean =>
    services.auth === undefined || (context.identity !== undefined && roleAtLeast(context.identity.role, "maintainer"));
