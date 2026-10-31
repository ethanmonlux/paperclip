# Founder phone notifications

Founder notifications send a short phone message when work genuinely needs
the founder, and stay quiet otherwise. They reuse the native chat outbox
(`chat_publications`) and chat action table (`chat_actions`); there is no
separate notification database, transport, scheduler or schema migration.

The feature is **inert by default**. Nothing is sent until a board connection
manager creates and enables a verified route.

## What notifies

The producer reads the recipient's own complete attention desk (the same feed
as the board Inbox, with their read boundary and dismissals) once per
scheduler tick. Only task-bound facts are eligible:

| Attention source | Class | When |
| --- | --- | --- |
| Pending interaction addressed to the board or recipient | decision | first observation |
| Approval, decision, review verdict | decision | first observation |
| Human-owned recovery action | decision | first observation |
| Blocked task with a human-owned unblock request | decision | first observation |
| Stalled blocker chain, latest failed run with no retry | stall | after the persistence bound |

The feed already excludes cards addressed to invokable agents (agent routing
and review handoffs), other users' cards, agent-owned recoveries and failed
runs that were retried. Budget, agent-error and join-request alerts have no
original task to pause and resume, so they never notify. A fact the recipient
snoozed or dismissed in Paperclip stays quiet without being treated as
resolved.

A stall must persist for `stallAfterMs` (default 15 minutes, bounded to
5 minutes–24 hours) and must be seen on at least two ticks. A stall that
recovers first is closed silently.

Classification uses only closed server fields: source kind, dedup key,
subject and related issue ids, and snooze/dismissal state. It never reads
`whyNow`, model output or provider transcripts.

## Episodes

Each eligible fact becomes one episode keyed by route, attention dedup key and
occurrence. Repeated ticks, overlapping passes and server restarts converge on
the same episode and the same outbox idempotency key, so a delivered episode
is never sent twice. If the same fact clears and later reappears, for example
a review reopened on an unchanged head, a new occurrence opens a new episode.

Review (`review:<issue>`) and stalled-blocker (`blocker:<issue>`) facts keep
the same dedup key when they clear and reopen. A route has at most one active
episode per dedup key, and the founder adapter attaches occurrence identity so
a reopening is a new episode even when no tick saw the fact absent, including
while the server was down:

- review: an opaque fingerprint of the current stage, last decision and
  changes-requested round, the issue's latest recorded change into
  `in_review`, and the head under review where the issue's primary work
  product records one (`metadata.sha`). A different fingerprint is a new
  occurrence. Native execution state has no head field, so for an issue
  without such a work product a new head under an unchanged gate is not
  told apart.
- blocker: a continuity anchor, the earliest blocking transition among the
  issues the blocker currently holds. The set of held issues changes during
  one stall, so this is not an equality fingerprint. The episode continues
  while the anchor is no later than its last observation, that is while some
  hold has lasted since then; releasing or adding individual dependents does
  not change it. Only when every current hold began after the last
  observation is it a new occurrence. If one hold is released and another
  formed between two ticks with no gap seen, that also counts as a new
  occurrence.

Every tick records the observation on the active episode, so continuity
survives restarts. The shared attention producer and its dedup keys are
unchanged.

When a fact is still present but as a new occurrence, the old episode
resolves as `superseded`: its unsent card is cancelled, its buttons expire,
and a card already sent or UNKNOWN keeps its identity and is never replayed.
It gets no "no longer needs you" notice, because the founder is still needed;
the new episode's card follows.

When the fact leaves the snapshot:

- A card that was never handed to the provider is cancelled.
- A card that may be visible (`streaming`, `published` or `delivery_unknown`)
  gets exactly one resolution notice.
- Outstanding Acknowledge buttons expire.

A failed attention snapshot resolves nothing.

## Delivery and failure visibility

Cards use the normal outbox lifecycle: bounded retry with backoff,
`failed` after five attempts, and `delivery_unknown` for ambiguous sends.
`delivery_unknown` is never resent automatically. Resolve it with the
existing operator action `POST /chat-endpoints/:endpointId/publications/:publicationId/resolve`
(`mark_delivered`, `retry_anyway` or `cancel`).

Every episode's delivery state, attempts and redacted error are returned by
the board read API. Each new failure state is logged once. A route that
cannot deliver a due episode records `lastUnavailableReason`, logs the change,
and keeps the episode due until it can be sent.

## Routes

A route binds one recipient (a Paperclip user) to one existing direct-message
thread on one chat endpoint. The server proves the binding when it creates a
card, and again inside the outbox's durable pre-I/O transport claim for every
founder publication: first send, each retry, and resolution and
acknowledgement notices. It checks that:

- the route is still enabled for the same recipient;
- the endpoint is active, in `automatic` publication mode and allows DMs;
- the conversation is a DM and every human who wrote into that thread is
  linked to the recipient (the identity links and membership are locked for
  the claim, under the same identity lock as chat authorization);
- the recipient is still an active company member;
- the publication targets the route's current thread generation and belongs
  to that route's episode and original task.

If any check fails at the claim, the row is cancelled before any provider
call, so it was definitely not sent. A send already handed to the provider
(`streaming` or `delivery_unknown`) is never replayed. When a card cannot be
created, the failure is reported as the route's binding reason.
The route follows the thread's newest sendable generation, so `/new` does
not strand notifications.

Cards name the original task and decision and link to it in Paperclip. They
say that messages typed in the chat are not delivered to that task: replies
in a DM still go to the DM's own task.

## Acknowledge, answer, resume

On providers with native buttons, the card carries an **Acknowledge** button.
Only the recipient, through a currently linked identity, on the card's own
thread and message, can use it. Acknowledging records that the founder saw
the card. It never answers the decision or changes the task. The founder can
also acknowledge from Paperclip.

The founder answers the decision in Paperclip. The existing interaction
resolution then continues the **same** original task (for example
`wake_assignee`). The episode then resolves and sends its resolution notice.

The continuation is the native one, with no founder-specific admission. The
continuation suite drives the real routes, wake requests, dependency
admission and run queue with only the agent adapter faked:

- an answer becomes exactly one run on the original task for its assignee;
  acknowledgement, a repeated answer and further sweeps add nothing;
- an answer behind a busy assignee stays queued and runs exactly once after
  a restart;
- an answer on a task held by an unrelated blocker starts no run while the
  hold lasts; once it clears, the native blockers-resolved wake runs the same
  task once.

A live phone and installed-runtime canary is part of activation, below.

Notification state is never an input to dispatch, assignment, recovery,
review, merge, deployment or release.

## API

| Method | Path | Who |
| --- | --- | --- |
| `GET` | `/api/companies/:companyId/founder-notifications` | board members |
| `PUT` | `/api/companies/:companyId/founder-notifications/routes` | `tools:manage_connections` |
| `PATCH` | `/api/companies/:companyId/founder-notifications/routes/:routeId` | `tools:manage_connections` |
| `POST` | `/api/companies/:companyId/founder-notifications/episodes/:episodeId/acknowledge` | the recipient |

`PUT` body: `{ recipientUserId, endpointId, conversationId, enabled?, stallAfterMs? }`.
A route can only be enabled when its binding verifies. Disabling a route
cancels every card not yet handed to the provider, expires its buttons and
closes active episodes silently. Episode and card writes take a share lock on
the route row, so a sweep that was already running when the route was
disabled writes nothing afterwards. Re-enabling sends each still-present fact
once, as a new occurrence.

These endpoints are in the OpenAPI document under `founder-notifications`.

## Activation

Activation is a deliberate operator effect, not part of shipping this code.
It needs:

- one founder-controlled chat endpoint;
- an existing DM from the founder with their identity linked;
- an enabled route;
- one founder-directed live canary that proves phone-visible delivery,
  acknowledgement and resolution on the same task.
