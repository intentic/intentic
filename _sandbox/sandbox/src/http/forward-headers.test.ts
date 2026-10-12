import { forwardHeaders, REQUEST_REFRAMED, RESPONSE_REFRAMED } from "./forward-headers.js";

test("hop-by-hop headers and the ones Connection names are never forwarded", () => {
    const from = new Headers({
        connection: "keep-alive, x-secret-hop",
        "x-secret-hop": "1",
        "proxy-authorization": "Basic abc",
        te: "trailers",
        trailer: "x-sum",
        "keep-alive": "timeout=5",
        "x-kept": "yes",
    });
    expect([...forwardHeaders(from).keys()]).toEqual(["x-kept"]);
});

test("a door's own list is dropped too, in any case", () => {
    const from = new Headers({ Host: "a", "Content-Length": "3", "Accept-Encoding": "gzip", Authorization: "Bearer t" });
    expect([...forwardHeaders(from, [...REQUEST_REFRAMED, "Authorization"]).keys()]).toEqual([]);
    const answer = new Headers({ "content-encoding": "gzip", "content-length": "9", "content-type": "text/plain" });
    expect([...forwardHeaders(answer, RESPONSE_REFRAMED).keys()]).toEqual(["content-type"]);
});

test("repeated headers survive the copy", () => {
    const from = new Headers();
    from.append("set-cookie", "a=1");
    from.append("set-cookie", "b=2");
    expect(forwardHeaders(from).getSetCookie()).toEqual(["a=1", "b=2"]);
});
