# Founder fallback notices

The agent assigned to a chat endpoint writes every ordinary message in its
founder DM. When that agent is unavailable, nothing would reach the founder.
Founder fallback notices cover that gap. Each one is a short, fixed-format
message in the same DM, labelled as automatic and not from the agent.

The feature is off by default.

| Variable | Default | Effect |
| --- | --- | --- |
| `PAPERCLIP_FOUNDER_FALLBACK_NOTICES` | unset | `true` enables the sweep and authorizes its notices. Any other value disables both. |
| `PAPERCLIP_FOUNDER_FALLBACK_BOUND_MINUTES` | `20` | How long a condition must last before a notice. Clamped to 5–360. |

## When a notice is sent

The sweep checks each active endpoint that allows DMs and has an assigned
agent. A target is a DM conversation on that endpoint whose task is
assigned to the endpoint's agent. Every sender in that DM must link to the same
Paperclip user, and that user must be an active company owner. If no DM
qualifies, the sweep skips the endpoint.

| Notice | Condition |
| --- | --- |
| Agent | The agent has been `error`, `paused` or `terminated` for longer than the bound. |
| Item | A pending interaction on another task is addressed to the founder or to the agent, the founder can read that task, and either the agent is unavailable, or the agent has not started a run on that interaction's task since it was created, for longer than the bound. Runs on other tasks, or bound to no task, do not count as pickup. |
| Recovered | The agent is available again after an agent notice was published or may have been published (`delivery_unknown`). |

A decision notice tells the founder to answer on the original task in Paperclip.
A reply in the DM does not resolve that task's interaction.

## Deduplication and episodes

- Each notice has a deterministic idempotency key, `founder-fallback:v1:…`, so a
  sweep or restart never creates the same notice twice.
- A notice the outbox cancelled before any provider I/O never reached the
  founder. When its condition holds again, the next sweep re-arms it as a new
  row with the same key plus `:a1`, `:a2` and so on, up to 20 times. A row that
  is open, published, `delivery_unknown` or failed is never re-armed. Neither
  is one an operator cancelled after an unconfirmed delivery, because it may
  have been delivered.
- An agent episode is anchored to the failed run, the pause time or
  termination. An open episode (queued or delivered, without a recovery notice)
  suppresses a new anchor of the same kind, such as another failed retry. A
  change of kind, for example from paused to terminated, sends a new notice.
- A cancelled or failed notice never reached the founder and does not hold an
  episode open.
- Each sweep sends at most five item notices per endpoint. The rest go out on
  later sweeps.

## Triggers and idle behavior

The sweep is not a poll. It runs:

- once at startup, rebuilding its state from the existing rows;
- on wake hints for agent status changes, run status changes (including
  pickup of an escalation), interaction changes, and chat endpoint, identity
  and membership activity, plus the agent lifecycle and stranded-status work
  signals;
- at the earliest real deadline it found: the moment an agent's unavailability
  or an escalation without pickup crosses the bound;
- while a recovered agent's notice is still in flight, on the outbox's own
  settlement signal. That subscription ends once the row settles.

With no endpoint, an idle endpoint, or only completed history, no deadline
remains, so the worker issues no further queries until a hint arrives. During
drain or warm standby a hinted run is held without querying, and it runs once
admission reopens.

The wake hints are process-local. A change made by another replica or by a
direct SQL writer is picked up on the next hint, deadline or restart.

## Delivery

Notices use the native `chat_publications` outbox, so retry, `delivery_unknown`
quarantine and restart behavior are the native ones. The outbox re-proves every
notice at the transport claim, inside the transaction that locks the row. If the
condition, the recipient, the endpoint or the setting no longer holds, the row
is cancelled before any provider I/O.
