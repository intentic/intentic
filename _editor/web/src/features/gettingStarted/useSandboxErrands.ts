import { computed, type ComputedRef } from "vue";
import type { SandboxSummary } from "@intentic/api-contract";
import type { ViewBadge } from "@intentic/extension-api";
import { useSandbox } from "../../client/sandbox/useSandbox";
import { unfinishedSandboxes } from "../../models/sandbox/live/roster";
import { type SandboxAttentionItem, useSandboxAttention } from "../sandbox/overview/sandboxAttention";

// Everything the getting-started ring carries besides its checklist (SandboxErrands.vue): the active sandbox's needs and
// notes, and the setups on this account never finished. One read, so the ring's presence, its badge and the rows it
// opens onto never disagree about whether there is anything to show.
export interface SandboxErrands {
    readonly needs: ComputedRef<readonly SandboxAttentionItem[]>;
    readonly notes: ComputedRef<readonly SandboxAttentionItem[]>;
    readonly unfinished: ComputedRef<readonly SandboxSummary[]>;
    // The ring's corner badge: the attention badge the switcher's logo used to wear.
    readonly badge: ComputedRef<ViewBadge | undefined>;
    readonly any: ComputedRef<boolean>;
}

export const useSandboxErrands = (): SandboxErrands => {
    const sandbox = useSandbox();
    const { needs, notes, badge } = useSandboxAttention();
    const unfinished = computed(() => unfinishedSandboxes(sandbox.sandboxes.value));
    const any = computed(() => needs.value.length > 0 || notes.value.length > 0 || unfinished.value.length > 0);
    return { needs, notes, unfinished, badge, any };
};
