# Connect my repositories without going hunting for the right token

As someone wiring the agent to GitHub, GitLab or Redmine, I want the card to tell me where the token is made and which permissions it needs, so that I am not alt-tabbing between a settings page and a scopes list guessing at checkboxes.

Getting a token wrong is the single most common way this step fails, and the failure is silent — a token with the wrong scopes connects fine and then cannot read an issue. So the card links straight to the page where the token is created, names the scopes it needs on the same line, and can walk me through it step by step if I want that.

A connection is an instance, not a switch. The name is mine, it is suggested for me, and a second connection to a second organisation is a new name rather than an overwrite — the card warns me when a name I have typed would update an existing connection instead of adding one. Once it is connected I want the proof to be the agent using it, not a green dot.

## Acceptance criteria

- [ ] The Code & issues section lists the repository and issue-tracker cards, each with a one-line description of what the agent gains
- [ ] Opening one shows a link to where its credential is created and states the scopes or permissions that credential needs
- [ ] The form pre-fills a connection name and explains that a new name adds a connection while an existing one updates it
- [ ] Typing the name of an existing connection warns that saving will update it, before the form is submitted
- [ ] A self-hosted card takes the instance URL, and its credential link points at that instance rather than at a hosted service
- [ ] Submitting with a required field empty shows which field is missing rather than failing silently
- [ ] A field expecting a URL rejects something that is not one, with a message saying what is expected
- [ ] A connected instance appears under Connected with its state, and the catalog card shows that it has a connection
- [ ] With a connection active, asking the agent in a conversation to list issues or repositories returns real data from that account
