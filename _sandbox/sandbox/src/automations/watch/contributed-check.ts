import { errnoCode, errorMessage } from "@intentic/base/errors";
import type { WatchCheck } from "@intentic/extension-api/runtime";
import { watchParamsProblem } from "@intentic/extension-manifest";
import { envSuffix } from "@intentic/sandbox-contract/policy/capability-env";
import { type ContributedWatchSource, isUrlSource, type WatchSource } from "@intentic/sandbox-contract/schemas/automations";
import { brokerOf, brokerRoutes } from "../../capabilities/broker/broker-routes.js";
import { gatewayHeld } from "../../capabilities/cli-env.js";
import { contributionFor, contributionRegistry } from "../../capabilities/contributions.js";
import type { Services } from "../../composition.js";
import { checkRequestBody, watchAnswerFrom } from "../../extensions/backend/backend-checks.js";
import { BACKEND_HOST_HEADER } from "../../extensions/backend/backend-host-config.js";
import { backendDown } from "../../extensions/backend/extension-mcp.js";
import type { AutomationRecord } from "../automations-store.js";
import { guardCapabilityEnv } from "./guard-env.js";
import { type DeclaredKind, declaredWatchKinds, unservedWhy } from "./watch-kinds.js";
import { checkUrlSource, type SourceCheck } from "./watch-sources.js";

// (2026-11-26) A WATCH'S CHECK, WHICHEVER KIND: the daemon's own `url` fetched here, every other kind handed to the
// backend of the extension that declares it (`api.checks.serve`) through the backend host's `POST /checks/<id>` door, the
// way an automation's fire reaches a handler (extension-fires.ts): the host token alone reaches it, and only this module
// sends to it. The check is handed its parameters, what the last pass saw, and the credential-gateway addresses of the
// extension's own cards its kind names, narrowed by the automation's role as an unattended turn's shell would be
// (guard-env.ts): addresses, never a credential. Before this, the npm and GitHub release clients lived in watch-sources.ts.

// What a check came to, and whether it could run at all. `broken`: it never can as things stand (nothing declares the
// kind, its extension is off, its parameters do not fit), which the run records as an error, not a quiet skip, so a watch
// whose extension went away says so rather than waiting forever. A backend that is down or still starting is not broken:
// it is tried again on the next tick, like a page that did not answer.
export type WatchVerdict = SourceCheck | { readonly pass: false; readonly detail: string; readonly broken: true };

// Who the check is for: the automation (whose role narrows the cards it reaches) and what its last pass saw; neither for
// a check tried by hand, which reaches the cards a role-less unattended turn would.
export interface CheckAsked {
    readonly automation?: Pick<AutomationRecord, "id" | "actsAs" | "runAs">;
    readonly last?: string | undefined;
}

// As long as a guard command may run: the backend's own fetches are bounded tighter, and this catches one that hangs.
const CHECK_DEADLINE_MS = 60_000;

type Registry = Awaited<ReturnType<typeof contributionRegistry>>;
type Card = Awaited<ReturnType<Services["capabilities"]["list"]>>[number];

// One card's route addresses, when it is one of the kind's own cards and the gateway holds its credential.
const cardReach = (env: Readonly<Record<string, string>>, declared: DeclaredKind, registry: Registry, card: Card): [string, string][] => {
    if (card.kind !== "cli") {
        return [];
    }
    const contribution = contributionFor(registry, "cli", card.config);
    const broker = contribution === undefined ? undefined : brokerOf(contribution.spec);
    if (broker === undefined || contribution?.extension.id !== declared.installId || !declared.capabilities.includes(contribution.spec.id) || !gatewayHeld(env, card.id)) {
        return [];
    }
    return brokerRoutes(broker, card.config).flatMap((route) => {
        const name = route.env === undefined ? undefined : `${route.env}_${envSuffix(card.id)}`;
        const address = name === undefined ? undefined : env[name];
        return name === undefined || address === undefined ? [] : [[name, address]];
    });
};

// The gateway addresses of the extension's own cards its kind names, as the automation's role reaches them.
const reachOf = async (services: Services, declared: DeclaredKind, asked: CheckAsked): Promise<Record<string, string>> => {
    if (declared.capabilities.length === 0) {
        return {};
    }
    const [env, registry, installed] = await Promise.all([
        guardCapabilityEnv(services, asked.automation ?? {}),
        contributionRegistry(services),
        services.capabilities.list(),
    ]);
    return Object.fromEntries(installed.flatMap((card) => cardReach(env, declared, registry, card)));
};

// One try through the door: the answer, or why there was none.
const askBackend = async (services: Services, declared: DeclaredKind, check: WatchCheck): Promise<SourceCheck> => {
    const backend = services.extensionBackend.proxyTarget();
    const by = declared.kind.extension;
    if (backend === undefined) {
        return { pass: false, detail: `${by} could not check it now: ${backendDown(services.extensionBackend)}` };
    }
    try {
        const answered = await fetch(`http://127.0.0.1:${backend.port}/checks/${encodeURIComponent(declared.installId)}`, {
            method: "POST",
            headers: { "content-type": "application/json", [BACKEND_HOST_HEADER]: backend.hostToken },
            body: checkRequestBody(check),
            signal: AbortSignal.timeout(CHECK_DEADLINE_MS),
        });
        if (!answered.ok) {
            const why = (await answered.text()).slice(0, 300);
            return answered.status === 404
                ? { pass: false, detail: `${by}'s backend does not serve the "${check.kind}" check yet (${why})` }
                : { pass: false, detail: `the check failed in ${by}'s backend: ${why}` };
        }
        return (await watchAnswerFrom(answered)) ?? { pass: false, detail: `${by}'s backend answered something other than a check's answer` };
    } catch (error) {
        if (error instanceof Error && error.name === "TimeoutError") {
            return { pass: false, detail: `${by}'s "${check.kind}" check did not answer within ${CHECK_DEADLINE_MS / 1_000}s` };
        }
        const refused = errnoCode(error instanceof Error ? error.cause : undefined) === "ECONNREFUSED";
        return { pass: false, detail: `${by} could not check it now: ${refused ? "its backend host was not listening" : errorMessage(error)}` };
    }
};

// The parameters a kind's backend is handed: every field beside `kind` that holds a value (a released npm or GitHub
// release source types its optional fields as possibly absent).
const paramsOf = ({ kind: _kind, ...rest }: ContributedWatchSource): Readonly<Record<string, string | boolean>> =>
    Object.fromEntries(Object.entries(rest).filter((entry): entry is [string, string | boolean] => entry[1] !== undefined));

const checkContributed = async (services: Services, source: ContributedWatchSource, asked: CheckAsked): Promise<WatchVerdict> => {
    const declared = (await declaredWatchKinds(services)).find((each) => each.kind.id === source.kind);
    const unserved = unservedWhy(source.kind, declared);
    if (declared === undefined || unserved !== undefined) {
        return { pass: false, broken: true, detail: unserved ?? `nothing serves the "${source.kind}" watch kind` };
    }
    const problem = watchParamsProblem(declared.kind, source);
    if (problem !== undefined) {
        return { pass: false, broken: true, detail: `this ${source.kind} watch cannot be checked as written: ${problem}` };
    }
    const { kind } = source;
    const params = paramsOf(source);
    const reach = await reachOf(services, declared, asked).catch((error: Error) => {
        services.logger.warn({ err: error, kind }, "watch check: its cards' gateway addresses could not be resolved, it checks without them");
        return {};
    });
    return askBackend(services, declared, { kind, params, reach, last: asked.last, automationId: asked.automation?.id });
};

/** Checks a watch's source once: a page here, any other kind in the backend of the extension that declares it. */
export const checkWatchSource = async (services: Services, source: WatchSource, asked: CheckAsked = {}): Promise<WatchVerdict> =>
    isUrlSource(source) ? checkUrlSource(source, { fetch: (url, init) => fetch(url, init) }) : checkContributed(services, source, asked);
