# Two audiences, one project

As a developer sharing a workspace with someone who does not write code, I want each of us to see the same project in our own words, so that neither of us has to learn the other's.

I keep my file tree, my Changes panel with its stages and commits, and my agent cards that say Land now. My collaborator, on the same sandbox, has answered the question the other way: their rail opens on Project, their cards say Accept, their tree hides the tooling. The rules that decide whether finished work lands are the sandbox's, set by me. Their answer changed their screen and nothing else.

## Acceptance criteria

- [ ] The audience answer is stored per browser, so two people on one sandbox can hold different answers at once
- [ ] A collaborator's answer never writes a sandbox rule, and the arrival card offers the rules checkbox only to a maintainer or owner
- [ ] Switching the answer in Settings changes tiles, words, the tree filter and the markdown diff default, and leaves every file, agent and rule as it was
- [ ] Switching the Project extension off returns the maker's rail to the Workspace tile in the same seat
