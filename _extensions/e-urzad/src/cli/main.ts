import { errorMessage } from "@intentic/base/errors";
import { cardsInEnv } from "../core/cards.js";
import { runApproved } from "./approved.js";
import { type Context, contextOf, print, UsageError } from "./context.js";
import { ED_USAGE, runEd } from "./ed.js";
import { EZD_USAGE, runEzd } from "./ezd.js";
import { runTrust, runVerify, VERIFY_USAGE } from "./signatures.js";

// `e-urzad`: the agent's command for a Polish public office's systems, reached through bin/e-urzad on its PATH. Inert
// until an office connects an EZD RP or e-Doręczenia card; `verify` works with no card at all.

const USAGE = `e-urzad: EZD RP cases and documents, e-Doręczenia deliveries and proofs, electronic signatures.
Every office write is held for a person's approval, or refused by the sandbox's action rules.

  e-urzad cards                 the connected office cards in this shell
${EZD_USAGE}
${ED_USAGE}
${VERIFY_USAGE}
Approved office acts are carried out by the sandbox itself; nothing here performs one.`;

const dispatch = async (context: Context, argv: readonly string[]): Promise<void> => {
    const [group, ...rest] = argv;
    switch (group) {
        case "ezd":
            return runEzd(context, rest);
        case "ed":
            return runEd(context, rest);
        case "verify":
            return runVerify(context, rest);
        case "trust":
            return runTrust(context, rest);
        case "approved":
            return runApproved(context, rest);
        case "cards":
            print(context, cardsInEnv(context.env));
            return undefined;
        case undefined:
        case "help":
        case "--help":
            context.out(`${USAGE}\n`);
            return undefined;
        default:
            throw new UsageError(`unknown command "${group}"\n\n${USAGE}`);
    }
};

export const main = async (argv: readonly string[], env: NodeJS.ProcessEnv, out: (text: string) => void): Promise<number> => {
    try {
        await dispatch(contextOf(env, out), argv);
        return 0;
    } catch (error) {
        out(`error: ${errorMessage(error)}\n`);
        return 2;
    }
};
