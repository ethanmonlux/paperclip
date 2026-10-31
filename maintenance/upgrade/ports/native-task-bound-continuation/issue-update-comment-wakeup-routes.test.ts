import express from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn(async () => undefined),
  publishActivity: vi.fn(),
}));

vi.mock("../services/fast-responses.js", () => ({
  enqueueFastResponse: vi.fn(async () => undefined),
}));

const ASSIGNEE_AGENT_ID = "11111111-1111-4111-8111-111111111111";
const PREVIOUS_AGENT_ID = "22222222-2222-4222-8222-222222222222";
const MENTIONED_AGENT_ID = "33333333-3333-4333-8333-333333333333";
const SOURCE_RUN_ID = "44444444-4444-4444-8444-444444444444";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
  getByIdForUpdate: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
  getRelationSummaries: vi.fn(),
  getDependencyReadiness: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  getCurrentScheduledRetry: vi.fn(),
  listReviewAttention: vi.fn(),
}));

const mockPauseGate = vi.hoisted(() => vi.fn(async (): Promise<Record<string, unknown> | null> => null));
const mockExecutionBlocker = vi.hoisted(() => vi.fn(async (): Promise<Record<string, unknown> | null> => null));
vi.mock("../services/execution-blocker.js", () => ({ getExecutionBlocker: mockExecutionBlocker }));
const mockAccessDecide = vi.hoisted(() => vi.fn(async (input: { action?: string; resource?: { issueId?: string } }) => ({
  allowed: true,
  action: input.action,
  reason: "allow_explicit_grant",
  explanation: "Allowed by test grant.",
})));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));
const mockIssueThreadInteractionService = vi.hoisted(() => ({
  expirePendingInteractionsForTerminalIssue: vi.fn(async () => []),
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
}));
const mockRunnerGoalService = vi.hoisted(() => ({
  projection: vi.fn(async () => null),
  act: vi.fn(),
}));

vi.mock("../services/native-runtime/native-question-bridge.js", () => ({
  deliverNativeQuestionResponse: vi.fn(async () => "not_native"),
  nativeQuestionRunToCancel: vi.fn(async () => null),
  validateNativeQuestionResponseInput: vi.fn(),
}));

vi.mock("../services/runner-goals.js", () => ({
  runnerGoalService: () => mockRunnerGoalService,
  RunnerGoalActionError: class RunnerGoalActionError extends Error {},
  RunnerGoalConflictError: class RunnerGoalConflictError extends Error {},
}));

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1" })),
  }),
  accessService: () => ({
    canUser: vi.fn(async () => true),
    decide: mockAccessDecide,
    hasPermission: vi.fn(async () => true),
  }),
  agentService: () => ({
    getById: vi.fn(async () => null),
    resolveByReference: vi.fn(async (_companyId: string, raw: string) => ({
      ambiguous: false,
      agent: { id: raw },
    })),
  }),
  companySkillService: () => ({
    completeTestRunForIssue: vi.fn(async () => null),
  }),
  documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(async () => []),
    saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
  }),
  goalService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => ({
    get: vi.fn(async () => ({
      id: "instance-settings-1",
      general: {
        censorUsernameInLogs: false,
        feedbackDataSharingPreference: "prompt",
      },
    })),
    listCompanyIds: vi.fn(async () => ["company-1"]),
  }),
  issueApprovalService: () => ({}),
  issueReferenceService: () => ({
    deleteDocumentSource: async () => undefined,
    diffIssueReferenceSummary: () => ({
      addedReferencedIssues: [],
      removedReferencedIssues: [],
      currentReferencedIssues: [],
    }),
    emptySummary: () => ({ outbound: [], inbound: [] }),
    listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
    syncComment: async () => undefined,
    syncDocument: async () => undefined,
    syncIssue: async () => undefined,
  }),
  issueRecoveryActionService: () => ({
    getActiveForIssue: vi.fn(async () => null),
    listActiveForIssues: vi.fn(async () => new Map()),
  }),
  issueTreeControlService: () => ({ getActivePauseHoldGate: mockPauseGate }),
  issueService: () => mockIssueService,
  issueThreadInteractionService: () => mockIssueThreadInteractionService,
  logActivity: vi.fn(async () => undefined),
  projectService: () => ({}),
  questionResponseDeliveryService: () => ({
    deliver: vi.fn(async () => undefined),
  }),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({}),
}));

function registerModuleMocks() {
  vi.doMock("../services/external-objects.js", () => ({
    externalObjectService: () => ({
      syncCommentSafely: vi.fn(async () => undefined),
      syncIssueSafely: vi.fn(async () => undefined),
    }),
  }));

  vi.doMock("../services/index.js", () => ({
    companyService: () => ({
      getById: vi.fn(async () => ({ id: "company-1" })),
    }),
    accessService: () => ({
      canUser: vi.fn(async () => true),
      decide: mockAccessDecide,
      hasPermission: vi.fn(async () => true),
    }),
    agentService: () => ({
      getById: vi.fn(async () => null),
      resolveByReference: vi.fn(async (_companyId: string, raw: string) => ({
        ambiguous: false,
        agent: { id: raw },
      })),
    }),
    companySkillService: () => ({
      completeTestRunForIssue: vi.fn(async () => null),
    }),
    documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
    documentService: () => ({}),
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(async () => []),
      saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
    goalService: () => ({}),
    heartbeatService: () => mockHeartbeatService,
    instanceSettingsService: () => ({
      get: vi.fn(async () => ({
        id: "instance-settings-1",
        general: {
          censorUsernameInLogs: false,
          feedbackDataSharingPreference: "prompt",
        },
      })),
      listCompanyIds: vi.fn(async () => ["company-1"]),
    }),
    issueApprovalService: () => ({}),
    issueReferenceService: () => ({
      deleteDocumentSource: async () => undefined,
      diffIssueReferenceSummary: () => ({
        addedReferencedIssues: [],
        removedReferencedIssues: [],
        currentReferencedIssues: [],
      }),
      emptySummary: () => ({ outbound: [], inbound: [] }),
      listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
      syncComment: async () => undefined,
      syncDocument: async () => undefined,
      syncIssue: async () => undefined,
    }),
    issueRecoveryActionService: () => ({
      getActiveForIssue: vi.fn(async () => null),
      listActiveForIssues: vi.fn(async () => new Map()),
    }),
    issueTreeControlService: () => ({ getActivePauseHoldGate: mockPauseGate }),
  issueService: () => mockIssueService,
    issueThreadInteractionService: () => mockIssueThreadInteractionService,
    logActivity: vi.fn(async () => undefined),
    projectService: () => ({}),
    questionResponseDeliveryService: () => ({
      deliver: vi.fn(async () => undefined),
    }),
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => ({}),
  }));
}

async function loadAppModules() {
  return Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
  ]);
}

async function createApp(transaction: (callback: (tx: Record<string, never>) => Promise<unknown>) => Promise<unknown> =
  async (callback) => callback({ select: () => ({ from: () => ({ where: () => Object.assign(Promise.resolve([]), { for: async () => [{ id: "comment-3" }] }) }) }) } as any)) {
  const [{ errorHandler }, { issueRoutes }] = await loadAppModules();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      runId: req.header("x-paperclip-run-id") ?? null,
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({
    transaction,
    select: () => ({ from: () => ({ where: async () => [] }) }),
  } as any, {} as any));
  app.use(errorHandler);
  return app;
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    companyId: "company-1",
    status: "todo",
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: null,
    assigneeUserId: "local-board",
    createdByUserId: "local-board",
    identifier: "PAP-999",
    title: "Wake test",
    executionPolicy: null,
    executionState: null,
    hiddenAt: null,
    ...overrides,
  };
}

describe("issue update comment wakeups", () => {
  beforeAll(async () => {
    vi.resetModules();
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    await loadAppModules();
  });

  beforeEach(() => {
    vi.resetAllMocks();
    mockAccessDecide.mockImplementation(async (input) => ({ allowed: true, action: input.action, reason: "allow_explicit_grant", explanation: "Allowed by test grant." }));
    mockPauseGate.mockResolvedValue(null);
    mockExecutionBlocker.mockResolvedValue(null);
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getByIdentifier.mockResolvedValue(null);
    mockIssueService.getByIdForUpdate.mockImplementation(async () => mockIssueService.getById());
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.getDependencyReadiness.mockResolvedValue({ unresolvedBlockerCount: 1 });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.getCurrentScheduledRetry.mockResolvedValue(null);
    mockIssueService.listReviewAttention.mockResolvedValue(new Map());
  });

  it.each(["post", "patch"] as const)("rejects %s board messages under an inherited pause before any mutation", async (method) => {
    const existing = makeIssue();
    mockIssueService.getById.mockResolvedValue(existing);
    mockPauseGate.mockResolvedValue({ holdId: "hold-1", rootIssueId: "parent-1" });
    const app = await createApp();
    const res = method === "post"
      ? await request(app).post(`/api/issues/${existing.id}/comments`).send({ body: "go", reopen: true, interrupt: true })
      : await request(app).patch(`/api/issues/${existing.id}`).send({ comment: "go", assigneeAgentId: ASSIGNEE_AGENT_ID, status: "todo" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Task is paused. Resume it before sending a message.");
    expect(res.body.details.rootIssueId).toBe("parent-1");
    expect(mockPauseGate).toHaveBeenCalledWith(existing.companyId, existing.id);
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it.each(["done", "cancelled"])(
    "keeps %s assignment-only updates from waking completed work",
    async (status) => {
      // A parent may restore the assignee after releasing a completed child.
      // That is recordkeeping, not a request to execute the child again.
      const existing = makeIssue({ status, assigneeAgentId: null, assigneeUserId: null });
      const updated = makeIssue({ status, assigneeAgentId: ASSIGNEE_AGENT_ID, assigneeUserId: null });
      mockIssueService.getById.mockResolvedValue(existing);
      mockIssueService.update.mockResolvedValue(updated);

      const res = await request(await createApp())
        .patch(`/api/issues/${existing.id}`)
        .send({ assigneeAgentId: ASSIGNEE_AGENT_ID });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status, assigneeAgentId: ASSIGNEE_AGENT_ID });
      await new Promise((resolve) => setImmediate(resolve));
      expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])("still wakes explicitly reopened work (reassigned: %s)", async (reassigned) => {
    const existing = makeIssue({ status: "done", assigneeAgentId: PREVIOUS_AGENT_ID, assigneeUserId: null });
    const agentId = reassigned ? ASSIGNEE_AGENT_ID : PREVIOUS_AGENT_ID;
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(makeIssue({ status: "todo", assigneeAgentId: agentId, assigneeUserId: null }));

    const res = await request(await createApp())
      .patch(`/api/issues/${existing.id}`)
      .send({ status: "todo", ...(reassigned ? { assigneeAgentId: agentId } : {}) });

    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1));
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({
      reason: reassigned ? "issue_assigned" : "issue_status_changed",
      payload: expect.objectContaining({ issueId: existing.id }),
    }));
  });

  it.each(["done", "cancelled"])("wakes the same assignee when another actor reopens %s work directly to in_progress", async (status) => {
    // FAC-760 STA-22 round 8: the next stage opened done -> in_progress with an
    // unchanged assignee and no wake, so recovery later replayed the old stage.
    const existing = makeIssue({ status, assigneeAgentId: ASSIGNEE_AGENT_ID, assigneeUserId: null });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(makeIssue({ status: "in_progress", assigneeAgentId: ASSIGNEE_AGENT_ID, assigneeUserId: null }));

    const res = await request(await createApp())
      .patch(`/api/issues/${existing.id}`)
      .send({ status: "in_progress" });

    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1));
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(ASSIGNEE_AGENT_ID, expect.objectContaining({
      reason: "issue_status_changed",
      payload: expect.objectContaining({ issueId: existing.id, mutation: "update" }),
      contextSnapshot: expect.objectContaining({ issueId: existing.id, source: "issue.status_change" }),
    }));
  });

  it("does not wake an in_progress task whose status did not change", async () => {
    const existing = makeIssue({ status: "in_progress", assigneeAgentId: ASSIGNEE_AGENT_ID, assigneeUserId: null });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(existing);

    const res = await request(await createApp())
      .patch(`/api/issues/${existing.id}`)
      .send({ status: "in_progress" });

    expect(res.status).toBe(200);
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });
});
