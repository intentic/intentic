// Shapes a write's RequestInit: method plus a JSON body under the content-type the daemon's parsers require. Its
// own module, not sandboxClient, since tests stub that module whole and a helper living there would vanish for
// them. PUT covers the credential-gate routes, which are genuinely idempotent upserts.
export const jsonBody = (method: `POST` | `PUT` | `DELETE`, payload: unknown): RequestInit => ({
    method,
    headers: { "content-type": `application/json` },
    body: JSON.stringify(payload),
});
