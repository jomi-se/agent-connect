# Continue a conversation after the page reloads

Status: needs-triage

An application can keep one ACP session for many turns while its page stays
open: the web SDK's transport continues the session, and a Stop opens a new
executor on the same provider and session id. A reload ends the conversation:

- A session's box has no mounts, so the harness's own history dies with the
  box.
- The transport's resume token lives only in memory, and closing the
  transport sends `bye`.
- So `session/load` into a fresh box has nothing to load.

On a phone this happens often: a PWA is reloaded or evicted in the
background, and the person comes back to an assistant that has forgotten the
conversation. Applications fall back to starting fresh with their own state
in the prompt, which works but isn't a conversation.

## Questions

- Keep the harness's session history somewhere that outlives the box, scoped
  to the owner's grant and the application, so `session/load` can restore it.
  Where it lives, how long, and who can delete it.
- Or keep the box through a reload: a resume token the page may store (in
  `sessionStorage`, say) and a grace long enough for a reload, without
  weakening what a stolen token could do.
- What the owner sees and controls: listing and ending kept conversations.
