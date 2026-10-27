import { PlatformIdentitySchema } from "@intentic/api-contract";
import { ingressPath, type BrowsingCatalog } from "@intentic/api-contract/ingress";
import { NATIVE_PROVIDERS } from "@intentic/sandbox-contract/models/provider-specs";
import { DEMO_CATALOGS } from "./daemon/account/accounts";
import { signedOut } from "./mode";
import { hostedPlanAnswers } from "./platform/billing.handler";
import { desktopAnswers } from "./platform/desktop.handler";
import { inviteAnswers, meAnswers } from "./platform/people.handler";
import { orgAnswers } from "./platform/orgs.handler";
import { pushAnswers } from "./platform/pushRelay.handler";
import { sandboxAnswers } from "./platform/sandbox.handler";
import { tokenAnswers, walletAnswers } from "./platform/keys.handler";
import { type PlatformRouter, platformRouteOf, servePlatform } from "./platform/serve";
import { platformUnservedReason } from "./platform/platformUnserved";
import { json } from "./transport";
import { DEMO_USER } from "./world/account";

// THE PLATFORM'S ANSWERS. Every procedure is held to the api contract's own types (platform/serve.ts), the account's
// sandboxes are live state (world/sandboxRegistry.ts) and their machines are played (world/machines.ts), so a sandbox made,
// renamed, deleted or restored here stays that way until the page reloads. platform/platformUnserved.ts lists every procedure
// not answered here, with its reason, and the typecheck holds that list to the contract both ways.

// The account and its first sandbox, for the modules that read them as the platform's (main.ts, floors.ts, the roster).
export { DEMO_SANDBOX, DEMO_SANDBOXES, DEMO_USER } from "./world/account";

const SESSION = {
    session: { id: `demo-session`, userId: DEMO_USER.id, expiresAt: new Date(Date.now() + 30 * 24 * 3_600_000).toISOString() },
    user: DEMO_USER,
};

// When the demo's platform database was given its identity: when this page loaded, since a reload starts it afresh.
const PLATFORM_SINCE = new Date().toISOString();

const ANSWERS = {
    me: meAnswers,
    token: tokenAnswers,
    sandbox: sandboxAnswers,
    invite: inviteAnswers,
    desktop: desktopAnswers,
    hostedPlan: hostedPlanAnswers,
    wallet: walletAnswers,
    org: orgAnswers,
    push: pushAnswers,
} satisfies PlatformRouter;

/** The procedures the platform answers, as served; platform/platformUnserved.ts reads its type to hold its list to the contract. */
export const PLATFORM_ANSWERS = ANSWERS;

const answer = servePlatform(ANSWERS);

// The public model browsing feed, from the same catalogs the fake daemon serves.
const browsingCatalog = (): BrowsingCatalog => ({
    catalogs: NATIVE_PROVIDERS.flatMap((provider) => {
        const models = DEMO_CATALOGS[provider]?.models ?? [];
        return models.length === 0 ? [] : [{ provider, verifiedAt: Date.now(), models: models.map(({ id, label }) => ({ id, label })) }];
    }),
});

export const platform = async (request: Request, url: URL): Promise<Response> => {
    if (url.pathname === ingressPath(`modelCatalog`)) {
        return json(browsingCatalog());
    }
    const path = url.pathname;
    // Which database this platform reads (features/sandbox/recovery/rememberSandboxes.ts): one, for as long as the page lives.
    if (path === `/api/identity`) {
        return json(PlatformIdentitySchema.parse({ identity: `demo-platform`, since: PLATFORM_SINCE }));
    }
    if (path.startsWith(`/api/auth/`)) {
        // Only get-session matters; others must not 404 or better-auth reads it as signed-out.
        return json(path.endsWith(`/get-session`) ? (signedOut ? null : SESSION) : { ok: true });
    }
    const answered = await answer(request, url);
    if (answered !== undefined) {
        return answered;
    }
    console.info(`[demo] the platform's ${request.method} ${path} is left out: ${platformUnservedReason(platformRouteOf(request, url)) ?? `not a route of the api contract`}`);
    return json({ message: `The demo doesn't serve ${path}.` }, 404);
};
