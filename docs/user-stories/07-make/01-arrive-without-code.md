# Arrive without code

As someone who does not write code, I want the app to ask me once how I work and then talk to me in plain words, so that I am never asked to understand a branch, a commit or a diff to get something made.

I open a fresh workspace. Where the file tree would be, one card asks how I will work here: I write code, or I don't. I pick the second. The rail's third tile is now Project instead of Workspace, the words on every button are plain ones (Accept, Throw away, Go back, Versions), and the file tree, when I open it, leaves lockfiles, configuration and dot files out with a line saying how many it left out. Nothing about my files changed. Settings ▸ Appearance shows the same choice, one click from the other answer.

## Acceptance criteria

- [ ] The empty workspace pane shows the card with the two answers, and the card is gone after either is pressed and stays gone after a reload
- [ ] After "I don't write code", the rail seats a Project tile where Workspace was, and Workspace is reachable from the More menu as Files
- [ ] After "I don't write code", an agent card offers Accept and Throw away where it offered Land now and Discard
- [ ] After "I don't write code", the file tree hides technical files and says how many it hid, and pressing that line shows them
- [ ] Settings ▸ Appearance carries the same choice under "How you work", and switching it back restores the developer's words and tiles
- [ ] For a maintainer, the card's checkbox writes the two rules (land finished work, save a version of accepted work) into Sandbox ▸ Agent ▸ Finished work, and for a collaborator no checkbox is offered
