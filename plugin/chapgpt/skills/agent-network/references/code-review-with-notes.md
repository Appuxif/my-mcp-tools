# Code Review with Agent Network Notes

**Collect findings privately, finish the entire review, and send one report.**
The tools here are generic Notes, not review-specific API endpoints.

## Developer: request a review

1. Finish a coherent revision and send one `send_message` to the Reviewer.
   Include the scope (files/components), commit SHA or other version anchor,
   what changed, and expected verification. Preserve the common `task_id`
   when there is one.
2. Wait for the reviewer's **completion message containing `note_id`**.
   Do not start fixing partial findings; intermediate findings are kept
   in a private draft.

## Reviewer: collect findings before sending anything

1. Receive the review request and inspect the exact revision/scope.
   Call `create_note(agent_id, token, title, description)` using a
   title such as `Code Review: auth changes` and a parent description
   identifying the revision, scope, and verification plan.
   Save `note_id`.
2. Thoroughly examine the requested code, run relevant checks when feasible,
   and add one independently actionable subnote per verified finding:
   `add_to_note(agent_id, token, note_id, title, description)`.
   A title might be `P1: retry can duplicate events`. Include the file
   path/line, evidence or reproduction, impact, and recommended fix
   in the subnote description.
3. Cross-check the entire scope and deduplicate. Use `update_subnote` to
   correct uncertain or incomplete findings and `remove_from_note` for
   disproved/duplicate findings. Read the draft with `read_note` before
   publication. **Do not send a message for each finding.**
4. When finished, `finalize_note(agent_id, token, note_id)`. Even for an
   approved review with zero findings, use a Note: the parent describes
   what was checked and the outcome. If the verdict was not known at
   draft creation, put it in the final handoff message; never guess.
5. Only **after** finalization, send the Developer **one**
   `send_message` whose actual text includes the literal `note_id`:
   `Code Review complete for abc123. Changes requested, 3 findings.
   Read note_id=<actual-uuid>.`
   Carry forward the `task_id`. If retrying this same send, reuse its
   `client_message_id` to avoid duplicates.

No Note operation sends inbox messages or wake notifications: **the
explicit text message is the only way Developer learns the Note ID.**
Do not assume that finalization delivered or announced the review.

## Developer: read the whole report before fixing

1. After `get_messages` returns the one completion message, extract the
   exact `note_id` from its text and call `read_note` with **your own**
   `agent_id` and `token`. It returns all findings in one ordered result.
2. Process the whole report, prioritize fixes, and ACK the completion
   message separately with `ack_message`.
3. Make and test the fixes as one coherent batch. If a second review is
   needed, request it for the new revision. Reviewer creates a **new
   Note** for that round; finalized Notes cannot be modified. Reuse
   the existing `task_id` to correlate review rounds.

## Exceptions and constraints

- Clarification questions may use ordinary messages, but they should
  not carry provisional findings. If a blocker prevents a complete review,
  state the blocker and explicitly coordinate next steps rather than
  generating a stream of partial reports.
- Notes expire **48 hours after creation**; finalization does not extend
  their lifetime. Deliver and read `note_id` promptly.
- Drafts are private; finalized Notes may be read only by agents sharing
  a team with the author, even if another agent somehow knows the ID.
- Never include credentials in Notes or inter-agent messages.
