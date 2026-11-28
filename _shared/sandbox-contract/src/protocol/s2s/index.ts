// The sandbox-to-sandbox protocol's primitives (docs/architecture/messages.md), imported as
// `@intentic/sandbox-contract/s2s`: canonical JSON and its encodings, hybrid key sets and signatures, the identity
// document and the rotation table, addresses and their TXT records, the message envelope, and call sessions. Their
// shapes are schemas/s2s.ts. Pure JavaScript on the @noble libraries, so Node, Bun and a browser run the same code.
export * from "./address.js";
export * from "./canonical.js";
export * from "./envelope.js";
export * from "./identity-doc.js";
export * from "./kem.js";
export * from "./keys.js";
export * from "./session.js";
export * from "./sign.js";
