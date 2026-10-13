import type { SandboxSettings } from "@intentic/sandbox-contract";
import { z } from "zod";

// Which settings a change touched, as an audit record says it: dotted keys, one level into a nested block (`audit.
// forwardUrl`, `retention.transcriptDays`), and the old and new value only where it is a switch or a number. Text is
// never copied: a setting's text can be a system prompt, a rule someone wrote or an address, and the record only has
// to say that it changed.

type Json = z.infer<ReturnType<typeof z.json>>;

// A type rather than an interface so it reads as JSON where an audit record's details are typed as JSON.
export type SettingChange = {
    readonly key: string;
    from?: boolean | number;
    to?: boolean | number;
};

// Whole settings, or the blocks of them a caller compares (the audit tick compares `audit` alone).
export type SettingsPart = Readonly<Partial<SandboxSettings>>;

const asObject = (value: SettingsPart): Readonly<Record<string, Json>> => z.record(z.string(), z.json()).parse(JSON.parse(JSON.stringify(value)));

const isBlock = (value: Json | undefined): value is { readonly [key: string]: Json } => value instanceof Object && !Array.isArray(value);

const scalar = (value: Json | undefined): boolean | number | undefined =>
    value === true || value === false ? value : Number.isFinite(value) ? Number(value) : undefined;

const change = (key: string, before: Json | undefined, after: Json | undefined): SettingChange => {
    const from = scalar(before);
    const to = scalar(after);
    const result: SettingChange = { key };
    if (from !== undefined) {
        result.from = from;
    }
    if (to !== undefined) {
        result.to = to;
    }
    return result;
};

const same = (a: Json | undefined, b: Json | undefined): boolean => JSON.stringify(a) === JSON.stringify(b);

export const settingsDiff = (beforeValue: SettingsPart, afterValue: SettingsPart): SettingChange[] => {
    const before = asObject(beforeValue);
    const after = asObject(afterValue);
    const changes: SettingChange[] = [];
    for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].toSorted()) {
        const [old, now] = [before[key], after[key]];
        if (same(old, now)) {
            continue;
        }
        if (isBlock(old) && isBlock(now)) {
            for (const inner of [...new Set([...Object.keys(old), ...Object.keys(now)])].toSorted()) {
                if (!same(old[inner], now[inner])) {
                    changes.push(change(`${key}.${inner}`, old[inner], now[inner]));
                }
            }
            continue;
        }
        changes.push(change(key, old, now));
    }
    return changes;
};
