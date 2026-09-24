/** A pure-JS hot path measured in instructions: `setup` is counted in both runs and cancels, `work` is what is judged. */
export interface Scenario {
    /** One line naming the production path this stands for and the input it is fed. */
    readonly what: string;
    /** Imports and builds the input; the returned function is the measured work, and its result is kept alive. */
    readonly setup: () => Promise<Work> | Work;
}

/** Throws when its result is not what the input must produce, so a count can never be of work that silently stopped. */
export type Work = () => unknown;
