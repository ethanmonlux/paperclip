# Agent-addressed stage handoffs

An agent-directed `request_confirmation` wakes its named recipient on the source
task without changing that task's assignee. Admission revalidates the saved
pending interaction, recipient, company, issue, source run and resolver audience
at retry, queue and final dispatch boundaries. A wake payload alone is not
authority. Resolved, cancelled, human-only, governed-action and stale-recipient
requests do not grant this participant path. Checkout, target-version,
containment, pause, dependency, budget and tool authorization gates still apply.

For implementation/review stages, keep the broad parent dependent on source
completion. The source owner freezes an exact-head handoff document and asks
its existing coordinator to route independent review from a version-bound card
on the source task. The coordinator responds there without checking out or
reassigning the source, creates or reuses one reviewer child under that source,
and accepts the routing card only after verifying the assignment. Routing
acceptance is not source approval: do not bind that card as a completion-review
request. The source owner waits on the actual reviewer task; source completion
requires the real independent verdict and all applicable acceptance gates.
Preserve the same source, branch, PR and reviewer through remediation.

