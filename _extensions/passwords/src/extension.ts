import type { ExtensionContext, IntenticApi, ViewBadge } from "@intentic/extension-api";
import { sandboxPoll } from "@intentic/extension-api";
import type { SandboxNeed } from "@intentic/sandbox-contract/schemas/sandbox-passwords";
import { bindHost, host } from "./host.js";
import { t } from "./i18n.js";

// Binds the host and registers the Passwords rail view. Detection is unconditional: what this sandbox may use, and
// the way to the desktop app where the vault is kept, are worth a tile before any computer is set up. The tile badges
// the credentials this sandbox asked for that wait on the owner's answer, which is what brings it onto the rail.

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

// Polled while the editor is open: a need is answered on another computer, so nothing here hears it change.
const passwordsAttention = sandboxPoll<number>({
    host,
    everyMs: 60_000,
    initial: () => 0,
    read: async (api) => (await api.sandbox.fetch({ ...passwordNeedsQuery(), staleTime: 0 })).needs.filter((need) => need.state === `pending`).length,
});

const needsBadge = (): ViewBadge | undefined => {
    const count = passwordsAttention.state.value;
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
            detect: () => [{ key: `passwords`, title: t(`extension.passwords`), icon: `key` }],
            badge: needsBadge,
            warm: () => [passwordsQuery(), passwordNeedsQuery()],
            view: async () => (await import(`./PasswordsView.vue`)).default,
        }),
    );
};
