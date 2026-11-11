import type { SandboxNeed } from "@intentic/sandbox-contract/schemas/sandbox-passwords";
import { computed, type MaybeRefOrGetter, toValue } from "vue";
import { rpcQuery } from "../../../client/sandbox/rpcQuery";
import { useSandboxQuery } from "../../../client/sandbox/useSandboxQuery";

// The credentials this sandbox's agents asked the owner's computers for that still wait on an answer (`GET
// /secrets/wants`). Read again each minute while something draws it: the answer is given in Passwords on another
// computer, and nothing here hears it. Credentials are the operating tier's, so a reader below it never asks; a read
// that fails (a daemon older than the route) leaves the list empty rather than drawing an error about a feature it
// never had.

const EVERY_MS = 60_000;

export function useWants(enabled: MaybeRefOrGetter<boolean> = true) {
    const { query } = useSandboxQuery({
        ...rpcQuery(`secrets.wants`, undefined, { background: true }),
        enabled: computed(() => toValue(enabled)),
        refetchInterval: EVERY_MS,
    });
    const needs = computed<readonly SandboxNeed[]>(() => (toValue(enabled) ? (query.data.value?.needs ?? []) : []));
    return { needs };
}
