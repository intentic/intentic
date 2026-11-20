import { unstubbed } from "@intentic/testing";
import { call } from "@orpc/server";
import type { OrpcContext } from "../../app-env.js";
import { browsingRoutes } from "./browsing.routes.js";
import type { BrowsingStore } from "./browsing-store.js";
import { parseSuggestions, searchSuggester } from "./search-suggest.js";

// The suggestion route over a faked network: what each engine is asked, what is made of its answer, and what a slow or
// broken engine costs the address bar (nothing).

const context: OrpcContext = {
    headers: new Headers(),
    method: "GET",
    url: "/system/browsing/suggest",
    identity: { email: "ada@example.com", tier: "maintainer", methods: ["google"] },
};

interface Asked {
    readonly url: string;
    readonly headers: Headers;
}

const fakeNetwork = (answer: (url: string) => Response | Promise<Response>) => {
    const asked: Asked[] = [];
    const fetch = async (url: string, init: RequestInit): Promise<Response> => {
        asked.push({ url, headers: new Headers(init.headers) });
        return answer(url);
    };
    return { asked, fetch };
};

const routesOver = (fetch: (url: string, init: RequestInit) => Promise<Response>, timeoutMs = 1500) =>
    browsingRoutes({
        store: unstubbed<BrowsingStore>("store", {}),
        suggest: searchSuggester({ fetch, acceptLanguage: async () => "pl-PL,en-US;q=0.9", timeoutMs }),
    });

test("each engine is asked at its own endpoint, as a browser in the browser's languages, and its answer is the list", async () => {
    const network = fakeNetwork(() => Response.json(["vue", ["vue router", "vuetify", 42]]));
    const routes = routesOver(network.fetch);
    for (const engine of ["brave", "google", "duckduckgo", "bing", "kagi"] as const) {
        expect(await call(routes.searchSuggestions, { q: `vue ${engine}`, engine }, { context })).toEqual({
            q: `vue ${engine}`,
            suggestions: ["vue router", "vuetify"],
        });
    }
    expect(network.asked.map((ask) => ask.url)).toEqual([
        "https://search.brave.com/api/suggest?q=vue%20brave",
        "https://suggestqueries.google.com/complete/search?client=firefox&q=vue%20google",
        "https://duckduckgo.com/ac/?q=vue%20duckduckgo&type=list",
        "https://www.bing.com/osjson.aspx?query=vue%20bing&form=OSDJAS",
        "https://kagi.com/api/autosuggest?q=vue%20kagi",
    ]);
    expect(network.asked[0]?.headers.get("accept-language")).toBe("pl-PL,en-US;q=0.9");
    expect(network.asked[0]?.headers.get("user-agent")).toMatch(/^Mozilla\/5\.0 \(X11; Linux x86_64\)/);
});

test("both answer shapes are read, and anything else suggests nothing", () => {
    expect(parseSuggestions(`["q",["a","b"],[],{"google:suggesttype":[]}]`)).toEqual(["a", "b"]);
    expect(parseSuggestions(`[{"phrase":"vue"},{"phrase":"vueling"}]`)).toEqual(["vue", "vueling"]);
    expect(parseSuggestions(`<html>captcha</html>`)).toEqual([]);
    expect(parseSuggestions(`{"error":"rate limited"}`)).toEqual([]);
});

test("an engine that fails, refuses or does not answer in time is answered as nothing, not an error", async () => {
    const broken = routesOver(fakeNetwork(() => Promise.reject(new TypeError("fetch failed"))).fetch);
    expect(await call(broken.searchSuggestions, { q: "x", engine: "brave" }, { context })).toEqual({ q: "x", suggestions: [] });
    const refusing = routesOver(fakeNetwork(() => new Response("", { status: 429 })).fetch);
    expect(await call(refusing.searchSuggestions, { q: "x", engine: "google" }, { context })).toEqual({ q: "x", suggestions: [] });
    // Never answers on its own; the suggester's own deadline ends the wait.
    const hanging = routesOver(
        async (_url, init) =>
            new Promise<Response>((_resolve, reject) => {
                init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
            }),
        20,
    );
    expect(await call(hanging.searchSuggestions, { q: "x", engine: "kagi" }, { context })).toEqual({ q: "x", suggestions: [] });
});

test("the same text again is answered from the cache; an empty answer is not kept", async () => {
    let empty = true;
    const network = fakeNetwork(() => Response.json(["router", empty ? [] : ["router login"]]));
    const routes = routesOver(network.fetch);
    expect((await call(routes.searchSuggestions, { q: "router", engine: "brave" }, { context })).suggestions).toEqual([]);
    empty = false;
    expect((await call(routes.searchSuggestions, { q: "router", engine: "brave" }, { context })).suggestions).toEqual(["router login"]);
    expect((await call(routes.searchSuggestions, { q: "Router ", engine: "brave" }, { context })).suggestions).toEqual(["router login"]);
    expect(network.asked).toHaveLength(2);
    // Another engine is another question.
    await call(routes.searchSuggestions, { q: "router", engine: "google" }, { context });
    expect(network.asked).toHaveLength(3);
});

test("text the route refuses never reaches an engine", async () => {
    const network = fakeNetwork(() => Response.json(["", []]));
    const routes = routesOver(network.fetch);
    await expect(call(routes.searchSuggestions, { q: "", engine: "brave" }, { context })).rejects.toThrow();
    expect(network.asked).toHaveLength(0);
});
