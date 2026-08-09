---
name: reddit
description: Read, comment, reply, vote, post, and join subreddits on Reddit as the logged-in user, through a real browser. Use whenever the user asks to do something on Reddit.
---

# Reddit (connected browser)

Feed: https://www.reddit.com  ·  subreddit: https://www.reddit.com/r/<name>  ·  inbox:
https://www.reddit.com/message/inbox  ·  submit: https://www.reddit.com/submit

- Read a subreddit or thread: navigate, then `browser_snapshot` to read posts and comments.
- Reply to the THREAD: open the post, use the reply box directly under the post itself, `browser_type`, submit.
- Reply to ONE COMMENT: open that comment's own permalink — `…/comments/<post>/<slug>/<comment>/` — which loads
  the thread focused on it, then use the Reply under THAT comment, never the box under the post. Replying to a
  person in the post's box posts a top-level comment addressed to nobody, which is both rude and the single
  clearest tell that nobody read the thread. After submitting, re-snapshot and confirm your text is nested
  under theirs.
- Vote: click the upvote/downvote control on a post or comment.
- Create a post: subreddit → Create Post (or /submit) → fill title + body → pick the community → Post.
- Join a community: open the subreddit and click Join.
- If www.reddit.com serves a network-security block, old.reddit.com usually works on the same login: plain HTML
  listings, threads, permalinks in the same shape, and working comment forms.
${tools}
