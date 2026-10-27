import { roleAtLeast } from "@intentic/sandbox-contract/schemas/shared";
import { type Component, computed, type ComputedRef, defineComponent, h } from "vue";
import type { AccessReason } from "../client/sandbox/access/accessReason";
import { type AccessRoute, useAccess } from "../client/sandbox/access/useAccess";
import AccessGate from "./access/AccessGate.vue";

// A PLACE HELD FOR MAINTAINERS (Capabilities, the terminal): whether this reader may open it, and if not, why. Asked of
// the tier the platform already reports, so an owner's page opens without waiting on the access check, and of the
// check itself (`route`, when the place maps to one) once that has loaded, so the gate says what the daemon would.
//
// Three answers: `open` mounts the place; a reason draws the gate in its place, never the place itself, whose reads
// would only be refused; neither while the tier is not known yet, or for a guest, whose fence moves it elsewhere
// (shell/guestFence.ts) and which must not see a gate on its way there.

const MAINTAINERS: AccessReason = { kind: `tier`, floor: `maintainer` };

export interface HeldPlace {
    readonly open: ComputedRef<boolean>;
    readonly refused: ComputedRef<AccessReason | undefined>;
}

export const useHeldPlace = (route?: AccessRoute): HeldPlace => {
    const access = useAccess();
    const maintainer = computed(() => access.role.value !== undefined && roleAtLeast(access.role.value, `maintainer`));
    const refused = computed<AccessReason | undefined>(() => {
        const role = access.role.value;
        if (role === undefined || role === `guest`) {
            return undefined;
        }
        const said = route === undefined ? undefined : access.refusal(route);
        return said ?? (maintainer.value ? undefined : MAINTAINERS);
    });
    return { open: computed(() => maintainer.value && refused.value === undefined), refused };
};

/**
 * A routed view held for maintainers: the view itself for one, the gate naming `place` for anyone below. For the
 * router's lazy loaders, which hand over the view's module, so the gate costs no file of its own per page.
 */
export const heldView = (view: Component, place: () => string, route?: AccessRoute) => ({
    default: defineComponent({
        name: `HeldView`,
        inheritAttrs: false,
        setup(_, { attrs }) {
            const { open, refused } = useHeldPlace(route);
            return () => {
                if (open.value) {
                    return h(view, attrs);
                }
                const reason = refused.value;
                return reason === undefined ? null : h(AccessGate, { reason, place: place() });
            };
        },
    }),
});

/**
 * Whether a door to the place belongs on screen (a rail tile, a palette entry, a menu row): not for a guest, and not
 * once the tier is known to be below it. Drawn while nothing is known yet, as a maintainer's would be, so an owner's
 * rail never flickers; the place itself still waits (`useHeldPlace`).
 */
export const useHeldDoor = (route?: AccessRoute): ComputedRef<boolean> => {
    const access = useAccess();
    const { refused } = useHeldPlace(route);
    return computed(() => access.role.value !== `guest` && refused.value === undefined);
};

/**
 * Whether the person is known to stand below a maintainer, for code that runs on a press rather than in a component (a
 * menu built when it opens). A terminal is one such place: its socket's ticket is redeemed at the maintainer tier
 * (sandbox terminal/terminal-plan.ts), which no route's floor says.
 */
export const belowMaintainer = (): boolean => {
    const role = useAccess().role.value;
    return role !== undefined && !roleAtLeast(role, `maintainer`);
};
