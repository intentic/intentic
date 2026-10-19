import { FRESH_KINDS, type FreshKind } from "@intentic/sandbox-contract/schemas/agent";
import type { IconName } from "@intentic/ui";

// WHAT A FRESH SESSION CAN BE OPENED FOR (schemas/agent.ts FRESH_KINDS), as every surface draws it: the menu that opens
// one, the strip over its composer, its row under the origin's card, and its stamp in that card's corner (stamps.ts). One
// table, so a kind added to the contract shows up everywhere with one glyph and one name (`agents.freshSession.kind.<kind>`).

export const FRESH_ICONS = { review: `list-check`, test: `flask`, ask: `pencil` } as const satisfies Record<FreshKind, IconName>;

// The kinds that check the work, each its own stamp on the origin's card. The reader's own ask is a chat, not a check:
// it hangs under the card and says nothing about the work.
export type CheckKind = Exclude<FreshKind, `ask`>;
export const CHECK_KINDS: readonly CheckKind[] = FRESH_KINDS.filter((kind): kind is CheckKind => kind !== `ask`);
