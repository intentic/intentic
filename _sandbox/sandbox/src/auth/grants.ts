import { sandboxRouteAllowed } from "@intentic/extension-manifest";
import { tokenEquals } from "./auth.js";
import { type ControlTokens, controlScoped } from "./control-tokens.js";

/* GRANTS, every credential the daemon accepts INSTEAD OF the owner's Google bearer, in one table.
 *
 * There are four, written months apart, and each answered the same three questions in its own way: is this
 * header present, may a holder of this kind reach this route, is the secret real. They diverged the way
 * copies do, two checked scope with a pure function, one inline, and the panel branch never asked at all,
 * which was not a decision so much as the question nobody wrote down that time. A wrong panel token also fell
 * THROUGH to the bearer check while the other three answered 401, so the same mistake had two outcomes
 * depending on which credential you got wrong.
 *
 * The table fixes the shape rather than the four instances: a grant cannot exist without saying what it
 * reaches, and every grant fails the same way.
 *
 * ONE RULE WORTH KNOWING: a non-empty header SELECTS a grant and commits the request to it. Presenting a bad
 * secret is 401, never a quiet fall-through to whatever might authorize behind it. The empty-string check is
 * required and not defensive noise: `tokenEquals("", "")` is true, so a composition that ever produced an
 * empty secret would turn every unauthenticated request into a call by that holder.
 */

export type GrantVerdict = "ok" | "unauthorized" | "out-of-scope";

export interface Grant {
    // The header the holder presents its secret in.
    readonly header: string;
    // How a refusal names it ("bridge token", "sync token"), the credential's name, not the header's, because
    // the person reading the error is holding the former.
    readonly name: string;
    readonly authorize: (presented: string, method: string, path: string) => Promise<GrantVerdict>;
}

/* The shape three of the four share: one secret fixed for the daemon's lifetime, one static allowlist.
 *
 * Scope is checked BEFORE the secret here, deliberately. The two failures have different fixes, "this
 * credential may not go there" versus "your token is wrong", and a holder of the right token hitting the
 * wrong route should be told which one it is. (The control grant below cannot do this, and says why.) */
const fixedSecretGrant = (header: string, name: string, reaches: (method: string, path: string) => boolean, secret: string): Grant => ({
    header,
    name,
    authorize: async (presented, method, path) => {
        if (!reaches(method, path)) {
            return "out-of-scope";
        }
        return tokenEquals(presented, secret) ? "ok" : "unauthorized";
    },
});

// The `vpn`, `otp`, `services`, `capabilities`, `wallet`, `agents` and `secrets` CLIs on the agent's PATH
// (and in the owner's terminals) reach the daemon over loopback with the per-boot agent token. Scoped hard:
// the agent may dial and drop the tunnels the owner configured, may mint one-time codes off a stored TOTP
// seed, each derived, expiring within its period, may browse and run the platform's priced services on the
// owner's credit allowance, may ask the owner to connect a capability, and may ask a NAMED APPROVER to
// release a gated credential; it may never read a VALUE, out of /secrets or the /capabilities REST surface
// itself, which would hand it the credentials behind them.
const agentReach = (method: string, path: string): boolean =>
    path === "/vpn" ||
    path.startsWith("/vpn/") ||
    // The geo-exit surface the `exit` CLI drives: list, catalog, start/move/rotate/check/stop over the pools
    // the owner configured. Same bargain as /vpn, the agent may operate what is already there and can never
    // read the credentials behind it (a pasted WireGuard conf is vaulted like any other capability secret).
    path === "/exit" ||
    path.startsWith("/exit/") ||
    (method === "GET" && /^\/capabilities\/[^/]+\/otp$/.test(path)) ||
    // The capability setup gate the `capabilities` CLI drives: discovery (card ids and names, whether each is
    // connected, never a config or a secret), and the ask, which parks on an owner-decided card in chat
    // before anything is watched for (capabilities/capability-offer.ts). Consent enforced at the route, like
    // the services gate below.
    (method === "GET" && path === "/capabilities/connectable") ||
    (method === "POST" && path === "/capabilities/ask") ||
    // The premium-services surface the `services` CLI drives: the priced catalog, one metered run, and a
    // note onto the platform's wanted list when the catalog had nothing that answered. The spend is bounded
    // by the owner's daily allowance platform-side, and the run itself parks on an owner-approval card
    // before anything is forwarded (platform/service-offer.ts), the consent is enforced at the route, not
    // asked of the model; nothing here reads a secret, and a want spends nothing (the platform caps it).
    (method === "GET" && path === "/pool/services") ||
    (method === "POST" && path === "/pool/wanted") ||
    (method === "POST" && /^\/pool\/services\/[^/]+\/run$/.test(path)) ||
    // The wallet surface the `wallet` CLI drives: what the wallet holds and has left today, one paid fetch,
    // and the payment history. The spend is bounded by the owner's policy caps twice over (the daemon's
    // check at the route, the platform signer's re-check where the key lives), and every payment outside the
    // owner's standing auto-approve band parks on an owner-approval card before anything is signed
    // (wallet/payment-offer.ts), consent enforced at the route, like the services gate above. Nothing here
    // reads a key: the container never holds one.
    (method === "GET" && path === "/wallet/status") ||
    (method === "POST" && path === "/wallet/fetch") ||
    (method === "GET" && path === "/wallet/history") ||
    // The child-agent surface the `agents` CLI drives: start a full agent on any connected provider, park
    // until one needs input, steer or follow-up one, answer a child's QUESTION (never its consent cards:
    // children.ts refuses those by kind), list this conversation's children. The routes refuse a conversation
    // planTurn never armed (children/children.routes.ts), so the persona decision stays where the persona was
    // in hand, and nothing here reads a credential: a child spends the same connected accounts a composer
    // turn would.
    (method === "POST" && path === "/children/spawn") ||
    (method === "POST" && path === "/children/wait") ||
    (method === "POST" && path === "/children/send") ||
    (method === "POST" && path === "/children/answer") ||
    (method === "GET" && path === "/children") ||
    /* THE CREDENTIAL-APPROVAL SURFACE the `secrets` CLI drives, and the ONLY two doors under `/secrets` this
     * token has ever been given. The comment above used to say the agent may never read `/secrets` at all,
     * and the reason it said so still holds for every other route there: they answer with, or write, values.
     *
     * These two answer with NAMES. `gates` lists what is gated and which addresses may release it, which the
     * agent needs for a reason absence created: a gated connected account is withheld from the turn rather
     * than refused inside it, so without this the model cannot tell "needs Bob" from "not connected" and
     * goes looking for another road (secrets/credential-gating.ts). `request` raises the release card and
     * parks — consent is enforced at the route and the identity check is on the reply (agent-requests.ts
     * mayAnswer), so the model can ASK and can never grant itself anything. */
    (method === "GET" && path === "/secrets/gates") ||
    (method === "POST" && path === "/secrets/request");

/* The WIDE grant, a panel's backend is server-side code running inside this container that legitimately acts
 * as the app, and a panel is open-ended (an operator UI the owner or the agent wrote), so enumerating what one
 * may call would be guessing at somebody else's app. It stays broad on purpose.
 *
 * THE CARVE-OUT IS "ROUTES THAT PUT A STORED CREDENTIAL IN MOTION", and there are two of them.
 *
 * `/capabilities/<id>/connection` serves EXTENSION BACKENDS, its whole gate is "no signed-in identity",
 * because the extension token is the only grant that must also declare the route. A panel token also carries
 * no identity, so it satisfied that gate by accident and could read any connected account's config, secrets
 * included: the browser password and the TOTP seed that accounts-tools.ts and the manifest's TOTP rule promise
 * never to hand over. And unlike the extension token, this one is injected into every panel and connector
 * process in the container, where anything that can read /proc can lift it.
 *
 * `/capabilities/probe` is the same disclosure with the direction reversed, which is why it took a second look
 * to see. It does not hand the credential back — it SENDS it. The caller supplies the whole config, a `VAULTED`
 * marker in it is rehydrated from storage before the dial (capabilities.routes.ts withKeptSecrets), and the
 * destination is caller-supplied too: `baseUrl` for an endpoint, `url` for an MCP server, a `${url}` template
 * for a connector's declared probe. So `{"id":"…","kind":"endpoint","config":{"baseUrl":"https://elsewhere",
 * "apiKey":"<vaulted>"}}` makes the daemon present the real key to an address the caller picked, and the ids
 * and secret field names needed to write that body are what `GET /capabilities` already answers. Exfiltration
 * rather than a read, and quieter: nothing appears in the response at all.
 *
 * Costs a panel nothing real. The Test button is a browser action carrying the signed-in owner's bearer, not a
 * panel token, and a panel that wants to know whether a connection works reads its `status`.
 *
 * Written as denied routes rather than an allowlist because that is what the grant IS, everything, except the
 * doors that were never meant for it. An allowlist here would be a fiction the next panel breaks.
 */
const CREDENTIAL_ROUTES = /^\/capabilities\/(?:probe$|[^/]+\/connection$)/;
const panelReach = (_method: string, path: string): boolean => !CREDENTIAL_ROUTES.test(path);

/* The desktop-sync agent's two routes, and it is worth saying why there are two rather than one.
 *
 * It READS the listening-ports list, what port mirroring is driven from (the machine agent's mirror loop reconciles
 * Mutagen forwards against it). Still read-only in the sense that matters: not the ports MUTATIONS, so the agent
 * can learn which ports exist and can never forward one publicly.
 *
 * It WRITES one thing: its own machine report, the folders it syncs into, the ports it got onto localhost, and
 * whether its watcher is alive. That is the half of desktop sync the sandbox has never been able to see (SYNC_DIR
 * is local agent state and never reaches the daemon), so the Desktop sync card could only ever claim a machine
 * was enrolled and point the user at `intentic-machine status` on a terminal for the rest.
 *
 * The write grants nothing back: the report is stored in memory, filed under the enrollment whose token presented
 * it rather than under any name the body claims, and read back only by this sandbox's own collaborators. It does
 * not widen what the agent can LEARN by a single route.
 *
 * It also opens ONE stream: the SSH transport desktop sync runs on (platform/sync-ssh.ts), which is a byte pipe
 * to this container's sshd and nothing else, no host and no port travel with the request. What it reaches
 * there is guarded a second time and independently, by sshd's public-key check against the key this same
 * enrollment installed, so the grant widens the agent's reach by a transport rather than by a capability. */
const SYNC_TRANSPORT = "/system/sync/ssh";

const syncReach = (method: string, path: string): boolean =>
    (method === "GET" && path === "/ports") || (method === "GET" && path === SYNC_TRANSPORT) || (method === "POST" && path === "/system/sync/report");

export interface GrantSources {
    readonly panelToken: string;
    readonly agentToken: string;
    readonly controlTokens: ControlTokens;
    // Passed in rather than imported so this module stays free of platform/ and every grant is testable with
    // a one-line fake.
    /* `checkedIn` says whether THIS request is the agent's watcher doing its rounds (the ports poll, the machine
     * report) as opposed to bytes on the SSH transport, which Mutagen's daemon keeps flowing whether or not the
     * watcher is alive. Only the first kind may refresh the enrollment's heartbeat, see verifySyncToken. */
    readonly verifySync: (presented: string, checkedIn: boolean) => Promise<boolean>;
    // An extension backend's minted per-extension token → the manifest's declared `permissions.daemon`
    // (extensions/backend/backend-supervisor.ts). Unknown token ⇒ undefined ⇒ 401.
    readonly verifyExtension: (presented: string) => { readonly permissions: readonly string[] } | undefined;
}

export const grantsOf = ({ panelToken, agentToken, controlTokens, verifySync, verifyExtension }: GrantSources): readonly Grant[] => [
    fixedSecretGrant("x-intentic-panel", "panel token", panelReach, panelToken),
    fixedSecretGrant("x-intentic-agent", "agent token", agentReach, agentToken),
    {
        /* An extension BACKEND's daemon reach, the minted per-extension token its api.daemon presents
         * (extensions/backend/). Scoped to the manifest's `permissions.daemon` in the same glob grammar the
         * UI half's `permissions.sandbox` uses, so a backend's reach into the core is a declared, reviewable
         * list rather than the all-routes grant the panel token gives a panel. Resolve-then-scope like the
         * control grant, and for the same reason: which routes are in reach is stored with the token. */
        header: "x-intentic-extension",
        name: "extension token",
        authorize: async (presented, method, path) => {
            const grant = verifyExtension(presented);
            if (grant === undefined) {
                return "unauthorized";
            }
            return sandboxRouteAllowed(grant.permissions, method, path) ? "ok" : "out-of-scope";
        },
    },
    {
        header: "x-intentic-control",
        name: "control token",
        authorize: async (presented, method, path) => {
            /* Resolve BEFORE scoping, unavoidably: a control token's reach is stored WITH it, so there is no
             * scope to check until we know which token this is. That inverts the order the grants above use,
             * and the inversion is free, it also leaks less, since an unknown token now gets the same answer
             * for every route instead of a map of which ones exist. */
            const scope = await controlTokens.scopeOf(presented);
            if (scope === undefined) {
                return "unauthorized";
            }
            return controlScoped(scope, method, path) ? "ok" : "out-of-scope";
        },
    },
    {
        header: "x-intentic-sync",
        name: "sync token",
        authorize: async (presented, method, path) => {
            if (!syncReach(method, path)) {
                return "out-of-scope";
            }
            // The transport is not a check-in: it is a pipe Mutagen holds open on its own schedule (see
            // verifySyncToken). The two polling routes are the watcher's own, and they are what the card's
            // "Syncing from X, just now" is entitled to be built on.
            return (await verifySync(presented, path !== SYNC_TRANSPORT)) ? "ok" : "unauthorized";
        },
    },
];
