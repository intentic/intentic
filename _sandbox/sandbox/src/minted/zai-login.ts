import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { MintedCredential, MintedLoginAttempt, MintedLoginContext, MintedLoginDriver } from "./minted-login.js";

/* Z.AI'S SIGN-IN: the ZCode flow on either estate, then the provisioning that turns its token into a
 * coding-plan key.
 *
 * Like Meta's, the token the sign-in issues is not an inference credential (Z.ai's model endpoint answers it
 * with `1004`), and the official ZCode client's answer is to provision the plan's own API key through the
 * business API. That is `mintKey` below, and it is the longest thing in this file for a reason worth stating:
 * it walks four calls (whose organisation, whose project, does the key exist, copy its secret) and every one of
 * them is a step a user could be told about. So each failure names the step, because "sign-in failed" after a
 * successful sign-in is the least useful sentence available — the person approved a page and something on OUR
 * side of the approval did not work.
 *
 * TWO ESTATES, TWO SHAPES OF ARRIVAL, one provisioning.
 *
 *   international , zcode.z.ai mediates the whole thing: init hands back an authorize URL and a flow id, and
 *                   the callback lands on the vendor's own server, so we poll it. Nothing dead-ends and there
 *                   is nothing to paste.
 *   BigModel      , refuses that mediated callback and takes a LOOPBACK redirect instead. Nothing here binds
 *                   that port and nothing needs to: the address is unreachable from the user's browser, so the
 *                   page dead-ends with the grant in the address bar and they bring it back. Google's flow
 *                   exactly, which is why it renders through the panel already built for that.
 *
 * The estate also decides who authorizes the business API: internationally an extra login call swaps the OAuth
 * token for a business one, while BigModel's OAuth token is accepted directly. */

export interface ZaiLoginHosts {
    // The ZCode CLI OAuth root (init, poll, token), which serves both estates.
    readonly oauthBase: string;
    // Where the international estate's business API and its Anthropic endpoint live.
    readonly zaiBiz: string;
    // The mainland estate's business API. Its inference host is a different name again
    // (open.bigmodel.cn), which is why the endpoint bases live on the provider table and not here.
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

/* THE REDIRECT NOBODY BINDS. BigModel needs a loopback redirect_uri, and it has to be the SAME string at the
 * authorize and the exchange, which is all it has to be: the browser that lands there is on somebody's laptop,
 * this daemon is in a container, and no port either of them could open would connect the two. So the page
 * dead-ends, which is the state the connect panel draws a picture of, and the grant travels back as a paste.
 * A fixed port rather than an allocated one, because allocating one would imply something is listening. */
const LOOPBACK_REDIRECT = "http://127.0.0.1:8317/callback";
// ZCode's own app id on the mainland sign-in page: the estate's login only issues a grant for a client it
// knows, and this is the client that terminal sign-ins are for.
const BIGMODEL_APP_ID = "zcode";

// The client-generated bearer that a ZCode flow is polled with. 32 random bytes, hex, which is what the
// official client sends: the endpoint refuses a token of another shape outright (`3004 invalid_flow`), so the
// size is a wire fact and not a taste.
const POLL_TOKEN_BYTES = 32;

// The floor for polling the mediated flow, used when the server advertises nothing. It advertises 2 seconds.
const MIN_POLL_INTERVAL_MS = 2_000;
// How many consecutive transient poll failures are tolerated before the sign-in is given up on. The
// authorization window is minutes long, so a blip in the middle of it is likely and is not an answer.
const MAX_CONSECUTIVE_POLL_ERRORS = 5;
// How long to wait for a mainland grant to be pasted back, when the vendor publishes no deadline of its own.
const REDIRECT_WINDOW_MS = 10 * 60_000;
// One control request. Same reasoning as Meta's: generous for a cold edge, bounded so a hung socket cannot hold
// a poll tick open past the next one.
const REQUEST_TIMEOUT_MS = 30_000;
// The exchange the mainland estate answers with a transient `2007 http error` while it validates a code with
// BigModel. Worth retrying a few times rather than failing a sign-in the user completed correctly.
const EXCHANGE_ATTEMPTS = 3;

// The name the provisioned key carries in the vendor's own dashboard. The official client uses this exact name,
// so signing in again reuses the key it already made instead of littering the account with new ones.
const MINT_KEY_NAME = "zcode-api-key";
/* WHICH ORGANISATION AND PROJECT the key is made in. An account can hold several, and the vendor's own default
 * pair is named this in both estates' UIs — so a name match wins, and the first entry that actually has a
 * project is the fallback. Matching on a vendor's display string is not lovely, and it is what the official
 * client does; the alternative is minting into whichever organisation an API happened to list first, which is
 * the kind of choice a user finds out about from a bill. */
const DEFAULT_ORG_NAME = "默认机构";
const DEFAULT_PROJECT_NAME = "默认项目";

// The `{code, msg, data}` envelope every ZCode and business call answers in. `0` and `200` both mean success:
// the two roots disagree and both are in use.
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

/* One call, envelope unwrapped, with the vendor's own `msg` carried into the error. Both roots answer business
 * errors with HTTP 200 and a non-zero code, so a caller that only checked the status would read a refusal as
 * data. */
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

/* WHAT ONE POLL ANSWER MEANT. Pulled out of the loop for the same reason Meta's is: the loop is then about
 * waiting, and this is about the vendor's vocabulary — `pending` and a blank status are the same thing (keep
 * waiting), `failed` is the person declining on the page, a `ready` without a token is the vendor contradicting
 * itself, and an unknown status is worth saying out loud rather than treating as either. */
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

/* THE INTERNATIONAL FLOW. The poll token is minted here and sent as the bearer on both calls: it is what ties a
 * poll to the flow that issued it, and the server answers with its own copy, which is the authoritative one. */
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
                /* A REFUSAL MID-WINDOW IS USUALLY A BLIP, not an answer: the user has minutes to approve a page
                 * and the network has that long to hiccup. Five in a row is a flow that is genuinely gone, and
                 * the last error is the one worth reporting. */
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
                // Internationally the OAuth token has to be swapped for a business one first; the swap lives
                // with the estate that needs it.
                exchangeForBusinessToken: true,
                oauthBase: hosts.oauthBase,
            });
        }
        throw new Error("The Z.ai sign-in expired before it was approved: start it again.");
    };

    return { url: authorize_url, code: "", state: "", expiresAt, settle };
};

/* THE MAINLAND FLOW. No init call: the sign-in page takes the redirect, the app id and a state we generate, and
 * the grant comes back through the user's clipboard. The state is what makes a pasted address identifiable as
 * this attempt's — checked against our own copy, in minted-login.ts, never against a value the caller sends. */
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

// Swap a pasted mainland grant for the estate's access token. Retried, because this endpoint answers with a
// transient error of its own while it validates the code upstream, and the user has already done their part.
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

/* PROVISION THE PLAN'S OWN KEY. Four calls, each named in its own failure, and the whole reason the sign-in can
 * end with something a turn can use.
 *
 * The final credential is `"<apiKey>.<secretKey>"` on the international estate, which is the form its Anthropic
 * endpoint expects. The mainland estate hands back a usable bare key when it will not copy a secret, so the
 * secret is required on one and optional on the other — the one asymmetry in this file that is genuinely the
 * vendors' and not ours. */
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

/* WHERE THIS ACCOUNT'S KEYS LIVE, as a URL, which takes two facts nobody signing in was asked for: an
 * organisation and a project. Both failures are worth their own sentence — no organisation at all is what an
 * account with no active plan looks like, and an organisation with no project is a shape the vendor's console
 * can produce and this cannot fix. */
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

// Who the business API takes its orders from on this estate: a swapped business token internationally, the
// OAuth token itself on the mainland. Sent verbatim, which is why the two shapes are built here rather than at
// each call.
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

// The organisation to provision in: the vendor's default among those that have a project, else the first that
// has one, else the first at all — so the "no project" failure above reports the account's real state rather
// than an empty organisation that happened to be listed first.
const pickOrganization = <T extends { organizationName: string; projects: readonly unknown[] }>(organizations: readonly T[]): T | undefined => {
    const withProjects = organizations.filter((entry) => entry.projects.length > 0);
    return withProjects.find((entry) => entry.organizationName.includes(DEFAULT_ORG_NAME)) ?? withProjects[0] ?? organizations[0];
};

/* The key the official client would have made, or a new one. Finding it first is what stops a sandbox that
 * signs in twice from leaving a trail of identical keys in somebody's dashboard — and it is why the name
 * matters: it is the handle both clients agree on. */
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

// The secret half. Absent is tolerated here and refused by the caller's estate rule, because only the
// international endpoint requires the pair.
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
