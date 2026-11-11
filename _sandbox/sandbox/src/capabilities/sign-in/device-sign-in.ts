import { randomBytes } from "node:crypto";
import { sleep } from "@intentic/base/async";
import { errorMessage } from "@intentic/base/errors";
import { parseJsonOr } from "@intentic/base/json";
import { evaluateWhen, parseWhen } from "@intentic/base/when";
import type { CapabilityContribution } from "@intentic/extension-manifest";
import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import type { DeviceSignInStart, DeviceSignInWait } from "@intentic/sandbox-contract/schemas/device-sign-in";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { nodeRequest } from "../../system/tls/node-request.js";
import { contributionFor, expandFieldTemplate, fieldsNamedIn, type ResolvedContribution } from "../contributions.js";
import type { SecretStash } from "../credentials/secret-stash.js";
import { grantedPermissions, microsoftEndpoint, microsoftVerificationPage, scopeForCloud } from "./microsoft-identity.js";
import { probeCapability } from "../probe.js";

// A connection's form signing in on its own with a device code (RFC 8628), as its manifest declares it
// (`refreshToken.deviceCode`, on a card whose field says `signIn`). The provider's endpoints answer no browser (no CORS),
// so the sandbox asks for the code, and asks the provider whether the person has finished only while the form waits:
// nothing polls for a form that went away. The refresh token goes into the stash, the way a generated SSH key does, and
// the form gets the stash token for its field; the add that saves the form installs it, bound to the answers it was
// made with. The CLI's own sign-in (`m365 auth login`) is untouched: it stores through the oauth-token route.

type CliSpec = Extract<CapabilityContribution, { kind: "cli" }>;
type DeviceCode = NonNullable<NonNullable<CliSpec["refreshToken"]>["deviceCode"]>;
type CliCapability = Extract<Capability, { kind: "cli" }>;

// A sign-in the form cannot start is the form's to fix: a bad request, in the words the person fixes it by.
const refused = (message: string) => new ORPCError("BAD_REQUEST", { message });

// What the sandbox asks, resolved from the card's declaration and the form's answers.
export interface DeviceSignInPlan {
    readonly capability: CliCapability;
    readonly contribution: ResolvedContribution;
    readonly field: string;
    readonly authority: string;
    readonly authorizeUrl: URL;
    readonly tokenUrl: URL;
    readonly clientId: string;
    readonly scope: string;
    // The answers the token is only good for, as the form sent them: the card, and every field `boundTo` names.
    readonly binding: Readonly<Record<string, string>>;
}

// The form's answers as the declaration reads them: a field left empty holds its default, as it does on the card.
const answersOf = (spec: CliSpec, config: Readonly<Record<string, string>>) =>
    Object.fromEntries([...Object.entries(config), ...spec.fields.map((field) => [field.key, config[field.key] || field.default || ""] as const)]);

const holds = (when: string | undefined, answers: Readonly<Record<string, string>>): boolean => when === undefined || evaluateWhen(parseWhen(when), answers);

const scopeOf = (declared: DeviceCode["scope"], answers: Readonly<Record<string, string>>): string | undefined =>
    Array.isArray(declared) ? declared.find((choice) => holds(choice.when, answers))?.scope : declared;

// Every field a template reads must be answered, or the provider is asked something it can only refuse in its own
// terms; asked by its label, as the form shows it.
const unanswered = (spec: CliSpec, templates: readonly string[], answers: Readonly<Record<string, string>>): string | undefined => {
    const named = new Set(templates.flatMap((template) => [...fieldsNamedIn(template)]));
    return spec.fields.find((field) => named.has(field.key) && (answers[field.key] ?? "").trim() === "")?.label;
};

const deviceSignInPlan = (registry: ReadonlyMap<string, ResolvedContribution>, capability: Capability): DeviceSignInPlan => {
    const contribution = capability.kind === "cli" ? contributionFor(registry, capability.kind, capability.config) : undefined;
    const spec = contribution?.spec;
    const declared = spec?.kind === "cli" ? spec.refreshToken : undefined;
    const field = spec?.fields.find((candidate) => candidate.key === declared?.field);
    if (capability.kind !== "cli" || contribution === undefined || spec?.kind !== "cli" || declared?.deviceCode === undefined || field?.signIn !== "microsoft") {
        throw refused("this connection does not sign in from its form");
    }
    const answers = answersOf(spec, capability.config);
    const flow = declared.deviceCode;
    if (!holds(flow.when, answers)) {
        throw refused(`with these settings the ${field.label} is pasted, not signed in here`);
    }
    const missing = unanswered(spec, [flow.authorizeUrl, flow.tokenUrl, flow.clientId], answers);
    if (missing !== undefined) {
        throw refused(`Fill in ${missing} first.`);
    }
    const authorize = microsoftEndpoint(expandFieldTemplate(flow.authorizeUrl, answers));
    const token = microsoftEndpoint(expandFieldTemplate(flow.tokenUrl, answers));
    if (authorize === undefined || token === undefined || authorize.url.host !== token.url.host) {
        throw refused("that is not a Microsoft cloud this sandbox signs in at");
    }
    const scope = scopeOf(flow.scope, answers);
    if (scope === undefined) {
        throw refused("the card asks for no permissions with these settings");
    }
    const binding = Object.fromEntries(["provider", ...declared.boundTo].map((key) => [key, String(capability.config[key] ?? "")]));
    return {
        capability,
        contribution,
        field: field.key,
        authority: authorize.url.hostname,
        authorizeUrl: authorize.url,
        tokenUrl: token.url,
        clientId: expandFieldTemplate(flow.clientId, answers),
        scope: scopeForCloud(expandFieldTemplate(scope, answers), authorize.graph),
        binding,
    };
};

// Every answer a provider gives here is read for these fields alone; the rest (its `message`, which is server text) is
// never shown.
const AnswerSchema = z.looseObject({
    error: z.string().optional(),
    error_description: z.string().optional(),
    device_code: z.string().optional(),
    user_code: z.string().optional(),
    verification_uri: z.string().optional(),
    expires_in: z.coerce.number().optional(),
    interval: z.coerce.number().optional(),
    refresh_token: z.string().optional(),
    scope: z.string().optional(),
    id_token: z.string().optional(),
});
type Answer = z.infer<typeof AnswerSchema>;

export type Transport = typeof nodeRequest;

const ANSWER_MS = 15_000;

const postForm = async (transport: Transport, url: URL, form: Readonly<Record<string, string>>): Promise<Answer> => {
    const response = await transport(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams(form).toString(),
        signal: AbortSignal.timeout(ANSWER_MS),
        idleMs: ANSWER_MS,
        maxBytes: 64 * 1024,
    });
    return AnswerSchema.safeParse(parseJsonOr(response.body.toString("utf8"), undefined)).data ?? { error: `http_${response.status}` };
};

// Microsoft's own sentence for a refusal, up to its first full stop: the AADSTS code and what it is about, without the
// trace and correlation ids that follow. Nothing secret was sent (a client ID, a scope, a one-time device code).
const theirWords = (answer: Answer): string => {
    const said = (answer.error_description ?? "").split(/\.\s|\r?\n/u)[0]?.trim() ?? "";
    return said === "" ? (answer.error ?? "no answer") : said.slice(0, 240);
};

const refusal = (answer: Answer): string => {
    const error = answer.error ?? "";
    if (error === "invalid_client" || error === "unauthorized_client") {
        return `Microsoft refused the app (${theirWords(answer)}). Check the application (client) ID and the tenant, and that the app allows public client flows.`;
    }
    if (error === "invalid_scope") {
        return `Microsoft refused the permissions asked for (${theirWords(answer)}). Check the app's API permissions.`;
    }
    return `Microsoft refused the sign-in (${theirWords(answer)}).`;
};

// Who the id token names, when the sign-in asked for one (`openid profile`). Read for display only: it came straight
// from the token endpoint over TLS, and nothing is decided on it.
const IdClaimsSchema = z.looseObject({ preferred_username: z.string().optional(), email: z.string().optional(), upn: z.string().optional() });
const idTokenWho = (idToken: string | undefined): string | undefined => {
    const payload = idToken?.split(".")[1];
    if (payload === undefined) {
        return undefined;
    }
    const claims = IdClaimsSchema.safeParse(parseJsonOr(Buffer.from(payload, "base64url").toString("utf8"), undefined)).data;
    return claims?.preferred_username ?? claims?.email ?? claims?.upn;
};

interface Flow {
    readonly plan: DeviceSignInPlan;
    readonly deviceCode: string;
    readonly expiresAt: number;
    interval: number;
    nextAskAt: number;
    // Asks in a row the provider did not answer; a few are a blip, more is the end of the sign-in.
    unanswered: number;
    asking?: Promise<DeviceSignInWait> | undefined;
    // Kept once it ended, so a wait whose answer was lost on the way gets the same one again.
    outcome?: DeviceSignInWait | undefined;
}

export interface DeviceSignInOptions {
    readonly transport?: Transport;
    readonly now?: () => number;
    readonly pause?: (ms: number) => Promise<void>;
    // How long one wait asks before it answers `waiting`; under the proxies' idle cut.
    readonly waitMs?: number;
}

// What every ask needs, the options filled in.
interface Asker {
    readonly stash: SecretStash;
    readonly transport: Transport;
    readonly now: () => number;
    readonly pause: (ms: number) => Promise<void>;
    readonly waitMs: number;
}

const MAX_UNANSWERED = 3;
const EXPIRED = "The code expired before anyone used it. Sign in again.";

// Who signed in: the card's own connection test says it best, since it also proves the token works where the card is
// used; the id token is the fallback for a card with no test.
const whoSignedIn = async (asker: Asker, plan: DeviceSignInPlan, refreshToken: string, idToken: string | undefined): Promise<string | undefined> => {
    const probed = await probeCapability(
        new Map([[`cli:${plan.contribution.spec.id}`, plan.contribution]]),
        { ...plan.capability, config: { ...plan.capability.config, [plan.field]: refreshToken } },
        asker.transport,
    );
    return probed.who ?? idTokenWho(idToken);
};

const signedIn = async (asker: Asker, plan: DeviceSignInPlan, refreshToken: string, answer: Answer): Promise<DeviceSignInWait> => {
    const token = asker.stash.put({ kind: plan.capability.kind, field: plan.field, value: refreshToken, binding: plan.binding });
    const done: Extract<DeviceSignInWait, { state: "done" }> = {
        state: "done",
        token,
        granted: grantedPermissions(answer.scope ?? plan.scope),
        bound: Object.keys(plan.binding).filter((key) => key !== "provider"),
    };
    const who = await whoSignedIn(asker, plan, refreshToken, answer.id_token);
    if (who !== undefined) {
        done.who = who;
    }
    return done;
};

// What a token answer that is not a token means for the sign-in: undefined while the person is still on the page.
const settledBy = (flow: Flow, answer: Answer): DeviceSignInWait | undefined => {
    if (answer.error === "authorization_pending") {
        return undefined;
    }
    if (answer.error === "slow_down") {
        flow.interval += 5_000;
        return undefined;
    }
    if (answer.error === "authorization_declined" || answer.error === "access_denied") {
        return { state: "failed", message: "The sign-in was declined on Microsoft's page." };
    }
    if (answer.error === "expired_token" || answer.error === "code_expired") {
        return { state: "failed", message: EXPIRED };
    }
    return { state: "failed", message: refusal(answer) };
};

// One ask of the provider: an outcome once it has one, undefined while the person is still on its page.
const askOnce = async (asker: Asker, flow: Flow): Promise<DeviceSignInWait | undefined> => {
    let answer: Answer;
    try {
        answer = await postForm(asker.transport, flow.plan.tokenUrl, {
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            client_id: flow.plan.clientId,
            device_code: flow.deviceCode,
        });
    } catch (error) {
        flow.unanswered += 1;
        return flow.unanswered < MAX_UNANSWERED
            ? undefined
            : { state: "failed", message: `Could not reach ${flow.plan.authority}: ${errorMessage(error)}. Sign in again.` };
    }
    flow.unanswered = 0;
    if (answer.error !== undefined) {
        return settledBy(flow, answer);
    }
    const refreshToken = answer.refresh_token ?? "";
    if (refreshToken === "") {
        return { state: "failed", message: "Microsoft signed in but kept the refresh token back: the card must ask for offline_access." };
    }
    return signedIn(asker, flow.plan, refreshToken, answer);
};

// Asks at the provider's own pace until it answers, the code lapses, or this wait has asked for long enough.
const askFor = async (asker: Asker, flow: Flow): Promise<DeviceSignInWait> => {
    const until = asker.now() + asker.waitMs;
    for (;;) {
        const delay = Math.max(0, flow.nextAskAt - asker.now());
        if (asker.now() + delay >= flow.expiresAt) {
            return { state: "failed", message: EXPIRED };
        }
        if (asker.now() + delay >= until) {
            return { state: "waiting" };
        }
        await asker.pause(delay);
        flow.nextAskAt = asker.now() + flow.interval;
        const outcome = await askOnce(asker, flow);
        if (outcome !== undefined) {
            return outcome;
        }
    }
};

// Asks the provider for a code; a refusal says what to fix.
const beginFlow = async (asker: Asker, plan: DeviceSignInPlan): Promise<{ readonly flow: Flow; readonly start: Omit<DeviceSignInStart, "flow"> }> => {
    let answer: Answer;
    try {
        answer = await postForm(asker.transport, plan.authorizeUrl, { client_id: plan.clientId, scope: plan.scope });
    } catch (error) {
        throw refused(`Could not reach ${plan.authority}: ${errorMessage(error)}`);
    }
    const { device_code: deviceCode, user_code: userCode, expires_in: expiresIn } = answer;
    if (answer.error !== undefined || deviceCode === undefined || userCode === undefined || expiresIn === undefined) {
        throw refused(refusal(answer));
    }
    // Opened in the owner's own browser, so only Microsoft's own page is ever handed over.
    const page = microsoftVerificationPage(answer.verification_uri ?? "", plan.authority);
    if (page === undefined) {
        throw refused("Microsoft answered with a sign-in page this sandbox does not recognise");
    }
    const interval = Math.max(1, answer.interval ?? 5) * 1000;
    const at = asker.now();
    return {
        flow: { plan, deviceCode, expiresAt: at + expiresIn * 1000, interval, nextAskAt: at + interval, unanswered: 0 },
        start: { userCode, verificationUri: page, expiresIn },
    };
};

export interface DeviceSignIns {
    readonly start: (registry: ReadonlyMap<string, ResolvedContribution>, capability: Capability) => Promise<DeviceSignInStart>;
    readonly wait: (flow: string) => Promise<DeviceSignInWait>;
}

// More than one person keeps forms open; past it the oldest go first, so a caller that loops cannot grow this.
const FLOW_LIMIT = 16;

// The sign-ins forms have started, in memory only: a restart forgets them, which costs a new code.
export const createDeviceSignIns = (stash: SecretStash, options: DeviceSignInOptions = {}): DeviceSignIns => {
    const asker: Asker = {
        stash,
        transport: options.transport ?? nodeRequest,
        now: options.now ?? Date.now,
        pause: options.pause ?? sleep,
        waitMs: options.waitMs ?? 20_000,
    };
    const flows = new Map<string, Flow>();
    const prune = (): void => {
        for (const [id, flow] of flows) {
            if (flow.expiresAt <= asker.now()) {
                flows.delete(id);
            }
        }
        for (const oldest of [...flows.keys()].slice(0, Math.max(0, flows.size - FLOW_LIMIT + 1))) {
            flows.delete(oldest);
        }
    };
    return {
        start: async (registry, capability) => {
            const { flow, start } = await beginFlow(asker, deviceSignInPlan(registry, capability));
            prune();
            const id = randomBytes(18).toString("base64url");
            flows.set(id, flow);
            return { flow: id, ...start };
        },
        wait: async (id) => {
            prune();
            const flow = flows.get(id);
            if (flow === undefined) {
                return { state: "failed", message: "That sign-in is no longer running: its code lapsed, or the sandbox restarted since. Sign in again." };
            }
            if (flow.outcome !== undefined) {
                return flow.outcome;
            }
            // Two waits on one sign-in (a second tab, a retried request) share one round of asking.
            flow.asking ??= askFor(asker, flow).finally(() => {
                flow.asking = undefined;
            });
            const outcome = await flow.asking;
            if (outcome.state !== "waiting") {
                flow.outcome = outcome;
            }
            return outcome;
        },
    };
};
