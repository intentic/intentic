import { secretsContract } from "@intentic/sandbox-contract/contracts/secrets.contract";
import { originsOfRules, titleForOrigin } from "@intentic/sandbox-contract/policy/keyring-origins";
import type { SandboxPassword } from "@intentic/sandbox-contract/schemas/sandbox-passwords";
import { implement } from "@orpc/server";
import type { OrpcContext } from "../../app-env.js";
import { noteAudit } from "../../audit/audit-http.js";
import type { Services } from "../../composition.js";
import { opt } from "../../opt.js";
import { lastUseByName } from "../secret-uses.js";
import type { DevicePointer } from "./keyring-link.js";

// The sandbox's side of Passwords over HTTP: an agent's need (`secrets want`, on the agent token), and the hosted
// Passwords view's three reads, owner and maintainers only like every other secrets read. Never a value.

export type PasswordRoutesDeps = Pick<Services, "deviceSecrets" | "keyringLink" | "keyringNeeds" | "secretUses">;

const ACTIVITY_MAX = 100;

// One pointer as the view lists it: where it works, from its rules, and its title from the first of those.
const sandboxPasswordOf = ({ machine, pointer, online }: DevicePointer, lastUsedAt: number | undefined): SandboxPassword => {
    const origins = originsOfRules({ programs: pointer.programs, packages: pointer.packages, hosts: pointer.hosts, askpass: [] });
    const first = origins[0];
    return {
        name: pointer.name,
        title: first === undefined ? pointer.name : titleForOrigin(first),
        kind: pointer.kind,
        origins,
        anyField: pointer.anyField,
        machine,
        mode: pointer.mode,
        online,
        updatedAt: pointer.updatedAt,
        ...opt("lastUsedAt", lastUsedAt),
    };
};

export const createPasswordRoutes = (services: PasswordRoutesDeps) => {
    const i = implement(secretsContract).$context<OrpcContext>();
    return {
        want: i.want.handler(async ({ input, context, signal }) => {
            noteAudit({ target: input.origin.kind });
            return services.keyringNeeds.request({
                origin: input.origin,
                ...opt("username", input.username),
                detail: input.why,
                // Body field first, else the header every agent CLI sends.
                ...opt("conversationId", input.conversationId ?? context.headers.get("x-intentic-conversation") ?? undefined),
                ...opt("signal", signal),
            });
        }),
        passwords: i.passwords.handler(async () => {
            const [listed, computers, uses, sandbox] = await Promise.all([
                services.deviceSecrets.listed(),
                services.keyringLink.computers(),
                services.secretUses.all(),
                // allow(silent-catch): the address only labels the answer; the list stands without it
                services.keyringLink.sandboxUrl().catch(() => ""),
            ]);
            const last = lastUseByName(uses);
            return {
                sandbox,
                items: listed.map((entry) => sandboxPasswordOf(entry, last.get(entry.pointer.name)?.at)),
                keyrings: computers.map((computer) => ({
                    machine: computer.machine,
                    online: computer.online,
                    setUp: computer.setUp,
                    ...opt("locked", computer.locked),
                    ...opt("remember", computer.remember),
                })),
            };
        }),
        passwordNeeds: i.passwordNeeds.handler(async () => ({ needs: [...(await services.keyringNeeds.pending())] })),
        passwordActivity: i.passwordActivity.handler(async () => {
            const [listed, uses] = await Promise.all([services.deviceSecrets.listed(), services.secretUses.all()]);
            const held = new Set(listed.map((entry) => entry.pointer.name));
            return {
                lines: uses
                    .filter((use) => held.has(use.name))
                    .toReversed()
                    .slice(0, ACTIVITY_MAX)
                    .map((use) => ({ at: use.at, name: use.name, lane: use.lane, ...opt("detail", use.detail), ...opt("approvedBy", use.approvedBy) })),
            };
        }),
    };
};
