/** What the page counted since the last `take()`. */
export interface ProbeReadout {
    /** Component name → instances mounted. */
    readonly mounts: Readonly<Record<string, number>>;
    /** Component name → re-renders of an already-mounted instance. */
    readonly renders: Readonly<Record<string, number>>;
    readonly mutations: { readonly records: number; readonly added: number; readonly removed: number };
}

export interface ProbeOptions {
    /** `intentic.demo.mode`: which recording the demo serves. */
    readonly mode: string;
    /** `intentic.demo.extensions`: the extensions that start on, pinned so a synced `vendor/` changes nothing. */
    readonly extensions: readonly string[];
    readonly seed: number;
}

/** The page-side half of the harness, reached through `globalThis.perfProbe`. */
export interface Probe {
    /** Reads the counters and zeroes them. */
    readonly take: () => ProbeReadout;
    /**
     * Forces style and layout, then waits two real frames so observers and their follow-up layouts land. Resolves to
     * how many mutations, mounts and renders the page has made in all, so a caller can tell a still page from a busy one.
     */
    readonly flush: () => Promise<number>;
}

/**
 * Init script, registered before Playwright's clock so it captures the real `requestAnimationFrame`. Serialised into
 * the page, so it may close over nothing.
 */
export const installProbe = (options: ProbeOptions): void => {
    const scope = globalThis as unknown as Record<string, unknown>;
    sessionStorage.setItem("intentic.demo.mode", options.mode);
    sessionStorage.setItem("intentic.demo.extensions", JSON.stringify(options.extensions));

    const realFrame = window.requestAnimationFrame.bind(window);

    // mulberry32: every random draw the page makes is the same sequence in every run.
    let state = options.seed >>> 0;
    const random = (): number => {
        state = (state + 0x6d2b79f5) >>> 0;
        let mixed = Math.imul(state ^ (state >>> 15), state | 1);
        mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
        return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
    };
    Math.random = random;
    const fill = <T extends ArrayBufferView | null>(array: T): T => {
        if (array !== null) {
            const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
            for (let index = 0; index < bytes.length; index += 1) {
                bytes[index] = Math.floor(random() * 256);
            }
        }
        return array;
    };
    Crypto.prototype.getRandomValues = fill as Crypto["getRandomValues"];
    Crypto.prototype.randomUUID = (): `${string}-${string}-${string}-${string}-${string}` => {
        const hex = [...fill(new Uint8Array(16))].map((byte, index) => {
            // Version 4, variant 10xx, as a real one reads.
            const shaped = index === 6 ? (byte & 0x0f) | 0x40 : index === 8 ? (byte & 0x3f) | 0x80 : byte;
            return shaped.toString(16).padStart(2, "0");
        });
        const text = hex.join("");
        return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
    };

    const mounts = new Map<string, number>();
    const renders = new Map<string, number>();
    // The subtree an instance last drew; Vue also reports `component:updated` for the owner of every slot it runs.
    const drawn = new WeakMap<object, unknown>();
    // Every mutation record, mount and render since the document began; never reset, so any change moves it.
    let changes = 0;
    const bump = (counts: Map<string, number>, name: string): void => {
        changes += 1;
        counts.set(name, (counts.get(name) ?? 0) + 1);
    };
    interface Instance {
        readonly isMounted: boolean;
        readonly subTree: unknown;
        readonly type: Readonly<Record<string, unknown>>;
    }
    const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
    // Vue's own precedence for a component's name, then the SFC's file name, as its dev tooling infers it.
    const nameOf = ({ type }: Instance): string =>
        text(type["displayName"]) ??
        text(type["name"]) ??
        text(type["__name"]) ??
        /(?<file>[^/\\]+)\.\w+$/u.exec(text(type["__file"]) ?? "")?.groups?.["file"] ??
        "Anonymous";
    // Vue's dev build reports every mount and update to this hook when it exists before the renderer is created.
    scope["__VUE_DEVTOOLS_GLOBAL_HOOK__"] = {
        enabled: false,
        emit: (event: string, _app: unknown, _uid: unknown, _parent: unknown, instance: Instance | undefined): void => {
            if (instance === undefined) {
                return;
            }
            if (event === "component:added") {
                drawn.set(instance, instance.subTree);
                bump(mounts, nameOf(instance));
                return;
            }
            // A slot run during the owner's mount, or by a child that redrew alone, leaves the owner's subtree as it was.
            if (event === "component:updated" && instance.isMounted && drawn.get(instance) !== instance.subTree) {
                drawn.set(instance, instance.subTree);
                bump(renders, nameOf(instance));
            }
        },
        on: (): void => {},
        once: (): void => {},
        off: (): void => {},
    };

    // Motion runs on real time, so what it costs grows with the frames a run happens to get: CSS animations and
    // transitions are switched off, and every SMIL clock (the spinners) is paused before a frame can advance it.
    const still = new CSSStyleSheet();
    still.replaceSync("*, *::before, *::after { animation: none !important; transition: none !important; }");
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, still];
    const pauseMotion = (node: Node): void => {
        if (node instanceof SVGSVGElement) {
            node.pauseAnimations();
        }
        if (node instanceof Element || node instanceof Document) {
            for (const svg of node.querySelectorAll("svg")) {
                svg.pauseAnimations();
            }
        }
    };

    let records = 0;
    let added = 0;
    let removed = 0;
    const tally = (list: readonly MutationRecord[]): void => {
        for (const record of list) {
            changes += 1;
            records += 1;
            added += record.addedNodes.length;
            removed += record.removedNodes.length;
            record.addedNodes.forEach(pauseMotion);
        }
    };
    const observer = new MutationObserver(tally);
    observer.observe(document, { childList: true, attributes: true, characterData: true, subtree: true });

    const probe: Probe = {
        take: () => {
            tally(observer.takeRecords());
            const readout: ProbeReadout = {
                mounts: Object.fromEntries(mounts),
                renders: Object.fromEntries(renders),
                mutations: { records, added, removed },
            };
            mounts.clear();
            renders.clear();
            records = 0;
            added = 0;
            removed = 0;
            return readout;
        },
        flush: () =>
            new Promise((resolve) => {
                pauseMotion(document);
                document.documentElement.getBoundingClientRect();
                realFrame(() =>
                    realFrame(() => {
                        tally(observer.takeRecords());
                        resolve(changes);
                    }),
                );
            }),
    };
    Object.defineProperty(scope, "perfProbe", { value: probe });
};

interface ClockController extends Record<string, unknown> {
    pauseAt: (time: number) => Promise<number>;
}

interface ClockEmbedder {
    setTimeout: (task: () => void, timeout?: number) => () => void;
}

/**
 * Init script, registered after Playwright's clock. Replays its log now, at document start, so the page begins paused
 * at `start` with `performance.now()` at 0, and cancels the real-time timer the clock arms on injection, which would
 * otherwise fire due timers once at a wall-clock moment. Then makes the clock yield between fake timers through a
 * microtask instead of a real task: a real task is a rendering opportunity, so a frame could land between two timers
 * of one step and split their layout in two, or a fetch could finish between them in one run and not the next.
 */
export const pauseClock = (start: number): void => {
    const clock = (globalThis as unknown as Record<string, { controller: ClockController } | undefined>)["__pwClock"];
    if (clock === undefined) {
        throw new Error("perf probe: Playwright's clock is not installed");
    }
    void clock.controller.pauseAt(start);
    // Playwright's own seam between the fake clock and the real one; the harness pins Playwright's version.
    (clock.controller["_embedder"] as ClockEmbedder).setTimeout = (task) => {
        queueMicrotask(task);
        return () => {};
    };
};
