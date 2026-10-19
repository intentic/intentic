import type { ExtensionContext, IntenticApi, ViewBadge } from "@intentic/extension-api";
import { sandboxPoll } from "@intentic/extension-api";
import type { SandboxNeed } from "@intentic/sandbox-contract/schemas/sandbox-passwords";
import { bindHost, host } from "./host.js";
import { t } from "./i18n.js";
import { type PasswordsPresence, presenceOf, UNREAD_PRESENCE } from "./presence.js";

// Binds the host and registers the Passwords rail view. The tile is there only once Passwords means something on this
// sandbox (presence.ts): a computer has it set up, a password is shared here, or a request waits. It badges the
// credentials this sandbox asked for that wait on the owner's answer.

export const passwordNeedsQuery = () => ({
    queryKey: host().sandbox.readKey(`secrets.passwordNeeds`),
    queryFn: (): Promise<{ readonly needs: readonly SandboxNeed[] }> => host().sandbox.rpc.secrets.passwordNeeds(),
});

export const passwordsQuery = () => ({
    queryKey: host().sandbox.readKey(`secrets.passwords`),
    queryFn: () => host().sandbox.rpc.secrets.passwords(),
});

export const passwordActivityQuery = () => ({
    queryKey: host().sandbox.readKey(`secrets.passwordActivity`),
    queryFn: () => host().sandbox.rpc.secrets.passwordActivity(),
});

// Polled while the editor is open: a need is answered, and a vault set up, on another computer, so nothing here hears
// either change. Asked straight through `rpc` rather than the host's cache: this extension is compiled into the editor
// and runs on sandboxes whose image predates Passwords, where both routes are missing. There the host refuses the call
// before it is sent and the poll keeps "not shown", where a cached read would log every tick as a failed query.
const passwordsAttention = sandboxPoll<PasswordsPresence>({
    host,
    everyMs: 60_000,
    initial: () => UNREAD_PRESENCE,
    read: async (api, previous) => {
        const [{ needs }, passwords] = await Promise.all([api.sandbox.rpc.secrets.passwordNeeds(), api.sandbox.rpc.secrets.passwords()]);
        return presenceOf(previous, passwords, needs.filter((need) => need.state === `pending`).length);
    },
});

const needsBadge = (): ViewBadge | undefined => {
    const count = passwordsAttention.state.value.pending;
    return count > 0 ? { count, tone: `info`, tooltip: t(`hosted.badge`) } : undefined;
};

export const activate = (api: IntenticApi, context: ExtensionContext): void => {
    bindHost(api);
    context.subscriptions.push(passwordsAttention.start());
    context.subscriptions.push(
        api.views.register({
            id: `passwords`,
            label: t(`extension.passwords`),
            surface: `rail`,
            detect: () => (passwordsAttention.state.value.shown === true ? [{ key: `passwords`, title: t(`extension.passwords`), icon: `key` }] : []),
            badge: needsBadge,
            warm: () => [passwordsQuery(), passwordNeedsQuery()],
            view: async () => (await import(`./PasswordsView.vue`)).default,
        }),
    );
};
