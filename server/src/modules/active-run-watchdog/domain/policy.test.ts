import { describe, expect, it } from "vitest";
import {
  classifySilenceLevel,
  decideStaleRunEvaluation,
  evaluateSuppression,
  isTerminalIssueStatus,
  shouldFoldTerminalSource,
  silenceAgeMs,
  silenceStartedAt,
  type StaleRunEvaluationEvidence,
} from "./policy.js";

describe("domain", () => {
  const SUSPICION_THRESHOLD_MS = 60 * 60 * 1000;
  const CRITICAL_THRESHOLD_MS = 4 * 60 * 60 * 1000;

  describe("silenceStartedAt / silenceAgeMs", () => {
    it.each([
      {
        name: "prefers the last output time over every other timestamp",
        run: {
          lastOutputAt: new Date("2026-01-01T00:10:00.000Z"),
          processStartedAt: new Date("2026-01-01T00:05:00.000Z"),
          startedAt: new Date("2026-01-01T00:04:00.000Z"),
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        },
        expected: "2026-01-01T00:10:00.000Z",
      },
      {
        name: "falls back to the process start time when there is no output",
        run: {
          lastOutputAt: null,
          processStartedAt: new Date("2026-01-01T00:05:00.000Z"),
          startedAt: new Date("2026-01-01T00:04:00.000Z"),
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        },
        expected: "2026-01-01T00:05:00.000Z",
      },
      {
        name: "falls back to the run start time when there is no process start",
        run: {
          lastOutputAt: null,
          processStartedAt: null,
          startedAt: new Date("2026-01-01T00:04:00.000Z"),
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        },
        expected: "2026-01-01T00:04:00.000Z",
      },
      {
        name: "falls back to the run creation time last",
        run: {
          lastOutputAt: null,
          processStartedAt: null,
          startedAt: null,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        },
        expected: "2026-01-01T00:00:00.000Z",
      },
    ])("selects the latest usable timestamp: $name", ({ run, expected }) => {
      expect(silenceStartedAt(run)?.toISOString()).toBe(expected);
    });

    it("returns null when every timestamp is null", () => {
      expect(silenceStartedAt({ lastOutputAt: null, processStartedAt: null, startedAt: null, createdAt: null })).toBeNull();
    });

    it("calculates the silence age from the selected timestamp", () => {
      const run = {
        lastOutputAt: new Date("2026-01-01T00:00:00.000Z"),
        processStartedAt: null,
        startedAt: null,
        createdAt: null,
      };
      const now = new Date("2026-01-01T01:00:00.000Z");

      expect(silenceAgeMs(run, now)).toBe(60 * 60 * 1000);
    });

    it("floors the silence age at zero when the clock reads before the start", () => {
      const run = {
        lastOutputAt: new Date("2026-01-01T01:00:00.000Z"),
        processStartedAt: null,
        startedAt: null,
        createdAt: null,
      };
      const now = new Date("2026-01-01T00:00:00.000Z");

      expect(silenceAgeMs(run, now)).toBe(0);
    });

    it("returns null silence age when there is no usable timestamp", () => {
      const run = { lastOutputAt: null, processStartedAt: null, startedAt: null, createdAt: null };

      expect(silenceAgeMs(run, new Date("2026-01-01T00:00:00.000Z"))).toBeNull();
    });
  });

  describe("classifySilenceLevel", () => {
    function classifyInput(overrides: {
      isRunningRun?: boolean;
      silenceAgeMs?: number | null;
      dismissedFalsePositive?: boolean;
      snoozed?: boolean;
    } = {}) {
      return {
        isRunningRun: true,
        silenceAgeMs: null,
        dismissedFalsePositive: false,
        snoozed: false,
        suspicionThresholdMs: SUSPICION_THRESHOLD_MS,
        criticalThresholdMs: CRITICAL_THRESHOLD_MS,
        ...overrides,
      };
    }

    it.each([
      {
        name: "not-applicable when the run is not running",
        input: classifyInput({ isRunningRun: false, silenceAgeMs: CRITICAL_THRESHOLD_MS + 1 }),
        expected: "not_applicable",
      },
      {
        name: "not-applicable when the run has a permanent false-positive dismissal",
        input: classifyInput({ dismissedFalsePositive: true, silenceAgeMs: CRITICAL_THRESHOLD_MS + 1 }),
        expected: "not_applicable",
      },
      {
        name: "snoozed when a snooze or continue decision is active",
        input: classifyInput({ snoozed: true, silenceAgeMs: CRITICAL_THRESHOLD_MS + 1 }),
        expected: "snoozed",
      },
      {
        name: "healthy below the suspicion threshold",
        input: classifyInput({ silenceAgeMs: SUSPICION_THRESHOLD_MS - 1 }),
        expected: "ok",
      },
      {
        name: "suspicious at or above the suspicion threshold",
        input: classifyInput({ silenceAgeMs: SUSPICION_THRESHOLD_MS }),
        expected: "suspicious",
      },
      {
        name: "critical at or above the critical threshold",
        input: classifyInput({ silenceAgeMs: CRITICAL_THRESHOLD_MS }),
        expected: "critical",
      },
      {
        name: "healthy when there is no silence age yet",
        input: classifyInput(),
        expected: "ok",
      },
    ])("classifies: $name", ({ input, expected }) => {
      expect(classifySilenceLevel(input)).toBe(expected);
    });
  });

  describe("evaluateSuppression", () => {
    it("suppresses a snoozed run until the snooze expires", () => {
      expect(evaluateSuppression({ snoozedOrContinued: true })).toEqual({
        suppressed: true,
        reason: "snoozed",
      });
    });

    it("re-arms the watchdog once the continue decision's snooze window has passed", () => {
      expect(evaluateSuppression({ snoozedOrContinued: false })).toEqual({ suppressed: false });
    });

    it("suppresses a run permanently after a false-positive decision", () => {
      expect(evaluateSuppression({ dismissedFalsePositive: true })).toEqual({
        suppressed: true,
        reason: "dismissed_false_positive",
      });
    });

    it("suppresses a blocked source", () => {
      expect(evaluateSuppression({ blockedSource: true })).toEqual({
        suppressed: true,
        reason: "blocked_source",
      });
    });

    it("suppresses a recovery-origin source", () => {
      expect(evaluateSuppression({ recoveryOriginSource: true })).toEqual({
        suppressed: true,
        reason: "recovery_origin_source",
      });
    });

    it("is not suppressed when no signal is set", () => {
      expect(evaluateSuppression({})).toEqual({ suppressed: false });
    });

    it("checks snoozed before recovery-origin, blocked-source, and dismissed-false-positive", () => {
      expect(
        evaluateSuppression({
          snoozedOrContinued: true,
          recoveryOriginSource: true,
          blockedSource: true,
          dismissedFalsePositive: true,
        }),
      ).toEqual({ suppressed: true, reason: "snoozed" });
    });
  });

  describe("isTerminalIssueStatus", () => {
    it.each([
      { status: "done", expected: true },
      { status: "cancelled", expected: true },
      { status: "in_progress", expected: false },
      { status: "blocked", expected: false },
      { status: null, expected: false },
      { status: undefined, expected: false },
    ])("$status -> $expected", ({ status, expected }) => {
      expect(isTerminalIssueStatus(status)).toBe(expected);
    });
  });

  describe("shouldFoldTerminalSource", () => {
    it("folds a terminal source only with same-run terminal evidence", () => {
      expect(
        shouldFoldTerminalSource({ sourceIssueStatus: "done", hasSameRunTerminalEvidence: true }),
      ).toBe(true);
    });

    it("does not fold a terminal source without same-run terminal evidence", () => {
      expect(
        shouldFoldTerminalSource({ sourceIssueStatus: "done", hasSameRunTerminalEvidence: false }),
      ).toBe(false);
    });

    it("does not fold a non-terminal source even with evidence present", () => {
      expect(
        shouldFoldTerminalSource({ sourceIssueStatus: "in_progress", hasSameRunTerminalEvidence: true }),
      ).toBe(false);
    });
  });

  describe("decideStaleRunEvaluation", () => {
    /**
     * A critically silent run, unsuppressed, with no evaluation yet and a live
     * source task. Each test changes exactly one field, so every assertion
     * isolates one clause of the decision.
     */
    function evaluable(
      overrides: Partial<StaleRunEvaluationEvidence> = {},
    ): StaleRunEvaluationEvidence {
      return {
        level: "critical",
        suppression: { suppressed: false },
        hasOpenEvaluation: false,
        sourceIssueId: "issue-1",
        sourceIssueStatus: "in_progress",
        ...overrides,
      };
    }

    it("opens an evaluation for a critically silent run that has none", () => {
      expect(decideStaleRunEvaluation(evaluable())).toEqual({ open: true });
    });

    it("leaves a run that is no longer running alone", () => {
      expect(decideStaleRunEvaluation(evaluable({ level: "not_applicable" }))).toEqual({
        open: false,
        reason: "not_running",
      });
    });

    it.each(["ok", "suspicious", "snoozed"] as const)(
      "waits for the critical level rather than escalating at %s",
      (level) => {
        // The scan finds candidates at the lower suspicion threshold. Opening
        // board-visible work needs the critical bound, not mere suspicion.
        expect(decideStaleRunEvaluation(evaluable({ level }))).toEqual({
          open: false,
          reason: "within_critical_threshold",
        });
      },
    );

    it("honours the scan's suppression rules at the critical level", () => {
      expect(
        decideStaleRunEvaluation(
          evaluable({ suppression: { suppressed: true, reason: "recovery_origin_source" } }),
        ),
      ).toEqual({ open: false, reason: "suppressed" });
    });

    it("never opens a second evaluation while one is already open", () => {
      // This is the no-duplicate-effect guarantee: an open evaluation owns the
      // silence, so the decision declines rather than creating a rival.
      expect(decideStaleRunEvaluation(evaluable({ hasOpenEvaluation: true }))).toEqual({
        open: false,
        reason: "evaluation_already_open",
      });
    });

    it("declines a run with no source task to evaluate", () => {
      expect(decideStaleRunEvaluation(evaluable({ sourceIssueId: null }))).toEqual({
        open: false,
        reason: "no_source_issue",
      });
    });

    it.each(["done", "cancelled"] as const)("leaves a %s source task to the fold path", (status) => {
      expect(decideStaleRunEvaluation(evaluable({ sourceIssueStatus: status }))).toEqual({
        open: false,
        reason: "terminal_source_issue",
      });
    });

    it("prefers the more specific reason when several clauses apply", () => {
      // Liveness outranks the bound, which outranks suppression, which
      // outranks an existing evaluation.
      expect(
        decideStaleRunEvaluation(
          evaluable({
            level: "not_applicable",
            suppression: { suppressed: true, reason: "snoozed" },
            hasOpenEvaluation: true,
            sourceIssueId: null,
          }),
        ),
      ).toEqual({ open: false, reason: "not_running" });
      expect(
        decideStaleRunEvaluation(
          evaluable({
            suppression: { suppressed: true, reason: "snoozed" },
            hasOpenEvaluation: true,
          }),
        ),
      ).toEqual({ open: false, reason: "suppressed" });
    });
  });
});
