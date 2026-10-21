import { computed, inject, ref, watch, type WritableComputedRef } from "vue";
import { routeLocationKey } from "vue-router";
import { z } from "zod";
import { deviceKey, storedJson, storeJson } from "@intentic/ui/storage";

// How much of one Tools section is drawn: `simple` is its switches and one line of what each bought, `advanced` adds
// the tuning behind them (measurement tables, comparison groups, per-cleaner and per-kind rows). One choice per section,
// kept in this browser, so opening the cleaners does not also unfold every table on the page. Simple until asked: the
// page's first reader is deciding whether to keep a switch on, not tuning how it is measured.

export type DetailLevel = `simple` | `advanced`;

// A fact about this browser's reader, not the account's: kept across sign-out like the theme.
const KEY = deviceKey(`intentic:agent-tools-detail`);

// A stored map this build cannot read is dropped whole: the worst it costs is Simple again.
const StoredSchema = z.record(z.string(), z.enum([`simple`, `advanced`]));

// One map for the page, read once: every section's switch writes through it.
// allow(module-state): this browser's section detail preferences, shared across sandboxes like the theme
const stored = ref<Record<string, DetailLevel>>(storedJson(KEY, StoredSchema) ?? {});

const write = (section: string, level: DetailLevel): void => {
    stored.value = { ...stored.value, [section]: level };
    storeJson(KEY, stored.value);
};

/**
 * The detail level of one section. `anchors` are the `data-setting` ids that only Advanced draws: a search answer
 * landing on one (`#setting-<id>`) opens Advanced for this visit, so the card it names is there to land on.
 */
export const useDetailLevel = (section: string, anchors: readonly string[] = []): WritableComputedRef<DetailLevel> => {
    // Injected rather than `useRoute()`, which is typed as always there: a section mounted with no router (a test, a
    // design kit) has no address to land on, and is simply not landed on.
    const route = inject(routeLocationKey, undefined);
    const landed = ref(false);
    watch(
        () => route?.hash,
        (hash) => {
            if (anchors.some((id) => hash === `#setting-${id}`)) {
                landed.value = true;
            }
        },
        { immediate: true },
    );
    return computed<DetailLevel>({
        get: () => (landed.value ? `advanced` : (stored.value[section] ?? `simple`)),
        set: (level) => {
            landed.value = false;
            write(section, level);
        },
    });
};
