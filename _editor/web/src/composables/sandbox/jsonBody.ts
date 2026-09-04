/* The init a WRITE to the daemon carries, the method, plus a JSON body under the content-type the daemon's
 * parsers require. It was written out as a four-line literal at 41 call sites, which is 41 chances to leave the
 * header off; a request that does is refused by the body parser at runtime, where nothing in the type system
 * was ever going to catch it. The method is a parameter rather than an assumed POST because three routes delete.
 *
 * ITS OWN MODULE, not part of sandboxClient, and that is the whole reason this file exists. sandboxClient
 * reaches the active sandbox, the endpoint, the session token and the perf tracker at module scope, so every
 * suite that drives a composable stubs it whole (`vi.mock("./sandboxClient", …)`). A pure request-shaper living
 * in there would be undefined in each of those suites the moment its owner started using it, a trap that
 * springs on whoever writes the next test, not on whoever moved the helper. Nothing to stub here.
 *
 * PUT joined the list for the credential gates, which upsert a policy under the subject in their own path:
 * "put this gate here, replacing whatever was there" is what the route does, and spelling it POST would have
 * made the one route in the daemon that is genuinely idempotent claim otherwise. */
export const jsonBody = (method: `POST` | `PUT` | `DELETE`, payload: unknown): RequestInit => ({
    method,
    headers: { "content-type": `application/json` },
    body: JSON.stringify(payload),
});
