<!-- The browser's address bar and its search box in one: it shows where the page is and takes whatever is typed into
     it. Drawn the way a browser draws its own rather than as the kit's AddressField: while nobody is typing, the scheme
     folds into the padlock and the host stands out from the path; the moment somebody clicks, the whole address comes
     back, selected, ready to be typed over. Typing completes inline from history and opens the suggestions under it
     (omnibox/useOmniboxField.ts has the keys, omnibox/rank.ts the order); what Enter picks is sent as an address. -->
<script setup lang="ts">
import { DEFAULT_SEARCH_ENGINE, OWN_BROWSING_PROFILE, type SearchEngine } from "@intentic/sandbox-contract/schemas/browsing";
import type { BrowserPage } from "@intentic/sandbox-contract/schemas/terminal";
import { CopyButton, Icon, type IconName } from "@intentic/ui";
import { computed, ref, toRef, useId } from "vue";
import { addressParts, securityOf } from "./address";
import { NO_MARKS, type PageMarks } from "./bookmarks/bookmarkTree";
import OmniboxDropdown from "./omnibox/OmniboxDropdown.vue";
import type { TabCandidate } from "./omnibox/rank";
import { useOmniboxField } from "./omnibox/useOmniboxField";
import { useNavigationLine } from "./pageProgress";

const {
    value,
    editable = false,
    placeholder = ``,
    copyLabel,
    secureLabel,
    insecureLabel,
    kind,
    page,
    profile = OWN_BROWSING_PROFILE,
    engine = DEFAULT_SEARCH_ENGINE,
    tabs = [],
    variant = `bar`,
    busy = false,
    siteLabel,
    marks = NO_MARKS,
} = defineProps<{
    // The page's own address; empty for a blank page. Typing never changes it, the caller does after `submit`.
    value: string;
    // False for a closed browser's record: the address can still be read and copied, not sent anywhere.
    editable?: boolean;
    placeholder?: string;
    copyLabel?: string;
    // What the padlock says on hover: the page is private, or it travels in the clear.
    secureLabel?: string;
    insecureLabel?: string;
    // What the address is of, where it is not a web page (`desktop://`, `app://`): drawn in the padlock's place.
    kind?: IconName | undefined;
    // The web page in front, while one is: on its way somewhere, a line breathes along the bar's foot where a browser
    // draws its progress, and what it waits on ("Waiting for host… · 12s") is said at the bar's end while nobody types.
    page?: BrowserPage | undefined;
    // Whose history the suggestions come from: the person's own browser unless the caller says otherwise.
    profile?: string;
    // Where a search goes, the sandbox's `searchEngine` setting.
    engine?: SearchEngine;
    // The open tabs, offered to switch to rather than open again.
    tabs?: readonly TabCandidate[];
    // `hero` is the start page's big search box; `bar` the toolbar's.
    variant?: `bar` | `hero`;
    // Something is on its way (the browser starting): the field waits, with a spinner.
    busy?: boolean;
    // What the padlock says to assistive tech where it opens the site's information (`site`).
    siteLabel?: string;
    // Which pages are bookmarked and each site's icon, for the suggestions (bookmarks/bookmarkTree.ts).
    marks?: PageMarks;
}>();

const loading = computed(() => page?.loading === true);
const status = useNavigationLine(computed(() => page));

// `submit` is an address to go to (a search already made one); `switchTab` is an open tab picked from the list; `cancel`
// is Escape with nothing left to undo: the caller puts the keyboard back on the page; `site` is the padlock pressed, with
// itself to anchor the site's information to.
const emit = defineEmits<{ submit: [url: string]; switchTab: [tab: TabCandidate]; cancel: []; site: [anchor: HTMLElement] }>();

const input = ref<HTMLInputElement | undefined>();
const writable = computed(() => editable && !busy);
const field = useOmniboxField({
    value: toRef(() => value),
    editable: writable,
    profile: toRef(() => profile),
    engine: toRef(() => engine),
    tabs: toRef(() => tabs),
    marks: toRef(() => marks),
    input,
    submit: (url) => emit(`submit`, url),
    switchTab: (tab) => emit(`switchTab`, tab),
    cancel: () => emit(`cancel`),
});
const { focused, open, rows, highlight } = field;
const listId = `omnibox-${useId()}`;

// Off the real address, never the draft: typing changes nothing until Enter.
const security = computed(() => securityOf(value));
const parts = computed(() => addressParts(value));
// The drawn address stands over the input only while it is at rest; typing happens in the input itself.
const dressed = computed(() => !focused.value && parts.value !== undefined);

// The glyph at the front says what Enter will do: a search while typing or on a blank page, otherwise how private the
// page is.
const glyph = computed<IconName>(() =>
    kind !== undefined
        ? kind
        : focused.value || value === ``
          ? `search`
          : security.value === `secure`
            ? `lock`
            : security.value === `insecure`
              ? `unlock`
              : `globe`,
);

// The padlock is a button while it stands for a web page at rest, as a browser's opens the site's information.
const siteButton = computed(() => kind === undefined && !focused.value && value !== `` && glyph.value !== `search`);
const pressSite = (event: MouseEvent): void => {
    if (event.currentTarget instanceof HTMLElement) {
        emit(`site`, event.currentTarget);
    }
};

const focus = (): void => input.value?.focus();

defineExpose({ focus });
</script>

<template>
    <!-- The shell draws the frame and takes the focus; the field inside is bare. -->
    <div
        class="ui-field-shell group relative flex min-w-0 items-center rounded-full"
        :class="variant === 'hero' ? 'h-11 gap-3 px-4' : 'h-8 gap-2 pl-3 pr-1'"
        @mousedown.self.prevent="focus"
    >
        <component
            :is="siteButton ? 'button' : 'span'"
            :type="siteButton ? 'button' : undefined"
            :aria-label="siteButton ? siteLabel : undefined"
            class="flex shrink-0 items-center justify-center"
            :class="siteButton ? '-ml-1 size-6 cursor-pointer rounded-full hover:bg-content/10' : ''"
            v-tooltip.bottom="glyph === 'lock' ? secureLabel : glyph === 'unlock' ? insecureLabel : undefined"
            @click="siteButton && pressSite($event)"
        >
            <Icon :name="glyph" :class="[variant === 'hero' ? 'text-xs' : 'text-2xs', glyph === 'unlock' ? 'text-warning' : 'text-subtle']" />
        </component>
        <div class="relative flex min-w-0 flex-1 items-center">
            <!-- allow(substitutes): a browser's address field (a URL, or words to search the web for on Enter), not a filter over a list -->
            <input
                ref="input"
                type="text"
                role="combobox"
                spellcheck="false"
                autocomplete="off"
                autocapitalize="off"
                enterkeyhint="go"
                aria-autocomplete="both"
                :aria-expanded="open"
                :aria-controls="listId"
                :aria-activedescendant="open ? `${listId}-${highlight}` : undefined"
                :readonly="!writable"
                :placeholder="placeholder"
                :aria-label="placeholder || undefined"
                class="field-bare min-w-0 flex-1 truncate"
                :class="[variant === 'hero' ? '' : 'md:text-xs', dressed ? 'text-transparent' : writable ? '' : 'text-muted']"
                @focus="field.onFocus"
                @blur="field.onBlur"
                @input="field.onInput"
                @keydown="field.onKeydown"
            />
            <!-- The address at rest, laid exactly over the input's own text so a click lands in the input underneath. -->
            <span
                v-if="dressed && parts"
                aria-hidden="true"
                class="pointer-events-none absolute inset-0 flex items-center truncate whitespace-pre text-base"
                :class="variant === 'hero' ? '' : 'md:text-xs'"
            >
                <span class="truncate">
                    <span :class="editable ? 'text-content' : 'text-muted'">{{ parts.host }}</span>
                    <span class="text-subtle">{{ parts.rest }}</span>
                </span>
            </span>
        </div>
        <Icon v-if="busy" name="spinner" spin class="shrink-0 text-xs text-muted" />
        <span v-if="status && !focused" class="max-w-[45%] shrink-0 truncate text-2xs text-subtle" role="status">{{ status }}</span>
        <span v-if="loading" aria-hidden="true" class="pointer-events-none absolute inset-x-4 bottom-0 h-0.5 animate-pulse rounded-full bg-primary-500" />
        <!-- Out of the way until the pointer comes: this bar is for typing, copying is the second thing. -->
        <CopyButton
            v-if="value"
            :text="value"
            class="shrink-0 rounded-full opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
            :aria-label="copyLabel"
            v-tooltip.bottom="copyLabel"
        />
        <!-- What the caller adds at the bar's end: the bookmark star, for a web page. -->
        <slot name="end" />
        <OmniboxDropdown
            v-if="open"
            :rows="rows"
            :highlight="highlight"
            :list-id="listId"
            :variant="variant"
            @choose="field.choose"
            @hover="field.hover"
            @remove="field.remove"
        />
    </div>
</template>
