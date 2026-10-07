import type { Automation } from "@intentic/sandbox-contract";
import { envSuffix } from "@intentic/sandbox-contract";
import { gatewayHeld, shellEnvOf } from "../../capabilities/cli-env.js";
import { turnCliEnv } from "../../capabilities/turn-env.js";
import type { Services } from "../../composition.js";
import { personaCliEnv, turnPersona } from "../../personas/personas.js";
import { createCredentialGrants } from "../../secrets/credential-grants.js";
import { gatedCliEnv } from "../../secrets/credential-gating.js";

// The connector credentials a guard runs with: what an unattended turn of the same automation would get in its shell,
// narrowed by the automation's persona exactly as that turn's would be, and with every credential a named approver
// holds left out, since nobody is there to release one. Built the same way a turn's shell env is (turn-env.ts), from no
// conversation: the gateway addresses it mints answer to none, so a refusal cannot raise a card that nobody sees.
// Without this a guard could only check what needs no login, so a private repository's releases were out of reach.
export const guardCapabilityEnv = async (services: Services, automation: Pick<Automation, "actsAs">): Promise<Record<string, string>> => {
    // Each read started inside its own async step, so one that throws before it returns a promise rejects this call
    // instead of leaving the others' rejections unhandled.
    const [cliEnv, installed, personas, gates] = await Promise.all([
        turnCliEnv(services, undefined),
        (async () => await services.capabilities.list())(),
        (async () => await services.personas.list())(),
        (async () => await services.credentialGates.list())(),
    ]);
    const persona = turnPersona({ personas, actsAs: automation.actsAs, unattended: true });
    const narrowed = personaCliEnv(cliEnv, installed, persona, envSuffix);
    // No releases: a release is given to a conversation, and a guard has none.
    const gated = gatedCliEnv(narrowed, installed, gates, createCredentialGrants(), undefined, envSuffix, gatewayHeld);
    return shellEnvOf(gated.cliEnv);
};
