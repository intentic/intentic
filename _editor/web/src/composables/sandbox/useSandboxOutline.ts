import { computed, type Ref } from "vue";
import { activeSandboxId } from "./activeSandbox";
import { useLoadingReveal } from "../loadingReveal";

/* Should a sandbox view be drawing its outline right now — the one question every tab in the sandbox hub asks,
 * answered once so no tab has to know the thresholds.
 *
 * It is useLoadingReveal with the SUBJECT already filled in, and the subject is the whole reason this exists.
 * Every read behind these tabs is scoped to the active sandbox (useSandboxQuery gates on that daemon being
 * reachable), so switching sandboxes does not continue a wait — it starts a different one, and the outline must
 * drop rather than hold the old box's shape over the new box's data. Written out per tab, that is the line each
 * one would get subtly wrong.
 *
 * The gating itself is not optional and not a preference. A warm daemon answers these in well under the reveal
 * delay, so the common case paints NO outline at all; a placeholder that flashes for 80ms reads as a fault, and
 * the hub has eleven tabs to flash it on.
 *
 * The id comes from `activeSandbox` rather than from useSandbox, which owns it, for exactly the reason that
 * module was split out: useSandbox reaches the platform API client and the build environment, so taking the id
 * from there would drag that whole chain into every view that draws an outline — and into every test of one. */
export const useSandboxOutline = (loading: Ref<boolean>): Ref<boolean> =>
    useLoadingReveal(
        loading,
        computed(() => activeSandboxId.value ?? ``),
    );
