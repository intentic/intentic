import { t } from "@intentic/ui/i18n";
import { apiClient } from "../../../../lib/useApi";
import { expectRestart } from "../../live/sandboxRestart";

// A HOSTED sandbox back onto the image its machine ran before its last image change. The platform serves this, not
// the daemon, so it works while the sandbox is down: which is when it is most wanted. The restart it causes is declared
// before the ask, since the platform can take the machine down before the request returns and nothing here is told
// when; a refused ask ends the declaration, and otherwise the sandbox's own return does.
export const rollBackHosted = async (sandboxId: string): Promise<void> => {
    const settled = expectRestart({
        sandbox: sandboxId,
        id: `update`,
        what: t(`capabilities.hostRecreate.rollingSandboxBack`),
        quiet: { title: t(`capabilities.hostRecreate.rollingSandboxBack`), detail: t(`capabilities.hostRecreate.restartingOntoImageRan`) },
        untilAnswered: true,
    });
    try {
        await apiClient.sandbox.hostedRollback({ sandboxId });
    } catch (error) {
        settled();
        throw error;
    }
};
