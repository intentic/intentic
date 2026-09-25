import { computed } from "vue";
import { rpcQuery } from "../../client/rpcQuery";
import { useSandboxQuery } from "../../client/useSandboxQuery";
import { useEnvironment } from "../../environment/useEnvironment";

// Sandbox daemon's self-report (`system.info`): running `version`, and once checked, `latest` and `updateAvailable`. One shared
// query feeds both the hub card and the chip's attention list. The update itself runs on the host (HostRecreate), never
// the sandbox; no per-version dismiss, since the fact just badges the chip and clears itself.

export function useSandboxVersion() {
    const { serverManaged, state: envState, localImage } = useEnvironment();

    const { query } = useSandboxQuery(rpcQuery(`system.info`));
    const info = computed(() => query.data.value);
    const installed = computed(() => info.value?.version);
    const latest = computed(() => info.value?.latest);
    const updateAvailable = computed(() => info.value?.updateAvailable === true);
    // What the update contains; the daemon caps the list (see MAX_UPDATE_NOTES) and reports the overflow. Empty is
    // ordinary for a release with nothing user-visible.
    const updateNotes = computed<readonly string[]>(() => info.value?.updateNotes ?? []);
    const moreUpdateNotes = computed(() => info.value?.moreUpdateNotes ?? 0);
    // What the update takes away, uncapped: their presence turns the card from an offer into a warning.
    const breakingNotes = computed<readonly string[]>(() => info.value?.breakingNotes ?? []);

    // Whether the update is already downloaded, which decides what taking it costs (a restart, not a download). A
    // staged update with no version still counts ready; one a newer release has overtaken doesn't (`stagedBehind` names
    // it).
    const staged = computed(() => info.value?.staged);
    const updateStaged = computed(() => {
        const ready = staged.value;
        return ready !== undefined && (ready.version === undefined || latest.value === undefined || ready.version === latest.value);
    });
    const stagedBehind = computed(() => (staged.value !== undefined && !updateStaged.value ? staged.value.version : undefined));
    // What the staged build's first boot converts in this sandbox's stored files, pre-flighted when it was downloaded;
    // only for the build actually on offer, since an overtaken one's plan describes an update nobody is being offered.
    const stagedPlan = computed(() => (updateStaged.value ? staged.value?.plan : undefined));

    // Whether a runtime can serve a turn right now. `unknown` or absent means unverified and is never shown as a
    // problem; only an explicit `unavailable` is, with the daemon's own sentence.
    const runtimeIssue = (runtime: string): string | undefined => {
        const health = info.value?.runtimes?.[runtime];
        return health?.state === `unavailable` ? (health.detail ?? `This runtime can't serve a turn right now.`) : undefined;
    };

    // Container name a recreate would target, from /environment; HostRecreate turns it into a button or command.
    const slug = computed(() => envState.value?.container?.replace(/^intentic-sandbox-/, ``));

    return {
        info,
        installed,
        latest,
        updateAvailable,
        updateNotes,
        moreUpdateNotes,
        breakingNotes,
        updateStaged,
        stagedBehind,
        stagedPlan,
        runtimeIssue,
        serverManaged,
        slug,
        // A checkout-built base: the published release is not this sandbox's update, so the card offers the rebuild
        // that is.
        localImage,
        // The info read is still out; without this, "the sandbox hasn't said" looks identical to "the sandbox says
        // nothing".
        isLoading: query.isLoading,
    };
}
