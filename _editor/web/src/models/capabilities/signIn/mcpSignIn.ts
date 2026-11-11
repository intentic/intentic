import type { CapabilityCatalogEntry } from "@intentic/capability-catalog";
import type { CapabilityField } from "@intentic/extension-manifest";
import { type CapabilitySummary, stashedMarker } from "@intentic/sandbox-contract/schemas/capabilities";
import type { McpAuthCheck, McpSignInStart, McpSignInWait } from "@intentic/sandbox-contract/schemas/mcp-sign-in";
import { messageOr } from "@intentic/ui/async";
import { t } from "@intentic/ui/i18n";
import { computed, onScopeDispose, ref, shallowRef, watch } from "vue";
import { z } from "zod";
import { sandboxRpc } from "../../../client/sandbox/sandboxRpc";

// Sign in to a remote MCP server, as the Custom MCP server form drives it. The sandbox asks the URL what it needs as it
// is typed; a server that names an OAuth sign-in gets a Sign in button in place of the token box. The sandbox registers
// itself with the server's authorization server, the person approves in a window of that server's own, and the browser
// lands back on the sandbox, never here. What the form gets is a stash marker for the token field: the tokens stay in
// the sandbox, which renews them, and the ordinary Save installs the sign-in as a generated SSH key's private half is.

// What a sign-in is started with: the address, a client ID made by hand where the server registers none, and the
// connection being edited, whose registered client the sandbox reuses.
export interface McpSignInAsk {
    readonly url: string;
    readonly clientId?: string | undefined;
    readonly keeping?: string | undefined;
}

export interface McpSignInCalls {
    readonly check: (url: string) => Promise<McpAuthCheck>;
    readonly start: (input: McpSignInAsk) => Promise<McpSignInStart>;
    readonly wait: (flow: string) => Promise<McpSignInWait>;
}

export const SANDBOX_MCP_CALLS: McpSignInCalls = {
    check: (url) => sandboxRpc.capabilities.mcpAuth({ url }),
    start: (input) => sandboxRpc.capabilities.mcpSignIn(input),
    wait: (flow) => sandboxRpc.capabilities.mcpSignInWait({ flow }),
};

// Long enough that a URL being typed is asked about once it is whole, not once per keystroke.
const SETTLE_MS = 600;

const askable = (url: string | undefined): url is string => {
    const parsed = url === undefined ? null : URL.parse(url.trim());
    return parsed !== null && (parsed.protocol === `https:` || parsed.protocol === `http:`);
};

// What the address in the form asks of a client, read once it settles: the answer for the address as it is now, or
// undefined while it is being typed or asked. `pasting` is the person choosing the token box over a sign-in, until the
// address changes.
export const useMcpAuth = (url: () => string | undefined, calls: Pick<McpSignInCalls, `check`> = SANDBOX_MCP_CALLS) => {
    const answered = shallowRef<{ readonly url: string; readonly check: McpAuthCheck }>();
    const pasting = ref(false);
    let settling: ReturnType<typeof setTimeout> | undefined;
    watch(
        () => url()?.trim(),
        (now) => {
            clearTimeout(settling);
            pasting.value = false;
            if (!askable(now)) {
                return;
            }
            settling = setTimeout(() => {
                void calls.check(now).then(
                    (check) => {
                        answered.value = { url: now, check };
                    },
                    // A question the sandbox could not answer leaves the token box, which works for every server.
                    () => {
                        answered.value = { url: now, check: { auth: `unreachable` } };
                    },
                );
            }, SETTLE_MS);
        },
        { immediate: true },
    );
    onScopeDispose(() => clearTimeout(settling));
    const check = computed(() => (answered.value !== undefined && answered.value.url === url()?.trim() ? answered.value.check : undefined));
    return { check, pasting };
};

// A sign-in the connection being edited already holds, as the list echoes it (mcp.handler.ts).
export interface McpSignedIn {
    readonly server: string;
    readonly account: string | undefined;
    readonly scope: string | undefined;
    // The address it signed in for: another address in the form needs a new sign-in.
    readonly url: string;
}

// The echo of a signed-in connection's config, by the keys mcp.handler.ts puts there.
const SignedInEchoSchema = z.object({
    url: z.string(),
    signedIn: z.literal(true),
    signInServer: z.string(),
    account: z.string().optional(),
    scope: z.string().optional(),
});

export const storedSignIn = (instance: CapabilitySummary | undefined): McpSignedIn | undefined => {
    const echo = instance?.kind === `mcp` ? SignedInEchoSchema.safeParse(instance.config) : undefined;
    return echo?.success === true
        ? { server: echo.data.signInServer, account: echo.data.account, scope: echo.data.scope, url: echo.data.url }
        : undefined;
};

// The token field of an MCP tile, while its server names a sign-in (or the connection being edited holds one), and the
// person has not chosen to paste a token instead.
export const signsInToMcp = (
    entry: CapabilityCatalogEntry,
    field: CapabilityField,
    auth: { readonly check: McpAuthCheck | undefined; readonly pasting: boolean },
    instance: CapabilitySummary | undefined,
): boolean => entry.kind === `mcp` && field.key === `token` && !auth.pasting && (auth.check?.auth === `oauth` || storedSignIn(instance) !== undefined);

// Words the sandbox adds to every sign-in it can (to renew, and to say who signed in): not access to the server's data.
const HOUSEKEEPING = new Set([`offline_access`, `openid`, `email`, `profile`]);

// What a sign-in was granted, in the server's own scope words, less the sandbox's own housekeeping; undefined when it
// said nothing.
export const grantedScopes = (scope: string | undefined): string | undefined => {
    const words = (scope ?? ``).split(/\s+/).filter((word) => word !== `` && !HOUSEKEEPING.has(word));
    return words.length === 0 ? undefined : words.join(`, `);
};

// A finished sign-in, as the form keeps it: the marker it put in the field, and what to say about it.
export interface McpGrant {
    readonly marker: string;
    readonly server: string;
    readonly account: string | undefined;
    readonly scope: string | undefined;
    readonly url: string;
}

export type McpSignInPhase = `idle` | `starting` | `waiting`;

// Where the person approves: a window of its own, opened in the press itself so no blocker sees one opened after an await.
const POPUP = `intentic-mcp-sign-in`;
const POPUP_FEATURES = `popup,width=520,height=720`;

// The approval window, by what the sign-in does with it: send it to the authorization server, and close it if let go.
export interface ApprovalWindow {
    readonly location: { href: string };
    readonly close: () => void;
}

export type OpenWindow = (url: string, target: string, features: string) => ApprovalWindow | null;

// One form's sign-in: open the window, start in the sandbox, send the window to the authorization server, and wait with
// the sandbox until the person comes back. A newer start or a cancel lets an attempt go; its late answer is dropped.
export const useMcpSignIn = (
    calls: Pick<McpSignInCalls, `start` | `wait`> = SANDBOX_MCP_CALLS,
    open: OpenWindow = (url, target, features) => window.open(url, target, features),
) => {
    const phase = ref<McpSignInPhase>(`idle`);
    const problem = ref<string>();
    let attempt = 0;
    let approving: ApprovalWindow | null = null;
    // Whether an attempt is still the one the form shows: a newer start or a cancel lets it go, between two awaits.
    const live = (mine: number): boolean => mine === attempt;

    const cancel = (): void => {
        attempt += 1;
        phase.value = `idle`;
        approving?.close();
        approving = null;
    };

    // Only ever an ended flow: one still waiting is asked again.
    const waitFor = async (mine: number, flow: string): Promise<Exclude<McpSignInWait, { readonly state: `waiting` }> | undefined> => {
        while (live(mine)) {
            const said = await calls.wait(flow);
            if (said.state !== `waiting`) {
                return said;
            }
        }
        return undefined;
    };

    const begin = async (input: McpSignInAsk): Promise<McpGrant | undefined> => {
        cancel();
        problem.value = undefined;
        const mine = attempt;
        const opened = open(`about:blank`, POPUP, POPUP_FEATURES);
        if (opened === null) {
            problem.value = t(`capabilities.mcpSignInField.popupBlocked`);
            return undefined;
        }
        approving = opened;
        phase.value = `starting`;
        try {
            const started = await calls.start(input);
            if (!live(mine)) {
                return undefined;
            }
            opened.location.href = started.authorizeUrl;
            phase.value = `waiting`;
            const said = await waitFor(mine, started.flow);
            if (said === undefined || !live(mine)) {
                return undefined;
            }
            phase.value = `idle`;
            approving = null;
            if (said.state === `failed`) {
                problem.value = said.message;
                return undefined;
            }
            return { marker: stashedMarker(said.token), server: said.server, account: said.account, scope: said.scope, url: input.url };
        } catch (error) {
            if (live(mine)) {
                cancel();
                problem.value = messageOr(error, t(`capabilities.mcpSignInField.couldntStart`));
            }
            return undefined;
        }
    };

    onScopeDispose(cancel);
    return { phase, problem, begin, cancel };
};
