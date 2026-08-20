import type { MemberRole } from "@intentic/sandbox-contract";
import { roleAtLeast } from "@intentic/sandbox-contract";
import { computed, type ComputedRef } from "vue";
import { useSandbox } from "./useSandbox";

/* The signed-in user's trust tier on the ACTIVE sandbox, and the two lines the UI draws with it.
 *
 * The role comes off the platform's sandbox summary (the invite's granted tier; `owner` for an owned sandbox).
 * It gates AFFORDANCES only, every route is independently floored by the daemon (auth/role-floor.ts), so a
 * stale or spoofed reading here changes what renders, never what is allowed. Defaults to `owner` until the
 * list loads (loopback/dev sandboxes never carry a summary), the same optimistic guess the desktop-sync card
 * has always made, the daemon corrects a wrong one on the first call.
 *
 * Two derived lines instead of exposing rank arithmetic at every call site:
 *   canDrive, collaborator and up: start/steer agents, review, comment. A viewer watches.
 *   canShip , maintainer and up: land/discard, approve drafts, the terminal, what leaves the sandbox.
 */
export function useRole(): {
    role: ComputedRef<MemberRole>;
    canDrive: ComputedRef<boolean>;
    canShip: ComputedRef<boolean>;
    isOwner: ComputedRef<boolean>;
} {
    const { active } = useSandbox();
    const role = computed<MemberRole>(() => active.value?.role ?? `owner`);
    return {
        role,
        canDrive: computed(() => roleAtLeast(role.value, `collaborator`)),
        canShip: computed(() => roleAtLeast(role.value, `maintainer`)),
        isOwner: computed(() => role.value === `owner`),
    };
}
