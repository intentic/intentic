// Shapes a write's RequestInit: method plus a JSON body under the content-type the daemon's parsers require. Its
// own module, not sandboxClient, since tests stub that module whole and a helper living there would vanish for
// them. PUT covers the credential-gate routes, which are genuinely idempotent upserts. `headers` rides beside the
// content type, for a route that reads one by name.
export const jsonBody = (method: `POST` | `PUT` | `DELETE`, payload: unknown, headers?: Readonly<Record<string, string>>): RequestInit => ({
    method,
    headers: { "content-type": `application/json`, ...headers },
    body: JSON.stringify(payload),
});
