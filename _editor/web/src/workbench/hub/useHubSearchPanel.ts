import { useListNavigation } from "@intentic/ui";
import { computed, type ComputedRef, onBeforeUnmount, type Ref, ref } from "vue";
import { useRouter } from "vue-router";
import { categoryLabel, SANDBOX, SETTINGS } from "../commands/categories";
import { groupByHub, type HubName, type HubSearchResult } from "./hubSearch";
import { seekSetting } from "./settingAnchor";
import { useHubSearch } from "./useHubSearch";

// The hub's own search field and its answers, as one state the field and the list both read: what is typed, what it
// found, which answer the keyboard is on, and how one is opened. Made by the hub that owns the field (SandboxHub.vue,
// SettingsHub.vue) and handed to <HubLayout>, which only draws it, so the layout stays a layout.

export interface HubSearchGroup {
    readonly hub: HubName;
    readonly heading: string;
    readonly results: readonly HubSearchResult[];
    /** The first answer's place in the flat list, so a row knows its own index without the list being walked per row. */
    readonly from: number;
}

type RowRef = Parameters<ReturnType<typeof useListNavigation>[`setRowEl`]>[1];

export interface HubSearchPanel {
    readonly query: Ref<string>;
    /** Whether anything is typed: the hub's index gives way to the answers while it is. */
    readonly searching: ComputedRef<boolean>;
    readonly groups: ComputedRef<readonly HubSearchGroup[]>;
    readonly rows: ComputedRef<readonly HubSearchResult[]>;
    readonly activeIndex: Ref<number>;
    readonly move: (delta: number) => void;
    readonly setRowEl: (key: string, el: RowRef) => void;
    /** Goes to an answer, and lands on its card once the page has drawn it. */
    readonly open: (result: HubSearchResult) => void;
    readonly openActive: () => void;
}

// What is typed, handed from one hub to the other when an answer there is picked: the reader may want the next answer
// down rather than to type the question again. Any other way out (the palette, the rail, a link) drops it, so a hub is
// never opened on a question the reader is no longer asking.
// allow(module-state): the hub search's query, carried into the hub an answer opens
const carried = ref(``);
// Whether the hub being left is handing its query to the one an answer opens.
let handing = false;

const HEADING = { sandbox: SANDBOX, settings: SETTINGS } satisfies Readonly<Record<HubName, string>>;

/** Lands on an answer's card, for a caller whose own link already did the navigating. */
export const arriveAt = (result: HubSearchResult): void => {
    if (result.setting !== undefined) {
        void seekSetting(result.setting);
    }
};

export function useHubSearchPanel(here: HubName): HubSearchPanel {
    const router = useRouter();
    const query = carried;
    onBeforeUnmount(() => {
        if (!handing) {
            carried.value = ``;
        }
        handing = false;
    });
    const { results } = useHubSearch(query);
    const searching = computed(() => query.value.trim().length > 0);

    const groups = computed<readonly HubSearchGroup[]>(() => {
        let from = 0;
        return groupByHub(results.value, here).map((group) => {
            const placed = { hub: group.hub, heading: categoryLabel(HEADING[group.hub]), results: group.results, from };
            from += group.results.length;
            return placed;
        });
    });
    const rows = computed<readonly HubSearchResult[]>(() => groups.value.flatMap((group) => group.results));
    const { activeIndex, activeRow, move, setRowEl } = useListNavigation(rows, (row) => row.key);

    const open = (result: HubSearchResult): void => {
        handing = result.hub !== here;
        void router.push(result.to);
        arriveAt(result);
    };
    const openActive = (): void => {
        if (activeRow.value !== undefined) {
            open(activeRow.value);
        }
    };

    return { query, searching, groups, rows, activeIndex, move, setRowEl, open, openActive };
}
