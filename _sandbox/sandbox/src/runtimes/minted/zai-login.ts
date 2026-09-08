import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { MintedCredential, MintedLoginAttempt, MintedLoginContext, MintedLoginDriver } from "./minted-login.js";

// Z.ai's sign-in: the ZCode flow on either estate, then provisioning (mintKey) that turns its token, not an inference
// credential, into a coding-plan key via the business API. Two estates, two arrivals: international is mediated and
// polled to completion (zcode.z.ai); BigModel uses a loopback redirect the user pastes back instead. The estate also
// decides who authorizes the business API: a login call swaps the OAuth token internationally, BigModel's is accepted
// directly.

export interface ZaiLoginHosts {
    // The ZCode CLI OAuth root (init, poll, token), which serves both estates.
    readonly oauthBase: string;
    // Where the international estate's business API and its Anthropic endpoint live.
    readonly zaiBiz: string;
    // The mainland estate's business API; its inference host (open.bigmodel.cn) is a different name, kept on the
    // provider table instead.
    readonly bigModelBiz: string;
    // The mainland sign-in page the browser is sent to.
    readonly bigModelLogin: string;
}

export const ZAI_LOGIN_HOSTS: ZaiLoginHosts = {
    oauthBase: "https://zcode.z.ai/api/v1",
    zaiBiz: "https://api.z.ai",
    bigModelBiz: "https://bigmodel.cn",
    bigModelLogin: "https://bigmodel.cn/login",
};

// BigModel's redirect_uri needs to be the same string at authorize and exchange, nothing more; nobody binds this port,
// so the page dead-ends and the grant comes back as a paste. Fixed, not allocated, since allocating would imply
// something is listening.
const LOOPBACK_REDIRECT = "http://127.0.0.1:8317/callback";
// ZCode's own app id: the mainland login only issues a grant to a client it recognizes.
const BIGMODEL_APP_ID = "zcode";

// 32 random bytes, hex: the endpoint refuses a token of another shape outright (`3004 invalid_flow`), so the size is a
// wire fact, not a preference.
const POLL_TOKEN_BYTES = 32;

// The floor for polling the mediated flow, used when the server advertises nothing. It advertises 2 seconds.
const MIN_POLL_INTERVAL_MS = 2_000;
// Consecutive transient poll failures tolerated before giving up; the authorization window is minutes long, so a blip
// is likely.
const MAX_CONSECUTIVE_POLL_ERRORS = 5;
// How long to wait for a mainland grant to be pasted back, when the vendor publishes no deadline of its own.
const REDIRECT_WINDOW_MS = 10 * 60_000;
// One control request; generous for a cold edge, bounded so a hung socket cannot hold a poll tick open past the next
// one.
const REQUEST_TIMEOUT_MS = 30_000;
// The mainland exchange can answer with a transient `2007 http error` while it validates the code; worth retrying.
const EXCHANGE_ATTEMPTS = 3;

// The name the provisioned key carries in the vendor's own dashboard; the official client reuses this exact name
// instead of littering the account with new ones.
const MINT_KEY_NAME = "zcode-api-key";
// The vendor's own default org/project name in both estates' UIs; a name match wins, else the first entry with a
// project. Matching a display string isn't lovely, but the alternative is a silent pick a user finds out about from a
// bill.
const DEFAULT_ORG_NAME = "默认机构";
const DEFAULT_PROJECT_NAME = "默认项目";

// The {code, msg, data} envelope every ZCode and business call answers in. 0 and 200 both mean success: the two roots
// disagree and both are in use.
const EnvelopeSchema = z.object({ code: z.number().default(0), msg: z.string().default(""), data: z.unknown().optional() });

const InitSchema = z.object({
    flow_id: z.string().min(1),
    poll_token: z.string().default(""),
    authorize_url: z.string().min(1),
    expires_at: z.number().default(0),
    poll_interval_sec: z.number().default(2),
});

const PollSchema = z.object({
    status: z.string().default(""),
    token: z.string().default(""),
    user: z.object({ email: z.string().default(""), name: z.string().default("") }).default({ email: "", name: "" }),
    zai: z.object({ access_token: z.string().default("") }).default({ access_token: "" }),
});

const ExchangeSchema = z.object({
    token: z.string().default(""),
    user: z.object({ email: z.string().default(""), name: z.string().default("") }).default({ email: "", name: "" }),
    zai: z.object({ access_token: z.string().default("") }).default({ access_token: "" }),
    bigmodel: z.object({ access_token: z.string().default("") }).default({ access_token: "" }),
});

const CustomerInfoSchema = z.object({
    organizations: z
        .array(
            z.object({
                organizationId: z.string().default(""),
                organizationName: z.string().default(""),
                projects: z.array(z.object({ projectId: z.string().default(""), projectName: z.string().default("") })).default([]),
            }),
        )
        .default([]),
});

const ApiKeyListSchema = z.array(z.object({ name: z.string().default(""), apiKey: z.string().default("") }));
const ApiKeySchema = z.object({ apiKey: z.string().default("") });
const ApiKeyCopySchema = z.object({ secretKey: z.string().default("") });

// What a completed sign-in knows before anything is provisioned: the tokens, and whoever it was.
interface ZaiIdentity {
    readonly token: string;
    readonly accessToken: string;
    readonly email: string;
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
        signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
        }, { once: true });
    });

// Unwraps the envelope, carrying the vendor's own `msg` into the error: both roots answer business errors with HTTP 200
// and a non-zero code, so a status check alone would read a refusal as data.
const envelope = async (input: {
    readonly fetchImpl: typeof fetch;
    readonly url: string;
    readonly method: "GET" | "POST";
    readonly authorization?: string;
    readonly body?: unknown;
    readonly step: string;
}): Promise<unknown> => {
    const response = await input
        .fetchImpl(input.url, {
            method: input.method,
            headers: {
                accept: "application/json",
                ...(input.body === undefined ? {} : { "content-type": "application/json" }),
                ...(input.authorization === undefined ? {} : { authorization: input.authorization }),
            },
            ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
        .catch((error: unknown) => {
            throw new Error(`Z.ai could not be reached (${input.step}).`, { cause: error });
        });
    const parsed = EnvelopeSchema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) {
        throw new Error(`Z.ai answered ${input.step} with something this sandbox could not read (${response.status}).`);
    }
    if (parsed.data.code !== 0 && parsed.data.code !== 200) {
        throw new Error(`Z.ai refused ${input.step}: ${parsed.data.msg !== "" ? parsed.data.msg : `error ${parsed.data.code}`}`);
    }
    return parsed.data.data;
};

// One poll answer's meaning, pulled out of the loop so the loop is only about waiting. `pending`/blank means keep
// waiting, `failed` is a decline, `ready` with no token is the vendor contradicting itself, and an unknown status is
// surfaced rather than guessed at.
type ZaiPollVerdict = { readonly kind: "pending" } | { readonly kind: "ready"; readonly identity: ZaiIdentity } | { readonly kind: "failed"; readonly message: string };

const verdictOf = (poll: z.infer<typeof PollSchema> | undefined): ZaiPollVerdict => {
    if (poll === undefined || poll.status === "pending" || poll.status === "") {
        return { kind: "pending" };
    }
    if (poll.status === "failed") {
        return { kind: "failed", message: "The Z.ai sign-in was declined or failed on the page." };
    }
    if (poll.status !== "ready") {
        return { kind: "failed", message: `Z.ai's sign-in answered with an unexpected status (${poll.status}).` };
    }
    if (poll.token === "") {
        return { kind: "failed", message: "Z.ai reported the sign-in as complete but sent no token." };
    }
    return { kind: "ready", identity: { token: poll.token, accessToken: poll.zai.access_token, email: poll.user.email } };
};

export const zaiLoginDriver =
    (hosts: ZaiLoginHosts = ZAI_LOGIN_HOSTS): MintedLoginDriver =>
    async (context: MintedLoginContext): Promise<MintedLoginAttempt> =>
        context.variant.flow === "redirect" ? startBigModel(context, hosts) : startMediated(context, hosts);

// International flow: the poll token is minted here and sent as bearer on both calls, tying a poll to the flow that
// issued it; the server's own copy, when it sends one, is authoritative.
const startMediated = async (context: MintedLoginContext, hosts: ZaiLoginHosts): Promise<MintedLoginAttempt> => {
    const { fetchImpl, signal, variant } = context;
    const pollToken = randomBytes(POLL_TOKEN_BYTES).toString("hex");
    const data = await envelope({
        fetchImpl,
        url: `${hosts.oauthBase}/oauth/cli/init`,
        method: "POST",
        authorization: `Bearer ${pollToken}`,
        body: { provider: variant.id },
        step: "starting the sign-in",
    });
    const init = InitSchema.safeParse(data);
    if (!init.success) {
        throw new Error("Z.ai's sign-in answered with no page to open.");
    }
    const { flow_id, authorize_url, expires_at, poll_interval_sec } = init.data;
    const bearer = init.data.poll_token !== "" ? init.data.poll_token : pollToken;
    const expiresAt = expires_at > 0 ? expires_at * 1_000 : Date.now() + REDIRECT_WINDOW_MS;

    const settle = async (): Promise<MintedCredential> => {
        const intervalMs = Math.max(MIN_POLL_INTERVAL_MS, poll_interval_sec * 1_000);
        let consecutiveErrors = 0;
        while (Date.now() < expiresAt) {
            await sleep(intervalMs, signal);
            if (signal.aborted) {
                throw new Error("The Z.ai sign-in was abandoned.");
            }
            let poll: z.infer<typeof PollSchema> | undefined;
            try {
                const parsed = PollSchema.safeParse(
                    await envelope({
                        fetchImpl,
                        url: `${hosts.oauthBase}/oauth/cli/poll/${encodeURIComponent(flow_id)}`,
                        method: "GET",
                        authorization: `Bearer ${bearer}`,
                        step: "waiting for the sign-in",
                    }),
                );
                poll = parsed.success ? parsed.data : undefined;
            } catch (error) {
                // A refusal mid-window is usually a network blip, not an answer, since the user has minutes to approve;
                // five in a row means the flow is genuinely gone.
                consecutiveErrors += 1;
                if (consecutiveErrors >= MAX_CONSECUTIVE_POLL_ERRORS) {
                    throw error;
                }
                continue;
            }
            consecutiveErrors = 0;
            const verdict = verdictOf(poll);
            if (verdict.kind === "pending") {
                continue;
            }
            if (verdict.kind === "failed") {
                throw new Error(verdict.message);
            }
            return await mintKey({
                fetchImpl,
                host: hosts.zaiBiz,
                estate: variant.label,
                identity: verdict.identity,
                // Internationally the OAuth token has to be swapped for a business one first; the swap lives with the
                // estate that needs it.
                exchangeForBusinessToken: true,
                oauthBase: hosts.oauthBase,
            });
        }
        throw new Error("The Z.ai sign-in expired before it was approved: start it again.");
    };

    return { url: authorize_url, code: "", state: "", expiresAt, settle };
};

// Mainland flow: no init call, the sign-in page takes the redirect/app id/a generated state, and the grant comes back
// through the user's clipboard. The state makes a pasted address identifiable as this attempt's, checked against our
// own copy in minted-login.ts.
const startBigModel = async (context: MintedLoginContext, hosts: ZaiLoginHosts): Promise<MintedLoginAttempt> => {
    const { fetchImpl, variant } = context;
    const state = randomBytes(POLL_TOKEN_BYTES).toString("hex");
    const url = `${hosts.bigModelLogin}?${new URLSearchParams({ redirect: LOOPBACK_REDIRECT, appId: BIGMODEL_APP_ID, state }).toString()}`;

    const settle = async (): Promise<MintedCredential> => {
        const code = await context.grant();
        const identity = await exchangeBigModelCode({ fetchImpl, hosts, code, state });
        return await mintKey({
            fetchImpl,
            host: hosts.bigModelBiz,
            estate: variant.label,
            identity,
            // BigModel's own OAuth token authorizes the business API directly, so there is nothing to swap.
            exchangeForBusinessToken: false,
            oauthBase: hosts.oauthBase,
        });
    };

    return { url, code: "", state, expiresAt: Date.now() + REDIRECT_WINDOW_MS, settle };
};

// Swaps a pasted mainland grant for the estate's access token; retried, since this endpoint can answer with its own
// transient error while validating the code upstream.
const exchangeBigModelCode = async (input: {
    readonly fetchImpl: typeof fetch;
    readonly hosts: ZaiLoginHosts;
    readonly code: string;
    readonly state: string;
}): Promise<ZaiIdentity> => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= EXCHANGE_ATTEMPTS; attempt += 1) {
        try {
            const data = await envelope({
                fetchImpl: input.fetchImpl,
                url: `${input.hosts.oauthBase}/oauth/token`,
                method: "POST",
                body: { provider: "bigmodel", code: input.code, redirect_uri: LOOPBACK_REDIRECT, state: input.state },
                step: "redeeming the sign-in",
            });
            const parsed = ExchangeSchema.safeParse(data);
            if (!parsed.success) {
                throw new Error("Z.ai answered the sign-in with no token.");
            }
            const accessToken = parsed.data.bigmodel.access_token !== "" ? parsed.data.bigmodel.access_token : parsed.data.zai.access_token;
            const token = parsed.data.token !== "" ? parsed.data.token : accessToken;
            if (token === "" && accessToken === "") {
                throw new Error("Z.ai answered the sign-in with no token.");
            }
            return { token, accessToken, email: parsed.data.user.email };
        } catch (error) {
            lastError = error;
        }
    }
    throw lastError instanceof Error ? lastError : new Error("Z.ai would not redeem that sign-in.");
};

// Four calls, each named in its own failure. The final credential is `<apiKey>.<secretKey>` internationally (what its
// Anthropic endpoint expects); the mainland estate's bare key is usable alone, the one asymmetry that's the vendors',
// not ours.
const mintKey = async (input: {
    readonly fetchImpl: typeof fetch;
    readonly host: string;
    readonly estate: string;
    readonly identity: ZaiIdentity;
    readonly exchangeForBusinessToken: boolean;
    readonly oauthBase: string;
}): Promise<MintedCredential> => {
    const authorization = await businessAuthorization(input);
    const keysUrl = await resolveKeysUrl({ fetchImpl: input.fetchImpl, host: input.host, estate: input.estate, authorization });
    const apiKey = await findOrCreateKey({ fetchImpl: input.fetchImpl, keysUrl, authorization });
    const secretKey = await copySecret({ fetchImpl: input.fetchImpl, keysUrl, authorization, apiKey });
    return {
        apiKey: secretKey === "" ? apiKey : `${apiKey}.${secretKey}`,
        ...(input.identity.email !== "" ? { email: input.identity.email } : {}),
    };
};

// Resolves the account's keys URL from an organisation and project nobody signing in was asked for. No organisation
// means no active plan; an organisation with no project is a console-made shape this can't fix, so both get their own
// error.
const resolveKeysUrl = async (input: {
    readonly fetchImpl: typeof fetch;
    readonly host: string;
    readonly estate: string;
    readonly authorization: string;
}): Promise<string> => {
    const info = CustomerInfoSchema.safeParse(
        await envelope({
            fetchImpl: input.fetchImpl,
            url: `${input.host}/api/biz/customer/getCustomerInfo`,
            method: "GET",
            authorization: input.authorization,
            step: "reading the account",
        }),
    );
    if (!info.success || info.data.organizations.length === 0) {
        throw new Error(`Signed in, but that ${input.estate} account has no organisation: is the GLM Coding Plan active on it?`);
    }
    const organization = pickOrganization(info.data.organizations);
    const project = organization?.projects.find((entry) => entry.projectName.includes(DEFAULT_PROJECT_NAME)) ?? organization?.projects[0];
    if (organization === undefined || project === undefined || organization.organizationId === "" || project.projectId === "") {
        throw new Error(`Signed in, but no project could be found on that ${input.estate} account to make a key in.`);
    }
    const organizationPath = encodeURIComponent(organization.organizationId);
    return `${input.host}/api/biz/v1/organization/${organizationPath}/projects/${encodeURIComponent(project.projectId)}/api_keys`;
};

// Who the business API takes orders from on this estate: a swapped business token internationally, the OAuth token
// itself on the mainland, sent verbatim.
const businessAuthorization = async (input: {
    readonly fetchImpl: typeof fetch;
    readonly host: string;
    readonly identity: ZaiIdentity;
    readonly exchangeForBusinessToken: boolean;
}): Promise<string> => {
    if (!input.exchangeForBusinessToken) {
        const token = input.identity.accessToken !== "" ? input.identity.accessToken : input.identity.token;
        if (token === "") {
            throw new Error("Signed in, but the sign-in carried no token to provision a key with.");
        }
        return token;
    }
    const data = await envelope({
        fetchImpl: input.fetchImpl,
        url: `${input.host}/api/auth/z/login`,
        method: "POST",
        body: { token: input.identity.accessToken },
        step: "signing in to the Z.ai console",
    });
    const parsed = z.object({ access_token: z.string().default("") }).safeParse(data);
    if (!parsed.success || parsed.data.access_token === "") {
        throw new Error("Signed in, but Z.ai would not open the console session a key is made through.");
    }
    return `Bearer ${parsed.data.access_token}`;
};

// The vendor's default org among those with a project, else the first with one, else the first at all, so the "no
// project" failure reports the account's real state.
const pickOrganization = <T extends { organizationName: string; projects: readonly unknown[] }>(organizations: readonly T[]): T | undefined => {
    const withProjects = organizations.filter((entry) => entry.projects.length > 0);
    return withProjects.find((entry) => entry.organizationName.includes(DEFAULT_ORG_NAME)) ?? withProjects[0] ?? organizations[0];
};

// Finds the key the official client would have made before minting a new one, so signing in twice doesn't litter the
// dashboard; the fixed name is the handle both clients agree on.
const findOrCreateKey = async (input: { readonly fetchImpl: typeof fetch; readonly keysUrl: string; readonly authorization: string }): Promise<string> => {
    const listed = await envelope({
        fetchImpl: input.fetchImpl,
        url: input.keysUrl,
        method: "GET",
        authorization: input.authorization,
        step: "listing the account's keys",
    }).catch(() => undefined);
    const keys = ApiKeyListSchema.safeParse(listed);
    const existing = keys.success ? keys.data.find((entry) => entry.name === MINT_KEY_NAME)?.apiKey : undefined;
    if (existing !== undefined && existing !== "") {
        return existing;
    }
    const created = ApiKeySchema.safeParse(
        await envelope({
            fetchImpl: input.fetchImpl,
            url: input.keysUrl,
            method: "POST",
            authorization: input.authorization,
            body: { name: MINT_KEY_NAME },
            step: "making this sandbox's key",
        }),
    );
    if (!created.success || created.data.apiKey === "") {
        throw new Error("Signed in, but Z.ai issued no key for that plan.");
    }
    return created.data.apiKey;
};

// The secret half. Absent is tolerated here and refused by the caller's estate rule, since only the international
// endpoint requires the pair.
const copySecret = async (input: {
    readonly fetchImpl: typeof fetch;
    readonly keysUrl: string;
    readonly authorization: string;
    readonly apiKey: string;
}): Promise<string> => {
    const copied = await envelope({
        fetchImpl: input.fetchImpl,
        url: `${input.keysUrl}/copy/${encodeURIComponent(input.apiKey)}`,
        method: "GET",
        authorization: input.authorization,
        step: "reading this sandbox's key",
    }).catch(() => undefined);
    const parsed = ApiKeyCopySchema.safeParse(copied);
    return parsed.success ? parsed.data.secretKey : "";
};
