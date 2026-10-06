// The platform's ingress: every route a machine calls on it, the shapes they carry and the header that names a sandbox.
// Its own entry point (`@intentic/api-contract/ingress`), so the daemon takes these without the editor's contract.
export * from "./headers.js";
export * from "./routes.js";
export * from "./ingress-schemas.js";
