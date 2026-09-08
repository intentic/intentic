import { roleAtLeast } from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";

// Is the person behind this request one who may see a credential: maintainer-or-owner tier, same line as
// owner-gates.ts.
// A program never qualifies, whatever its scope, since a control token carries no member identity; loopback mode has no
// identities at all, so everyone there is the owner.
export const operatorHere = (services: Pick<Services, "auth">, context: Pick<OrpcContext, "identity">): boolean =>
    services.auth === undefined || (context.identity !== undefined && roleAtLeast(context.identity.role, "maintainer"));
