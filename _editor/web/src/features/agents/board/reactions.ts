import type { AgentReaction } from "@intentic/sandbox-contract";

// The marks on a conversation, as a row of chips draws them. Pure, so the two hosts (the board card and the session's
// own page) cannot group or count the same reactions differently.

// Drawn without opening anything, because they are the two answers a board is actually asked for. Everything else is
// one press further in, which is the right price for the difference in how often they are wanted.
export const QUICK_EMOJI = [`👍`, `👎`] as const;

// The picker's grid, in eights: this IS the vocabulary, since nothing here takes a typed emoji, so it has to hold both
// the verdicts a board gets marked with and enough of the ordinary ones that a person is not made to settle.
// Rows read as groups — verdicts, warnings and the work itself, counts and thanks, faces, then tools and states.
export const PICKER_EMOJI = [
    `👍`,
    `👎`,
    `❤️`,
    `🎉`,
    `🚀`,
    `👀`,
    `🔥`,
    `✅`,

    `❌`,
    `⚠️`,
    `🛑`,
    `🚧`,
    `🤔`,
    `💡`,
    `🐛`,
    `🧪`,

    `🧹`,
    `🔒`,
    `📦`,
    `📈`,
    `📉`,
    `⏳`,
    `⏱️`,
    `💸`,

    `💯`,
    `🙏`,
    `🙌`,
    `👏`,
    `🤝`,
    `💪`,
    `👌`,
    `🤞`,

    `😄`,
    `😂`,
    `🥳`,
    `😅`,
    `😬`,
    `😭`,
    `🤯`,
    `🫠`,

    `🫡`,
    `🤖`,
    `🧠`,
    `🎯`,
    `⚡`,
    `✨`,
    `🪄`,
    `⭐`,

    `🔧`,
    `🔨`,
    `🧩`,
    `📌`,
    `📝`,
    `🔍`,
    `🗑️`,
    `♻️`,

    `🍀`,
    `☕`,
    `🌙`,
    `🏁`,
    `🥇`,
    `📊`,
    `🔗`,
    `🫶`,
] as const;

// Where a hover stops being a list of people and starts being a wall of text. The count on the chip is still exact;
// only the names are cut.
const NAMES_SHOWN = 24;

// One chip: the mark, how many wear it, whether the reader is one of them, and the line the hover prints.
export interface ReactionChip {
    readonly emoji: string;
    readonly count: number;
    readonly mine: boolean;
    readonly who: string;
}

// Addresses are compared folded, because the same person reaches a sandbox as Ada@example.com from one sign-in and
// ada@example.com from another, and a chip that then fails to light is a chip they press twice.
const sameEmail = (left: string, right: string | undefined): boolean => right !== undefined && left.toLowerCase() === right.toLowerCase();

export const reactionChips = (
    reactions: readonly AgentReaction[] | undefined,
    reader: { readonly me: string | undefined; readonly you: string },
): ReactionChip[] =>
    (reactions ?? []).map((reaction) => {
        // The reader reads as "you" rather than as their own address: a name they have to recognize as themselves is
        // the one name in the list they should not have to.
        const names = reaction.by.map((who) => (sameEmail(who.email, reader.me) ? reader.you : (who.name ?? who.email)));
        const shown = names.slice(0, NAMES_SHOWN);
        return {
            emoji: reaction.emoji,
            count: reaction.by.length,
            mine: reaction.by.some((who) => sameEmail(who.email, reader.me)),
            who: names.length > shown.length ? `${shown.join(`, `)} +${names.length - shown.length}` : shown.join(`, `),
        };
    });
