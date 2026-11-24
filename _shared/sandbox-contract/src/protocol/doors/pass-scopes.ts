// What a pass admits its holder to at the receiving sandbox (docs/architecture/account-routing.md). `report`: a problem
// filed into the issues inbox about a project the receiver claims, every pass before scopes existed. The rest route AS A
// PERSON, with that person's own access there, and are admitted only beside the pairing secret that person gave the
// sending sandbox at the receiver (the platform's word alone opens nothing but an inbox): `drop` a note or files into
// it, `read` the conversations and records that person may read there, `task` start work there as them.
export const PASS_SCOPES = ["report", "drop", "read", "task"] as const;
export type PassScope = (typeof PASS_SCOPES)[number];

// The header the pairing secret rides beside a pass on every scope but `report` (docs/architecture/account-routing.md):
// what the person gave the asking sandbox, from the receiving one, so the platform's signature alone opens no more than
// an inbox.
export const ROUTE_SECRET_HEADER = "x-intentic-route-secret";
