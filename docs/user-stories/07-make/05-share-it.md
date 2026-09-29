# Share it

As someone who does not write code, I want "shared" and "published" to mean the same thing everywhere I see them, so that I never mistake copying my work to GitHub for putting it on the internet.

The Public tab on the Sandbox page (`/sandbox/public`, listed under "Added by extensions", from the built-in Preview extension) shows the address anyone with the link opens, with a button to copy it, or says the sandbox has no public address. It lists what is published from the `public/` folder, a refused file with the reason it is not served, and the conversations I shared as pages from the chat's Share dialog, which I can update or take down there. With nothing published it names the folder: create a `public/` folder and put a file in it. In the file tree that folder wears a chip that says "shared" rather than "public". The git act of copying my work to GitHub is called Back up, never Publish.

## Acceptance criteria

- [ ] The Public tab shows the sandbox's public address with a way to copy it, or says there is none
- [ ] With nothing published, the Public tab names the `public/` folder as the place to put what should be shared
- [ ] A file in `public/` the sandbox refuses to serve is listed as blocked, with why, rather than looking published
- [ ] A conversation shared from the chat is listed on the Public tab, where it can be updated or taken down
- [ ] The workspace tree marks that folder "shared" for the maker audience and "public" for the developer's, with the same warning tone either way
- [ ] Where the developer's Changes panel says Publish or Push, the maker's words say Back up
