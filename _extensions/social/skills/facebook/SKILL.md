---
name: facebook
description: Read, post, comment, reply, react, and join groups on Facebook as the logged-in user, through a real browser. Use whenever the user asks to do something on Facebook.
---

# Facebook (connected browser)

Feed: https://www.facebook.com  ·  a profile: https://www.facebook.com/<username>  ·  a group:
https://www.facebook.com/groups/<name-or-id>  ·  notifications: https://www.facebook.com/notifications

${accounts}

- Read the feed, a group or a post: navigate, then `browser_snapshot`. The feed loads as you scroll, so scroll and
  `browser_wait_for` before reading further. A post's timestamp links to its permalink; open that to read one post
  with all its comments.
- New post: click "What's on your mind?" on the feed or in a group, which opens a composer dialog; `browser_type`,
  check the audience selector (Public, Friends, …) says what the owner meant, then Post.
- Comment: open the post, click "Write a comment…", type, then press Enter. Enter SUBMITS a Facebook comment, so a
  line break inside one is Shift+Enter; re-snapshot after posting to confirm it went out whole.
- Reply to ONE comment: click Reply under that comment so yours nests beneath it, never the post's own comment box.
- React: click Like; for another reaction, `browser_hover` over Like and pick from the row that appears.
- Join a group: open it and click "Join group". Some groups ask membership questions first: answer them only with
  what the owner gave you.
- Posting as a Page the owner manages: switch to the Page's profile first (the account menu, "See all profiles"),
  post, then switch back, so later actions are not taken as the Page by mistake.
- Messenger (https://www.facebook.com/messages) may ask for an end-to-end encryption PIN: that is the owner's to
  enter, never guess one.
${tools}
