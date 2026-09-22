// Dev-only: names the reactive write behind every component update. `__intenticPerf` says what was slow and the
// browser's own profiler says what ran; neither says WHY a component nothing on screen changed redrew — and an excess
// redraw is a wrong dependency, not a slow one. Off until `__intenticRender.on()`, since the hook runs inside the
// render effect and capturing a stack per trigger is only worth it while someone is reading the answer.
//
//   __intenticRender.on()      start recording
//   __intenticRender.table()   redraws that LANDED, per component, worst first, with the write that caused most of them
//   __intenticRender.why('X')  every write that woke component X, most-frequent first, each with its writer and stack
//   __intenticRender.off()     stop and clear
//
// Both halves are needed and they count different things. A trigger is not a redraw: Vue marks the effect dirty, then
// skips the render if every computed in the way settled on the value it already had — so `triggers` is the ceiling and
// `redraws` is what the screen paid, and a component with many of the first and none of the second is subscribed to
// something noisier than it needs. Redraws are read off Vue's own `app.config.performance` measures, which this turns
// on with recording and off again after, since they are not free.

import { getCurrentInstance, type App, type DebuggerEvent } from "vue";

interface Cause {
    readonly comp: string;
    // `key` as the reactive system names it: `value` for a ref, the property for a reactive object. A computed
    // notifying downstream carries no key at all, which is what `computed` stands for here.
    readonly dep: string;
    // The frame that did the write, which is the thing you can actually go and change.
    readonly writer: string;
    // How that frame was reached, kept from the first occurrence only, for when the writer alone isn't enough.
    readonly stack: readonly string[];
    count: number;
}

const causes = new Map<string, Cause>();
// Landed redraws, keyed by component and instance uid, so "30 redraws" separates one card redrawn thirty times from
// thirty cards redrawn once — a different bug each way.
const redraws = new Map<string, { comp: string; uid: string; mounts: number; renders: number; ms: number }>();
let armed = false;

const nameOf = (): string => {
    const instance = getCurrentInstance();
    const type = instance?.type as { __name?: string; name?: string } | undefined;
    return type?.__name ?? type?.name ?? `anonymous`;
};

const depOf = (event: DebuggerEvent): string => {
    if (event.key === undefined && event.target === undefined) {
        return `computed`;
    }
    const key = typeof event.key === `symbol` ? (event.key.description ?? `symbol`) : String(event.key);
    // The raw target's constructor names the shape (RefImpl, Object, Array, Map), so a bare `value` says which
    // ref-like held it.
    const shape = (event.target as object | undefined)?.constructor?.name ?? `?`;
    return `${event.type} ${shape}.${key}`;
};

// Matched on frame FUNCTION names, not file paths: a dev server that pre-bundles the app (the demo does) puts app code
// and Vue in the same `node_modules/.vite/deps` file, so a path filter drops everything and names nobody. Names are
// compared after their receiver (`Proxy.`, `Object.`) is dropped, which is how V8 prints most of these.
const PLUMBING = new Set([`renderTriggered`, `writerStack`, `depOf`, `nameOf`, `frame`, `?`]);
// Vue's own bundle under any dev server: `vue.runtime.esm-bundler-<hash>.js` when the app is pre-bundled,
// `deps/vue.js` when it isn't. Every frame in it is plumbing whatever it is called.
const VUE_FILE = /^vue[.-]|^chunk-.*vue/u;

// "    at Proxy.fn (http://host/src/a/b.ts?v=1:12:3)" → { fn: "fn", file: "b.ts", at: "fn b.ts:12" }
const frame = (line: string): { fn: string; file: string; at: string } | undefined => {
    const match = /at (?:(?<fn>[^\s(]+) )?\(?(?<url>[^\s)]+?)(?:\?[^\s):]*)?:(?<line>\d+):\d+\)?/u.exec(line);
    if (match?.groups === undefined) {
        return undefined;
    }
    const fn = (match.groups["fn"] ?? `?`).split(`.`).at(-1)!;
    const file = match.groups["url"]!.split(`/`).at(-1)!;
    return { fn, file, at: `${fn} ${file}:${match.groups["line"]}` };
};

// The frames of the write, plumbing stripped: [0] is the writer worth changing, the rest are how it got there.
const writerStack = (): readonly string[] => {
    const raw = (new Error(`trace`).stack?.split(`\n`).slice(1) ?? []).flatMap((line) => frame(line) ?? []);
    const own = raw.filter((entry) => !PLUMBING.has(entry.fn) && !VUE_FILE.test(entry.file));
    // Every frame looked like plumbing (a write made from inside the reactivity core itself): keep the raw top so the
    // row still points somewhere rather than reading `?`.
    return (own.length > 0 ? own : raw).slice(0, 8).map((entry) => entry.at);
};

// Vue times a component as `vue-<type>-<uid>` marks around a `<Name> <type>` measure. The measure carries the name and
// the mark carries the instance, and only together do they say which card redrew — so the two are stitched here.
// PerformanceObserver delivers by start time, which puts the measure with its OPENING mark, never its `:end`.
const fileRedraw = (comp: string, uid: string, type: string, ms: number): void => {
    const key = `${comp}\u0000${uid}`;
    const row = redraws.get(key) ?? { comp, uid, mounts: 0, renders: 0, ms: 0 };
    // `init` counts the mount and `render` counts mount + update; the report subtracts to leave updates alone.
    redraws.set(key, {
        ...row,
        mounts: row.mounts + (type === `init` ? 1 : 0),
        renders: row.renders + (type === `render` ? 1 : 0),
        ms: row.ms + ms,
    });
};

const observeRedraws = (): PerformanceObserver => {
    let opened: { type: string; uid: string } | undefined;
    const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
            const mark = /^vue-(?<type>render|patch|init)-(?<uid>\d+)$/u.exec(entry.name)?.groups;
            if (mark !== undefined) {
                opened = { type: mark["type"]!, uid: mark["uid"]! };
                continue;
            }
            const measure = /^<(?<comp>.+)> (?<type>render|patch|init)$/u.exec(entry.name)?.groups;
            if (measure !== undefined && opened !== undefined && opened.type === measure["type"]) {
                fileRedraw(measure["comp"]!, opened.uid, opened.type, entry.duration);
            }
        }
    });
    observer.observe({ entryTypes: [`measure`, `mark`] });
    return observer;
};

/** Installs the hook. Recording stays off until `__intenticRender.on()`, so an unarmed app pays one boolean per trigger. */
export const installRenderTrace = (app: App): void => {
    app.mixin({
        renderTriggered(event: DebuggerEvent): void {
            if (!armed) {
                return;
            }
            const comp = nameOf();
            const dep = depOf(event);
            const stack = writerStack();
            const writer = stack[0] ?? `?`;
            const key = `${comp}\u0000${dep}\u0000${writer}`;
            const held = causes.get(key);
            if (held === undefined) {
                causes.set(key, { comp, dep, writer, stack, count: 1 });
                return;
            }
            held.count += 1;
        },
    });

    let observer: PerformanceObserver | undefined;

    // One row per component: what it cost the screen, how often it was woken, and the single write behind most wakings.
    const rows = (): readonly {
        comp: string;
        redraws: number;
        instances: number;
        worstInstance: number;
        ms: number;
        triggers: number;
        dep: string;
        writer: string;
    }[] => {
        const totals = new Map<string, { comp: string; redraws: number; instances: number; worstInstance: number; ms: number }>();
        for (const row of redraws.values()) {
            const updates = row.renders - row.mounts;
            const held = totals.get(row.comp) ?? { comp: row.comp, redraws: 0, instances: 0, worstInstance: 0, ms: 0 };
            totals.set(row.comp, {
                comp: row.comp,
                redraws: held.redraws + updates,
                instances: held.instances + 1,
                worstInstance: Math.max(held.worstInstance, updates),
                ms: held.ms + row.ms,
            });
        }
        const woke = new Map<string, { triggers: number; worst: number; dep: string; writer: string }>();
        for (const cause of causes.values()) {
            const held = woke.get(cause.comp) ?? { triggers: 0, worst: 0, dep: ``, writer: `` };
            const top = cause.count > held.worst ? { worst: cause.count, dep: cause.dep, writer: cause.writer } : held;
            woke.set(cause.comp, { ...top, triggers: held.triggers + cause.count });
        }
        // A component woken with nothing to redraw still earns a row: that pairing is the whole point of the report.
        for (const comp of woke.keys()) {
            if (!totals.has(comp)) {
                totals.set(comp, { comp, redraws: 0, instances: 0, worstInstance: 0, ms: 0 });
            }
        }
        return [...totals.values()]
            .map((total) => {
                const cause = woke.get(total.comp);
                return {
                    ...total,
                    ms: Math.round(total.ms),
                    triggers: cause?.triggers ?? 0,
                    dep: cause?.dep ?? ``,
                    writer: cause?.writer ?? ``,
                };
            })
            .toSorted((left, right) => right.redraws - left.redraws || right.triggers - left.triggers);
    };

    (globalThis as unknown as Record<string, unknown>)[`__intenticRender`] = {
        on: (): void => {
            armed = true;
            causes.clear();
            redraws.clear();
            // V8 keeps ten frames by default, and the write that matters sits below the reactivity core's own five.
            Error.stackTraceLimit = 40;
            app.config.performance = true;
            observer ??= observeRedraws();
            console.info(`[render] recording — reproduce the interaction, then __intenticRender.table()`);
        },
        off: (): void => {
            armed = false;
            causes.clear();
            redraws.clear();
            Error.stackTraceLimit = 10;
            app.config.performance = false;
            observer?.disconnect();
            observer = undefined;
            console.info(`[render] stopped`);
        },
        reset: (): void => {
            causes.clear();
            redraws.clear();
        },
        table: (): void => console.table(rows()),
        rows,
        why: (comp: string): readonly Cause[] =>
            [...causes.values()].filter((cause) => cause.comp === comp).toSorted((left, right) => right.count - left.count),
        dump: (): readonly Cause[] => [...causes.values()].toSorted((left, right) => right.count - left.count),
    };
};
