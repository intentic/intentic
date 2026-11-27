import type { PublicRouteContribution } from "@intentic/extension-manifest";
import {
    EXTENSION_SLEEP_HOOK_MS,
    type ExtensionSleepBoot,
    type ExtensionSleepFrame,
    type ExtensionSleepHeard,
    ExtensionSleepReadySchema,
    ExtensionWakeUrlAskSchema,
    extensionSleepBootUrl,
    extensionSleepHeardUrl,
    extensionSleepReadyUrl,
    extensionSleepWatchUrl,
    extensionWakeUrlUrl,
    publicDoorPath,
    WAKE_DOOR_PARAM,
} from "@intentic/sandbox-contract/extension-protocol";

// (2026-11-27) The daemon's side of `api.sleep` for `fakeExtensionApi` (testing.ts): wake URLs judged against the
// manifest's `wakes` routes as the daemon judges them, the boot facts the test sets, and a sleep handed to every
// before-sleep watch, resolved once each answered ready or the hook's deadline passed, as the daemon waits.

// Where the fake sandbox answers, and the wake secret every URL it hands out carries.
export const FAKE_PUBLIC_URL = "https://sandbox-fake.sbx.test";
export const FAKE_WAKE_SECRET = "fake-wake-secret";

type WakesRoute = Pick<PublicRouteContribution, "path" | "automation" | "wakes">;

const json = <T>(body: T, status = 200): Response => Response.json(body, { status });

// The concrete path a wake URL names, or why there is none (the daemon's own refusal words).
const concretePath = (routes: readonly WakesRoute[], route: string, automationId: string | undefined): { readonly path: string } | { readonly error: string } => {
    const declared = routes.find((each) => each.path === route && each.wakes === true);
    if (declared === undefined) {
        return { error: `no public route "${route}" declares \`wakes: true\`` };
    }
    if ((declared.automation === true) !== (automationId !== undefined)) {
        return { error: declared.automation === true ? `the route "${route}" is an automation's: name it` : `the route "${route}" is no automation's` };
    }
    return { path: route.replace("*", automationId ?? "*") };
};

export interface FakeSleep {
    // The extension's sleep doors; undefined for a request that is for none of them.
    readonly door: (request: Request, url: URL, signal: AbortSignal | null) => Promise<Response | undefined>;
    // The hosted machine about to sleep now: every before-sleep watch told, resolved once each answered ready or the
    // deadline passed. Answers how many watches answered.
    readonly now: () => Promise<number>;
    // What `api.sleep.boot()` answers; neither by default.
    boot: ExtensionSleepBoot;
    // Every wake URL handed out, in order.
    readonly wakeUrls: readonly string[];
    // (2026-11-27) What `api.sleep.heard()` answers next; it is handed over once, as the platform does, and then empty.
    heard: ExtensionSleepHeard["heard"];
}

export const fakeSleep = (id: string, routes: readonly WakesRoute[]): FakeSleep => {
    const encoder = new TextEncoder();
    const watches = new Set<ReadableStreamDefaultController<Uint8Array>>();
    const waiting = new Map<string, () => void>();
    const wakeUrls: string[] = [];
    let sleeps = 0;
    const write = (watch: ReadableStreamDefaultController<Uint8Array>, frame: ExtensionSleepFrame): void => {
        try {
            watch.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
        } catch {
            // allow(silent-catch): a watch the extension already let go of is no longer one to tell
            watches.delete(watch);
        }
    };
    const watchStream = (signal: AbortSignal | null): Response => {
        let held: ReadableStreamDefaultController<Uint8Array> | undefined;
        const drop = (): void => {
            if (held !== undefined) {
                watches.delete(held);
            }
        };
        const body = new ReadableStream<Uint8Array>({
            start: (controller) => {
                held = controller;
                watches.add(controller);
                write(controller, { kind: "heartbeat" });
            },
            cancel: drop,
        });
        signal?.addEventListener("abort", drop);
        return new Response(body, { headers: { "content-type": "application/x-ndjson" } });
    };
    const wakeUrl = async (request: Request): Promise<Response> => {
        const asked = ExtensionWakeUrlAskSchema.safeParse(await request.json());
        const named = asked.success ? concretePath(routes, asked.data.route, asked.data.automationId) : { error: "a wake URL is asked for { route, automationId? }" };
        if ("error" in named) {
            return json(named, 400);
        }
        const minted = `${FAKE_PUBLIC_URL}${publicDoorPath(id, named.path)}?${WAKE_DOOR_PARAM}=${FAKE_WAKE_SECRET}`;
        wakeUrls.push(minted);
        return json({ url: minted });
    };
    const ready = async (request: Request): Promise<Response> => {
        const answered = ExtensionSleepReadySchema.safeParse(await request.json());
        if (answered.success) {
            waiting.get(answered.data.id)?.();
        }
        return json({ ok: true });
    };
    // Each door by its `METHOD path`, as the daemon registers them.
    const doors = new Map<string, (request: Request, signal: AbortSignal | null) => Promise<Response> | Response>([
        [`POST ${extensionWakeUrlUrl()}`, wakeUrl],
        [`GET ${extensionSleepBootUrl()}`, () => json(fake.boot)],
        [`POST ${extensionSleepWatchUrl()}`, (_request, signal) => watchStream(signal)],
        [`POST ${extensionSleepReadyUrl()}`, ready],
        [
            `POST ${extensionSleepHeardUrl()}`,
            () => {
                const heard = fake.heard;
                fake.heard = [];
                return json({ heard });
            },
        ],
    ]);
    const fake: FakeSleep = {
        boot: { afterSleep: false, requestWake: false },
        wakeUrls,
        heard: [],
        door: async (request, url, signal) => doors.get(`${request.method} ${url.pathname}`)?.(request, signal),
        now: async () => {
            sleeps += 1;
            const told = [...watches].map((watch, index) => {
                const sleepId = `sleep-${sleeps}-${index}`;
                const answered = new Promise<boolean>((resolve) => {
                    waiting.set(sleepId, () => resolve(true));
                    setTimeout(() => resolve(false), EXTENSION_SLEEP_HOOK_MS).unref();
                });
                write(watch, { kind: "sleep", id: sleepId, deadline: Date.now() + EXTENSION_SLEEP_HOOK_MS });
                return answered;
            });
            return (await Promise.all(told)).filter(Boolean).length;
        },
    };
    return fake;
};
