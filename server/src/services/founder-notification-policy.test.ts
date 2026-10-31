import { describe, expect, it } from "vitest";
import type { AttentionItem, AttentionSourceKind } from "@paperclipai/shared";
import {
  boundedStallAfterMs,
  classifyFounderNotification,
  founderNotificationDue,
  FOUNDER_NOTIFICATION_STALL_AFTER_MS_DEFAULT,
  FOUNDER_NOTIFICATION_STALL_AFTER_MS_MAX,
  FOUNDER_NOTIFICATION_STALL_AFTER_MS_MIN,
} from "./founder-notification-policy.js";

const NOW = Date.parse("2026-10-31T12:00:00Z");
const task = { kind: "issue" as const, id: "task-1", companyId: "c", title: "Task", identifier: "STA-1", status: "blocked", href: null };

function item(sourceKind: AttentionSourceKind, overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    sourceKind,
    dedupKey: `${sourceKind}:1`,
    subject: { kind: "interaction", id: "s", companyId: "c", title: "t", identifier: null, status: null, href: null },
    relatedIssue: task,
    archivedAt: null,
    snoozedUntil: null,
    dismissal: null,
    ...overrides,
  } as AttentionItem;
}

describe("founder notification classification", () => {
  it.each([
    ["issue_thread_interaction", "decision"],
    ["approval", "decision"],
    ["decision", "decision"],
    ["review", "decision"],
    ["recovery_action", "decision"],
    ["failed_run", "stall"],
  ] as const)("classifies %s as %s on the original task", (sourceKind, kind) => {
    expect(classifyFounderNotification(item(sourceKind), NOW)).toEqual({ notify: true, kind, taskIssueId: "task-1" });
  });

  it("separates an explicit human unblock request from a stalled chain", () => {
    const subject = { ...task, kind: "issue" as const };
    expect(
      classifyFounderNotification(item("blocker_attention", { dedupKey: "blocked-owner:task-1:t", relatedIssue: null, subject }), NOW),
    ).toMatchObject({ notify: true, kind: "decision", taskIssueId: "task-1" });
    expect(
      classifyFounderNotification(item("blocker_attention", { dedupKey: "blocker:task-1", relatedIssue: null, subject }), NOW),
    ).toMatchObject({ notify: true, kind: "stall", taskIssueId: "task-1" });
  });

  it.each(["budget_alert", "agent_error_alert", "join_request", "productivity_review"] as const)(
    "keeps %s quiet",
    (sourceKind) => {
      expect(classifyFounderNotification(item(sourceKind), NOW)).toEqual({ notify: false, reason: "out_of_scope_source" });
    },
  );

  it("requires an original task identity", () => {
    expect(classifyFounderNotification(item("approval", { relatedIssue: null }), NOW)).toEqual({
      notify: false,
      reason: "no_task_identity",
    });
  });

  it("respects the recipient's own snooze, dismissal and archive", () => {
    expect(classifyFounderNotification(item("approval", { snoozedUntil: new Date(NOW + 1).toISOString() }), NOW)).toEqual({
      notify: false,
      reason: "recipient_snoozed",
    });
    expect(classifyFounderNotification(item("approval", { snoozedUntil: new Date(NOW - 1).toISOString() }), NOW)).toMatchObject({
      notify: true,
    });
    expect(
      classifyFounderNotification(
        item("approval", { dismissal: { kind: "dismissed" as never, dismissedAt: "", snoozedUntil: null, isActive: true } }),
        NOW,
      ),
    ).toEqual({ notify: false, reason: "recipient_dismissed" });
    expect(classifyFounderNotification(item("approval", { archivedAt: new Date(NOW).toISOString() }), NOW)).toEqual({
      notify: false,
      reason: "archived",
    });
  });

  it("never reads prose fields", () => {
    const quiet = item("budget_alert", { whyNow: "URGENT founder decision needed now" } as Partial<AttentionItem>);
    expect(classifyFounderNotification(quiet, NOW)).toMatchObject({ notify: false });
  });
});

describe("founder notification persistence bound", () => {
  it("bounds the stall threshold instead of allowing it to be disabled", () => {
    expect(boundedStallAfterMs(undefined)).toBe(FOUNDER_NOTIFICATION_STALL_AFTER_MS_DEFAULT);
    expect(boundedStallAfterMs(Number.NaN)).toBe(FOUNDER_NOTIFICATION_STALL_AFTER_MS_DEFAULT);
    expect(boundedStallAfterMs(0)).toBe(FOUNDER_NOTIFICATION_STALL_AFTER_MS_MIN);
    expect(boundedStallAfterMs(-1)).toBe(FOUNDER_NOTIFICATION_STALL_AFTER_MS_MIN);
    expect(boundedStallAfterMs(Number.MAX_SAFE_INTEGER)).toBe(FOUNDER_NOTIFICATION_STALL_AFTER_MS_MAX);
    expect(boundedStallAfterMs(30 * 60_000)).toBe(30 * 60_000);
  });

  it("notifies decisions immediately and stalls only after both elapsed time and a second observation", () => {
    const base = { firstObservedAt: NOW, stallAfterMs: FOUNDER_NOTIFICATION_STALL_AFTER_MS_MIN };
    expect(founderNotificationDue({ ...base, kind: "decision", observations: 1, now: NOW })).toBe(true);
    expect(founderNotificationDue({ ...base, kind: "stall", observations: 1, now: NOW + 86_400_000 })).toBe(false);
    expect(
      founderNotificationDue({ ...base, kind: "stall", observations: 5, now: NOW + FOUNDER_NOTIFICATION_STALL_AFTER_MS_MIN - 1 }),
    ).toBe(false);
    expect(
      founderNotificationDue({ ...base, kind: "stall", observations: 2, now: NOW + FOUNDER_NOTIFICATION_STALL_AFTER_MS_MIN }),
    ).toBe(true);
    // A zero threshold cannot make a stall immediate.
    expect(founderNotificationDue({ ...base, stallAfterMs: 0, kind: "stall", observations: 2, now: NOW + 1 })).toBe(false);
  });
});
