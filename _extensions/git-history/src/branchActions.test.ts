import type { IntenticApi } from "@intentic/extension-api";
import { extensionIdOf } from "@intentic/extension-manifest";
import { registerExtensionMessages } from "@intentic/extension-ui/i18n";
import { unstubbed } from "@intentic/testing";
import { branchMenuItems, shortBranchName, workspaceViewPath } from "./branchActions.js";
import { bindHost } from "./host.js";
import { messages } from "./i18n.js";
import { manifest } from "./manifest.js";

// The menu's labels are asserted on, so the catalog has to be registered the way the host does before `activate`.
await registerExtensionMessages(extensionIdOf(manifest), messages);

// A view or a start takes a branch's short name: the remote's half of a ref is folded away here, or the daemon is asked
// for a branch called `origin/feature/x` that no repository has.

describe(`shortBranchName`, () => {
    it(`drops the remote from a remote-tracking ref`, () => {
        expect(shortBranchName(`origin/feature/x`, [`origin`])).toBe(`feature/x`);
    });

    it(`leaves a local branch's name alone, a slashed one and one that only starts like a remote included`, () => {
        expect(shortBranchName(`feature/x`, [`origin`])).toBe(`feature/x`);
        expect(shortBranchName(`originals/x`, [`origin`])).toBe(`originals/x`);
    });

    it(`strips the whole of a remote whose own name has a slash`, () => {
        expect(shortBranchName(`team/fork/fix`, [`team`, `team/fork`])).toBe(`fix`);
    });
});

describe(`workspaceViewPath`, () => {
    it(`encodes both halves, since a repository and a branch both carry slashes`, () => {
        expect(workspaceViewPath(`apps/web`, `feature/x`)).toBe(`/workspace?repo=apps%2Fweb&branch=feature%2Fx`);
        expect(workspaceViewPath(`root`, `fix#1`)).toBe(`/workspace?repo=root&branch=fix%231`);
    });
});

describe(`branchMenuItems`, () => {
    it(`views the branch in the Workspace and starts an agent from it, naming it in both`, () => {
        const navigate = jest.fn();
        const composeFrom = jest.fn();
        bindHost(
            unstubbed<IntenticApi>(`host`, {
                navigate,
                chat: unstubbed<IntenticApi["chat"]>(`chat`, { composeFrom }),
            }),
        );
        const [view, start] = branchMenuItems(`root`, `feature/x`);

        expect(view?.label).toBe(`View feature/x in Workspace`);
        expect(start?.label).toBe(`Start an agent from feature/x`);
        view?.command?.({ originalEvent: new Event(`click`), item: view });
        expect(navigate).toHaveBeenCalledWith(`/workspace?repo=root&branch=feature%2Fx`);
        start?.command?.({ originalEvent: new Event(`click`), item: start });
        expect(composeFrom).toHaveBeenCalledWith({ repo: `root`, branch: `feature/x` });
    });
});
