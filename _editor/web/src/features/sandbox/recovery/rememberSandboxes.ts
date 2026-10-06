import { PlatformIdentitySchema, type SandboxSummary } from "@intentic/api-contract";
import { hashKey } from "@tanstack/vue-query";
import { watch } from "vue";
import { environment } from "../../../app/environments/environment";
import { queryClient } from "../../../lib/queryPersistence";
import { apiClient } from "../../../lib/useApi";
import { useAuth } from "../../../client/auth/useAuth";
import { SANDBOX_LIST_KEY } from "../../../client/sandbox/useSandbox";
import { sandboxIdOfDaemonUrl } from "@intentic/sandbox-contract";
import { forgetSandbox, missingSandboxes, noteUnknown, rememberListed } from "../../../client/directory/deviceDirectory";
import { directMode } from "../../../client/directory/directState";

// Keeps the device's memory (deviceDirectory.ts) up with every list the platform answers, and asks the platform about
// any remembered sandbox a list lacks: deleted or someone else's is let go of here, unknown is marked, and only that is
// offered back. Without the question, a sandbox deleted on a phone would come back on the laptop as "lost".

// Which database the platform reads, asked once per page load (GET /api/identity): a different one than remembered is
// how a reset tells itself apart from an account that simply has nothing listed. Undefined when it cannot say. One
// platform answers one page load, so the first answer is kept for it.
let identity: Promise<string | undefined> | undefined;

const askIdentity = async (): Promise<string | undefined> => {
    try {
        const response = await fetch(`${environment.api.url}/api/identity`, { signal: AbortSignal.timeout(5000) });
        const parsed = response.ok ? PlatformIdentitySchema.safeParse(await response.json()) : undefined;
        return parsed?.success === true ? parsed.data.identity : undefined;
    } catch {
        // allow(silent-catch): a platform that cannot say which database it reads is remembered without one.
        return undefined;
    }
};

const platformIdentity = (): Promise<string | undefined> => {
    identity ??= askIdentity();
    return identity;
};

// What the platform holds of the missing sandboxes it has not been asked about yet; one question per list, never a
// failure (asked again after the next one).
const askAboutMissing = async (email: string): Promise<void> => {
    const asked = missingSandboxes(email).flatMap((entry) => {
        const sandboxId = entry.standing === undefined ? sandboxIdOfDaemonUrl(entry.daemonUrl) : undefined;
        return sandboxId === undefined ? [] : [{ sandboxId, entry }];
    });
    if (asked.length === 0) {
        return;
    }
    // allow(silent-catch): an unanswered lookup forgets nothing and is asked again with the next list; see the comment above.
    const answer = await apiClient.sandbox.lookup({ sandboxIds: asked.map((each) => each.sandboxId) }).catch(() => undefined);
    for (const { sandboxId, entry } of asked) {
        const standing = answer?.sandboxes.find((held) => held.sandboxId === sandboxId)?.standing;
        if (standing === `deleted` || standing === `other`) {
            forgetSandbox(email, entry.daemonUrl);
        } else if (standing === `unknown`) {
            noteUnknown(email, entry.daemonUrl);
        }
    }
};

// Started once from the root (App.vue), like the notification sources: every list the platform answers is remembered
// for the account that asked, never one this window seeded itself while open directly.
export const startRememberingSandboxes = (): void => {
    const listHash = hashKey(SANDBOX_LIST_KEY);
    queryClient.getQueryCache().subscribe((event) => {
        if (event.type !== `updated` || event.action.type !== `success` || event.query.queryHash !== listHash) {
            return;
        }
        const account = useAuth().user.value;
        if (account === null || directMode.value) {
            return;
        }
        const rows = queryClient.getQueryData<SandboxSummary[]>(SANDBOX_LIST_KEY) ?? [];
        void platformIdentity().then(async (held) => {
            rememberListed(account, rows, held);
            await askAboutMissing(account.email);
        });
    });
    // Back on the platform after an outage spent open directly: the list it answers replaces the one remembered.
    watch(directMode, (now, was) => {
        if (was && !now) {
            void queryClient.invalidateQueries({ queryKey: SANDBOX_LIST_KEY });
        }
    });
};
