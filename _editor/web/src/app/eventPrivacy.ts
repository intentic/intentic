import type { BeforeSendFn, CaptureResult, JsonRecord, JsonType } from "posthog-js";
import { maskAttribute } from "./replayPrivacy";
import { maskText } from "./replayText";

// What an analytics event may carry of the workspace. The replay is masked in replayPrivacy.ts, and this is the same
// rule for everything else the SDK sends, which `before_send` sees one event at a time:
//
//  - Addresses. A path or URL in any property becomes the router's route pattern (`/workspace/:path*`), so a file path,
//    a conversation id or a sandbox name never leaves. Another site's address is cut to its origin.
//  - Text of a clicked element (`$el_text`, `$elements`, `$elements_chain`, and so the rage click and dead click events
//    that carry them). It goes through the same rules as the replay's text (replayText.ts), so "Commit all" still
//    records and a file name does not.
//  - Page titles, and the message of an exception, which quotes whatever failed and so often names a path. The stack
//    stays: its frames are the app's own bundle.
//
// Nothing else needs a rule. Our own `track()` events carry enums and counts (and `sandbox_setup_failed` the machine's
// own words, scrubbed at the call by `scrubDiagnostic`), the heatmap event is keyed by page address (handled with the
// addresses), and web vitals carry no selectors because `web_vitals_attribution` is off.

/** Where a browser path sits in the router's table: its route pattern, or undefined for a path nothing matches. */
export type RoutePatternOf = (path: string) => string | undefined;

const isText = (value: JsonType): value is string => typeof value === `string`;
const isList = (value: JsonType): value is JsonType[] => Array.isArray(value);
const isRecord = (value: JsonType): value is JsonRecord => typeof value === `object` && value !== null && !Array.isArray(value);

// A property that holds an address, by the last word of its name: `$current_url`, `$pathname`, `$referrer`,
// `$initial_current_url`, `$prev_pageview_pathname`, `$session_entry_url`, `$external_click_url`.
const ADDRESS_KEY = /(?:url|pathname|referrer|href)$/i;
const TITLE_KEY = /^\$?title$/i;
const EXCEPTION_MESSAGE_KEYS = new Set([`$exception_message`, `$exception_values`]);

// The names of `attr__*`, `text` and the like in the chain string the SDK builds from the elements, and the one value
// they carry, whose quotes it escapes as `\"`.
const CHAIN_FIELD = /\b(attr__[\w:.-]+|attr_id|text|href)="((?:[^"\\]|\\.)*)"/g;

const firstSegment = (path: string): string => `/${path.split(`/`)[1] ?? ``}`;

/**
 * Turns an address into the one analytics may keep: a URL or a path of this app becomes its route pattern, a URL of
 * another site becomes its origin, and anything that is not an address is returned as it came. The query and the hash
 * are never kept. A path the router cannot place falls back to its first segment.
 */
export const addressRedactor = (patternOf: RoutePatternOf, appHost: () => string | undefined = () => globalThis.location?.host) => {
    const patternOfPath = (path: string): string => {
        const clean = path.split(/[?#]/)[0] ?? ``;
        try {
            return patternOf(clean) ?? firstSegment(clean);
        } catch {
            return firstSegment(clean);
        }
    };
    return (value: string): string => {
        if (value.startsWith(`/`)) {
            return patternOfPath(value);
        }
        if (!/^https?:\/\//i.test(value)) {
            return value;
        }
        try {
            const { protocol, host, pathname } = new URL(value);
            return host === appHost() ? `${protocol}//${host}${patternOfPath(pathname)}` : `${protocol}//${host}/`;
        } catch {
            return `about:blank`;
        }
    };
};

const unquote = (value: string): string => value.replace(/\\"/g, `"`);
const quote = (value: string): string => value.replace(/"|\\"/g, `\\"`);

// The chain is one string, `tag.class:attr__x="v"text="v"nth-child="1";parent...`, so its fields are rewritten in place.
// `attr_id` and `href` are the SDK's own spellings of `id` and `href`.
const maskChain = (chain: string): string =>
    chain.replace(CHAIN_FIELD, (_field, name: string, value: string) => {
        const text = unquote(value);
        if (name === `text`) {
            return `${name}="${quote(maskText(text))}"`;
        }
        const attribute = name.startsWith(`attr__`) ? name.slice(`attr__`.length) : name === `attr_id` ? `id` : name;
        return `${name}="${quote(maskAttribute(attribute, text))}"`;
    });

const maskProperty = (key: string, value: string, redact: (address: string) => string): string => {
    if (key === `$elements_chain`) {
        return maskChain(value);
    }
    if (key === `$el_text` || TITLE_KEY.test(key) || EXCEPTION_MESSAGE_KEYS.has(key)) {
        return maskText(value);
    }
    if (key.startsWith(`attr__`)) {
        return maskAttribute(key.slice(6), value);
    }
    if (key === `attr_id`) {
        return maskAttribute(`id`, value);
    }
    return ADDRESS_KEY.test(key) ? redact(value) : value;
};

const MAX_DEPTH = 8;

type Redact = (address: string) => string;

const sanitize = (value: JsonType, key: string, redact: Redact, depth: number): JsonType => {
    if (isText(value)) {
        return maskProperty(key, value, redact);
    }
    if (depth >= MAX_DEPTH) {
        return value;
    }
    if (isList(value)) {
        return value.map((item) => sanitize(item, key, redact, depth + 1));
    }
    return isRecord(value) ? sanitizeRecord(value, redact, depth + 1) : value;
};

const sanitizeRecord = (record: JsonRecord, redact: Redact, depth: number): JsonRecord => {
    const out: JsonRecord = {};
    for (const [name, child] of Object.entries(record)) {
        // The heatmap event is keyed by page address, so a key is redacted like a value, and pages that become one
        // pattern keep the points of each.
        const key = /^https?:\/\//i.test(name) ? redact(name) : name;
        const kept = sanitize(child, name, redact, depth);
        const earlier = out[key];
        out[key] = earlier !== undefined && isList(earlier) && isList(kept) ? [...earlier, ...kept] : kept;
    }
    return out;
};

// Exceptions arrive as a list of `{ type, value, stacktrace }`, and only `value` is the message.
const maskExceptionMessages = (properties: JsonRecord): JsonRecord => {
    const list = properties[`$exception_list`];
    if (list === undefined || !isList(list)) {
        return properties;
    }
    return { ...properties, $exception_list: list.map((item) => (isRecord(item) && isText(item[`value`]) ? { ...item, value: maskText(item[`value`]) } : item)) };
};

/**
 * `before_send` for `posthog.init`. The replay's snapshot events are skipped: they are large and already masked by the
 * recorder.
 */
export const eventPrivacy =
    (redact: Redact): BeforeSendFn =>
    (event: CaptureResult | null): CaptureResult | null => {
        if (event === null || event.event === `$snapshot`) {
            return event;
        }
        const clean = (properties: JsonRecord): JsonRecord => maskExceptionMessages(sanitizeRecord(properties, redact, 0));
        const cleaned: CaptureResult = { ...event, properties: clean(event.properties) };
        if (event.$set !== undefined) {
            cleaned.$set = clean(event.$set);
        }
        if (event.$set_once !== undefined) {
            cleaned.$set_once = clean(event.$set_once);
        }
        return cleaned;
    };
