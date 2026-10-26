# Outbox handbook

Outbox holds social posts until an approver decides what to do. The composer writes and submits a post. An approver reviews it. Only approval puts it in the queue. The service sends due posts to X.

Each page shows the DFX logo and the product name Outbox at the top. States appear as labelled chips: blue for submitted and pending, blue with a dot for in-flight, green for approved and sent, red for rejected and failed, amber for uncertain, and grey for retracted. Symbols pair with text to mark review findings, successful results, errors, and sign-in prompts; color is never the only cue.

Composers can open Posts to see each of their posts, its approval or publishing status, and a plain-language status message; approvers see posts from every author. The composer checks text while it is being typed, then updates the preview, character count, cost hint, and review findings. A failed live check is shown as unavailable and runs again on submit.

## Roles

The Composer has the `OUTBOX` role. A composer can submit a post. Retraction is currently available only through the API; the page has no retract button. An Approver has the `ADMIN` role. An approver can approve or reject submitted posts, retry failed posts, and resolve uncertain posts.

## Statuses

- `pending`: approved and waiting for its scheduled time.
- `in-flight`: the service has started sending the post.
- `sent`: X confirmed the post, or an approver resolved an uncertain post as sent after checking X. A permalink may be shown.
- `failed`: the service recorded a definite failure. An approver can retry it.
- `uncertain`: the service cannot tell whether X accepted the post. It is never retried automatically because that could publish a duplicate. An approver must mark it sent or failed.

Entries also have review states: `submitted`, `approved`, `rejected`, and `retracted`. Approval and queue insertion happen together. Rejection and retraction do not publish a post.
