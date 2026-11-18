import {
    freshNavigation,
    loadingChanged,
    navigationCommitted,
    navigationFailed,
    navigationFields,
    navigationStarted,
    type NavigationState,
} from "./page-navigation.js";

// A request is only ever compared by identity, so a labelled object stands for one.
interface FakeRequest {
    readonly label: string;
}
const request = (label: string): FakeRequest => ({ label });
const fresh = (): NavigationState<FakeRequest> => freshNavigation<FakeRequest>();

const ERROR_PAGE = "chrome-error://chromewebdata/";

describe("a tab between two addresses", () => {
    test("a navigation that has set off is listed as loading, with where it waits and since when", () => {
        const state = fresh();
        navigationStarted(state, request("first"), "http://192.168.0.103:9120/auth/external/oidc/login", null, 1_000);
        expect(navigationFields(state, "http://192.168.0.103:9120/login")).toEqual({
            url: "http://192.168.0.103:9120/login",
            loading: true,
            navigation: { url: "http://192.168.0.103:9120/auth/external/oidc/login", since: 1_000 },
        });
    });

    test("a redirect hop names the host it waits on now and keeps when the navigation set off", () => {
        const state = fresh();
        const first = request("first");
        navigationStarted(state, first, "http://komodo/auth/login", null, 1_000);
        navigationStarted(state, request("second"), "http://gitlab/oauth/authorize", first, 1_400);
        expect(navigationFields(state, "http://komodo/login").navigation).toEqual({ url: "http://gitlab/oauth/authorize", since: 1_000 });
    });

    test("a new navigation in place of one in flight starts its own clock", () => {
        const state = fresh();
        navigationStarted(state, request("first"), "http://a/", null, 1_000);
        navigationStarted(state, request("second"), "http://b/", null, 2_000);
        expect(navigationFields(state, "http://start/").navigation).toEqual({ url: "http://b/", since: 2_000 });
    });

    test("arriving clears what was in flight, and the tab rests once Chromium stops loading", () => {
        const state = fresh();
        expect(loadingChanged(state, true)).toBe(true);
        navigationStarted(state, request("first"), "http://b/", null, 1_000);
        navigationCommitted(state, "http://b/");
        expect(navigationFields(state, "http://b/")).toEqual({ url: "http://b/", loading: true });
        expect(loadingChanged(state, false)).toBe(true);
        expect(navigationFields(state, "http://b/")).toEqual({ url: "http://b/" });
    });

    test("stopping with nothing committed (the stop button, a 204, a download) leaves nothing in flight", () => {
        const state = fresh();
        loadingChanged(state, true);
        navigationStarted(state, request("first"), "http://slow/", null, 1_000);
        expect(loadingChanged(state, false)).toBe(true);
        expect(navigationFields(state, "http://start/")).toEqual({ url: "http://start/" });
        expect(loadingChanged(state, false)).toBe(false);
    });

    test("a failure shows the address that failed and why, while the page is Chromium's error page", () => {
        const state = fresh();
        const going = request("first");
        navigationStarted(state, going, "http://192.168.0.168/oauth/authorize", null, 1_000);
        expect(navigationFailed(state, going, "http://192.168.0.168/oauth/authorize", "net::ERR_CONNECTION_TIMED_OUT")).toBe(true);
        navigationCommitted(state, ERROR_PAGE);
        expect(navigationFields(state, ERROR_PAGE)).toEqual({
            url: "http://192.168.0.168/oauth/authorize",
            error: "net::ERR_CONNECTION_TIMED_OUT",
        });
    });

    test("a failure that left the page where it was says nothing: only the error page has an error to tell", () => {
        const state = fresh();
        const going = request("first");
        navigationStarted(state, going, "http://gone/", null, 1_000);
        navigationFailed(state, going, "http://gone/", "net::ERR_BLOCKED_BY_CLIENT");
        expect(navigationFields(state, "http://start/")).toEqual({ url: "http://start/" });
    });

    test("an aborted navigation (stopped, replaced, a download) is no failure", () => {
        const state = fresh();
        const going = request("first");
        navigationStarted(state, going, "http://file/download", null, 1_000);
        expect(navigationFailed(state, going, "http://file/download", "net::ERR_ABORTED")).toBe(true);
        expect(navigationFields(state, ERROR_PAGE)).toEqual({ url: ERROR_PAGE });
    });

    test("a request that is not the navigation in flight changes nothing", () => {
        const state = fresh();
        navigationStarted(state, request("first"), "http://a/", null, 1_000);
        expect(navigationFailed(state, request("other"), "http://a/", "net::ERR_FAILED")).toBe(false);
        expect(navigationFields(state, "http://start/").navigation).toEqual({ url: "http://a/", since: 1_000 });
    });

    test("arriving anywhere past the error page forgets the failure", () => {
        const state = fresh();
        const going = request("first");
        navigationStarted(state, going, "http://gone/", null, 1_000);
        navigationFailed(state, going, "http://gone/", "net::ERR_NAME_NOT_RESOLVED");
        navigationCommitted(state, ERROR_PAGE);
        navigationCommitted(state, "http://back/");
        expect(navigationFields(state, ERROR_PAGE)).toEqual({ url: ERROR_PAGE });
    });
});
