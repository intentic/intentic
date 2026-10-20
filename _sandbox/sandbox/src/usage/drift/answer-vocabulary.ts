import type { JsonValue } from "@intentic/base/json";
import type { Logger } from "pino";
import { z } from "zod";
import { defineDocument } from "../../store/evolution/documents.js";
import { jsonFile } from "../../store/json-file.js";

// What each provider's usage answers have been made of, so a changed answer is noticed the day it changes rather than the
// day a number turns out wrong. Every reader parses a private, undocumented endpoint, and parses defensively: a field it
// does not know costs a ring, never an exception, which is exactly why a changed answer is otherwise silent.
//
// An answer's vocabulary is its paths, each array element named by the value that identifies it (a bucket's id, a
// group's display name, a limit's kind), so a pool that appears or disappears changes it even when every field name
// stays the same: that is how Google dropped its Gemini group on 2026-10-19. Each path ever seen is remembered; one
// never seen before is said once, and a redacted sample of the answer is kept beside it to rebuild a test fixture from.
// A path that stops appearing is not said here: a pool that goes missing is (drift/continuity.ts), and a field that
// goes missing without a pool doing so costs nothing a reader uses.

const VocabularySchema = z.object({
    // Each path ever seen, to when it was last seen (ms).
    paths: z.record(z.string(), z.number()),
    // The answer that last brought a new path, redacted (sampleOf), as JSON text.
    sample: z.string().optional(),
    changedAt: z.number().optional(),
});
type Vocabulary = z.infer<typeof VocabularySchema>;

export const providerAnswersDocument = defineDocument({
    root: "history",
    path: "provider-answers.json",
    // What each provider's usage answers have been made of (their paths, and one redacted sample), so an answer that
    // changes is noticed. Carried: the provider answers the same wherever the sandbox runs, and a fresh record would
    // take the next changed answer as the first one.
    portability: "carry",
    schema: VocabularySchema,
    granularity: "record",
});

// The keys whose value names what an array element is, first present wins.
const IDENTITY_KEYS = ["bucketId", "bucket_id", "kind", "limit_name", "limitName", "metered_feature", "meteredFeature", "id", "displayName", "display_name", "name"];
// Objects nested this deep are one leaf: past it an answer is configuration (prompt experiments, MIME lists), and its
// churn is no change to anything a reader parses.
const MAX_DEPTH = 4;
// A key or text that could be the account's own: an address, a uuid, a token, or prose.
const PRIVATE = /@|^[\da-f]{8}-[\da-f]{4}-|^[\w+/=-]{32,}$/i;
// An opaque id: a run this long mixing digits with both cases (`user-fzKHgAEGwonHdpL1uIZhEprH`), which no model id,
// pool name or enum value is.
const OPAQUE_RUN = /[A-Za-z\d]{12,}/g;
const opaque = (text: string): boolean => (text.match(OPAQUE_RUN) ?? []).some((run) => /\d/.test(run) && /[a-z]/.test(run) && /[A-Z]/.test(run));
// Keys whose value is who the account is, whatever it looks like.
const WHO = /^(user|account|org|organization|workspace|project)(_?id)?$|^email$/i;
const MAX_SHOWN = 48;
// Paths said in one line, and paths remembered per endpoint.
const SAID_PATHS = 20;
const KEPT_PATHS = 2_000;
// Paths unseen this long are forgotten, so a pool that comes back after a month is said again.
const FORGET_AFTER_MS = 30 * 24 * 60 * 60_000;
// How stale a path's last sighting may get before an otherwise unchanged answer is written to refresh it.
const REFRESH_EVERY_MS = 24 * 60 * 60_000;

const Text = z.string();
// A primitive that can name an element: text or a number, never a nested value.
const Name = z.union([z.string(), z.number()]);

const shown = (text: string): string => (text.length > MAX_SHOWN || PRIVATE.test(text) || opaque(text) ? "*" : text);

const isRecord = (value: JsonValue): value is { readonly [key: string]: JsonValue } => value instanceof Object && !Array.isArray(value);

const identityOf = (value: JsonValue): string => {
    if (!isRecord(value)) {
        return "";
    }
    for (const key of IDENTITY_KEYS) {
        const named = Name.safeParse(value[key]);
        if (named.success) {
            return `${key}=${shown(String(named.data))}`;
        }
    }
    return "";
};

const walk = (value: JsonValue, path: string, depth: number, into: Set<string>): void => {
    if (Array.isArray(value)) {
        if (value.length === 0) {
            into.add(`${path}[]`);
        }
        for (const item of value) {
            walk(item, `${path}[${identityOf(item)}]`, depth, into);
        }
        return;
    }
    // A null says nothing of what the field holds when it holds something (Codex answers `secondary_window: null` on a
    // plan with no weekly pool), and a leaf is its path alone: a figure is the same field whatever its type.
    if (value === null) {
        return;
    }
    if (!isRecord(value) || depth >= MAX_DEPTH) {
        into.add(path);
        return;
    }
    for (const [key, child] of Object.entries(value)) {
        walk(child, path === "" ? shown(key) : `${path}.${shown(key)}`, depth + 1, into);
    }
};

/** The answer's paths, sorted: what a reader would have to understand to read all of it. */
export const answerPaths = (answer: JsonValue): string[] => {
    const into = new Set<string>();
    walk(answer, "", 0, into);
    return [...into].toSorted();
};

/** The answer with anything that could be the account's own replaced, for a fixture to be rebuilt from. */
export const sampleOf = (answer: JsonValue): JsonValue => {
    const text = Text.safeParse(answer);
    if (text.success) {
        return shown(text.data);
    }
    if (Array.isArray(answer)) {
        return answer.map(sampleOf);
    }
    return isRecord(answer)
        ? Object.fromEntries(Object.entries(answer).map(([key, child]) => [shown(key), WHO.test(key) && Text.safeParse(child).success ? "*" : sampleOf(child)]))
        : answer;
};

export interface AnswerWatch {
    // Notes one answer from `endpoint` (e.g. `gemini:retrieveUserQuotaSummary`). Never rejects and never delays the
    // reading it rode in on.
    readonly observe: (endpoint: string, answer: JsonValue) => void;
    // Two of a provider's own sources gave different figures for one pool (`readings`, utilization percents).
    readonly disagree: (endpoint: string, pool: string, readings: readonly number[]) => void;
}

// How often one pool's disagreement is said while it stands: every sweep of every account repeats it.
const DISAGREE_SAID_EVERY_MS = 60 * 60_000;

const StoredSchema = z.record(z.string(), VocabularySchema);

export const fileAnswerWatch = (path: string, logger: Logger): AnswerWatch => {
    const file = jsonFile<Record<string, Vocabulary>>(path, {
        parse: (raw) => StoredSchema.safeParse(raw).data,
        fallback: () => ({}),
        document: providerAnswersDocument,
    });
    // What was last written per endpoint, so an unchanged answer costs no file read.
    const known = new Map<string, Vocabulary>();

    const note = async (endpoint: string, answer: JsonValue): Promise<void> => {
        const now = Date.now();
        const before = known.get(endpoint) ?? (await file.read())[endpoint];
        const paths = answerPaths(answer);
        const added = before === undefined ? [] : paths.filter((entry) => !(entry in before.paths));
        const stale = before !== undefined && paths.some((entry) => now - (before.paths[entry] ?? 0) > REFRESH_EVERY_MS);
        if (before !== undefined && added.length === 0 && !stale) {
            known.set(endpoint, before);
            return;
        }
        if (added.length > 0) {
            logger.warn(
                { endpoint, added: added.slice(0, SAID_PATHS), addedCount: added.length },
                "provider answer: a usage answer carries fields or pools never seen from this endpoint before; a reader that does not know them ignores them",
            );
        }
        const remembered = Object.entries(before?.paths ?? {}).filter(([, at]) => now - at < FORGET_AFTER_MS);
        // The first answer is a sample too: the fixture an endpoint starts from.
        const resampled = before === undefined || added.length > 0;
        const next: Vocabulary = {
            paths: Object.fromEntries([...remembered, ...paths.map((entry) => [entry, now] as const)].slice(-KEPT_PATHS)),
            sample: resampled ? JSON.stringify(sampleOf(answer)) : before.sample,
            changedAt: resampled ? now : before.changedAt,
        };
        known.set(endpoint, next);
        await file.update((current) => ({ ...current, [endpoint]: next }));
    };

    const disagreedAt = new Map<string, number>();
    return {
        disagree: (endpoint, pool, readings) => {
            const key = `${endpoint}\n${pool}`;
            if (Date.now() - (disagreedAt.get(key) ?? Number.NEGATIVE_INFINITY) < DISAGREE_SAID_EVERY_MS) {
                return;
            }
            disagreedAt.set(key, Date.now());
            logger.warn(
                { endpoint, pool, readings },
                "provider answer: two of the provider's own sources disagree about one pool, so one of them is read wrong or changed what it reports",
            );
        },
        observe: (endpoint, answer) => {
            void (async () => {
                try {
                    await note(endpoint, answer);
                } catch (error) {
                    logger.warn({ err: error, endpoint }, "provider answer: could not note what a usage answer was made of");
                }
            })();
        },
    };
};
