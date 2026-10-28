import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const page = readFileSync(new URL(`../../public/offline.html`, import.meta.url), `utf8`);
const script = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)?.[1];
if (script === undefined) {
    throw new Error(`offline.html must contain its recovery script`);
}

// Run the shipped page's script, with reduced motion and no real timers or network, and record its navigations.
const recovery = async (to: string, origin: string | null = `https://app.intentic.dev`, extra = ``) => {
    const makeElement = () => ({
        style: {},
        classList: { add: jest.fn(), remove: jest.fn() },
        listeners: new Map<string, () => void>(),
        setAttribute: jest.fn(),
        getBoundingClientRect: jest.fn(),
        addEventListener(type: string, listener: () => void) {
            this.listeners.set(type, listener);
        },
    });
    const elements = new Map<string, ReturnType<typeof makeElement>>();
    const element = (id: string) => {
        let found = elements.get(id);
        if (found === undefined) {
            found = makeElement();
            elements.set(id, found);
        }
        return found;
    };
    const navigations: string[] = [];
    const online = jest.fn(async () => true);
    const fetch = jest.fn(() => {
        throw new Error(`unexpected network request`);
    });
    runInNewContext(
        script,
        {
            URL,
            URLSearchParams,
            Promise,
            window: {
                __INTENTIC_EDITOR_ORIGIN__: origin ?? undefined,
                __TAURI_INTERNALS__: { invoke: online },
                matchMedia: () => ({ matches: true }),
                addEventListener: jest.fn(),
            },
            document: { documentElement: element(`root`), getElementById: element },
            location: {
                protocol: `http:`,
                host: `tauri.localhost`,
                search: `?${new URLSearchParams({ to })}${extra}`,
                replace: (url: string) => {
                    navigations.push(url);
                },
            },
            navigator: { language: `en`, onLine: true },
            localStorage: { getItem: () => null },
            setTimeout: jest.fn(),
            clearTimeout: jest.fn(),
            setInterval: jest.fn(),
            fetch,
        },
        { timeout: 1000 },
    );
    const retry = element(`retry`).listeners.get(`click`);
    if (retry === undefined) {
        throw new Error(`the recovery page must offer a retry`);
    }
    retry();
    await Promise.resolve();
    return { navigations, probes: online.mock.calls.length, requests: fetch.mock.calls.length };
};

describe(`offline recovery destinations`, () => {
    it(`returns to the configured editor with its path, query and fragment`, async () => {
        const to = `https://app.intentic.dev/workspace?x=1#chat`;
        expect(await recovery(to)).toEqual({ navigations: [to], probes: 1, requests: 0 });
    });

    it(`honours a configured development origin and its port`, async () => {
        const to = `http://localhost:47145/workspace`;
        expect(await recovery(to, `http://localhost:47145`)).toEqual({ navigations: [to], probes: 1, requests: 0 });
        expect(await recovery(`http://localhost:47146/`, `http://localhost:47145`)).toEqual({ navigations: [], probes: 0, requests: 0 });
    });

    it(`ignores external, misleading, credentialed, malformed and script destinations`, async () => {
        const credentialed = new URL(`https://app.intentic.dev/`);
        credentialed.username = `user`;
        credentialed.password = `password`;
        for (const to of [
            `https://evil.example/login`,
            `https://app.intentic.dev.evil.example/`,
            `https://app.intentic.dev@evil.example/`,
            `http://app.intentic.dev/`,
            `https://app.intentic.dev:444/`,
            credentialed.href,
            `//evil.example/`,
            `/workspace`,
            `javascript:alert(1)`,
            `data:text/html,evil`,
            `https://`,
            ``,
        ]) {
            expect(await recovery(to)).toEqual({ navigations: [], probes: 0, requests: 0 });
        }
    });

    it(`requires the native origin and never takes it from a query parameter`, async () => {
        expect(await recovery(`https://app.intentic.dev/`, null)).toEqual({ navigations: [], probes: 0, requests: 0 });
        expect(await recovery(`https://evil.example/`, null, `&origin=https://evil.example`)).toEqual({ navigations: [], probes: 0, requests: 0 });
        expect(await recovery(`https://app.intentic.dev/`, ``)).toEqual({ navigations: [], probes: 0, requests: 0 });
    });
});
