import { expectDefined } from "@openclaw/normalization-core";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  formatEmbeddedAgentQueueFailureSummary,
  queueEmbeddedAgentMessageWithOutcomeAsync,
} from "../../agents/embedded-agent-runner/runs.js";
import { logVerbose } from "../../globals.js";
import {
  type RunReplyAgentParams,
  scheduleFollowupDrainAfterReplyOperationClear,
} from "./agent-runner-core.js";
import { finalizeAcceptedSteer } from "./agent-runner-steer-adoption.js";
import {
  admitFollowupRunLifecycle,
  parkSteerCandidate,
  resolveFollowupAbortSignal,
  scheduleFollowupDrain,
  type FollowupRun,
  type QueueSettings,
} from "./queue.js";
import type { ReplyOperationRunState } from "./reply-operation-run-state.js";
import { type ReplyOperation, replyRunRegistry } from "./reply-run-registry.js";
import { refreshReplyOperationTyping } from "./reply-run-typing.js";
import { buildChannelSourceTurnId } from "./source-turn-id.js";

export async function handleActiveSteerAdmission(params: {
  cleanupTyping: () => void;
  followupRun: FollowupRun;
  providedReplyOperation: ReplyOperation | undefined;
  queueKey: string;
  queuedRunFollowupTurn: (run: FollowupRun) => Promise<void>;
  releaseAdmissionTicket: () => void;
  replyOperationRunState: ReplyOperationRunState | undefined;
  resolvedQueue: QueueSettings;
  restartRecoverySourceTurnId: string | undefined;
  runId: string | undefined;
  sessionCtx: Pick<
    RunReplyAgentParams["sessionCtx"],
    "AccountId" | "MessageSid" | "MessageSidFull" | "Provider"
  >;
  sessionKey: string | undefined;
  touchActiveSessionEntry: () => Promise<void>;
  typingShouldStartImmediately: boolean;
}): Promise<void> {
  // Steer against the operation that owns THIS session's run slot. A native
  // command continuation whose slot adoption was skipped (#104844) still
  // carries a source-keyed reservation; steering by its stale sessionId
  // would miss the live target run.
  const registeredReplyOperation = params.sessionKey
    ? replyRunRegistry.get(params.sessionKey)
    : undefined;
  const activeReplyOperation =
    params.providedReplyOperation?.key === params.sessionKey
      ? params.providedReplyOperation
      : (registeredReplyOperation ?? params.providedReplyOperation);
  const steerSessionId = activeReplyOperation?.sessionId ?? params.followupRun.run.sessionId;
  const parked = parkSteerCandidate(
    params.queueKey,
    params.followupRun,
    params.resolvedQueue,
    params.queuedRunFollowupTurn,
  );
  if (!parked) {
    params.releaseAdmissionTicket();
    params.cleanupTyping();
    return;
  }
  const scheduleParkedFallback = () => {
    const owner = replyRunRegistry.get(params.queueKey);
    if (owner) {
      scheduleFollowupDrainAfterReplyOperationClear({
        operation: owner,
        queueKey: params.queueKey,
        runFollowup: params.queuedRunFollowupTurn,
      });
    } else {
      scheduleFollowupDrain(params.queueKey, params.queuedRunFollowupTurn);
    }
  };
  scheduleParkedFallback();
  params.releaseAdmissionTicket();
  try {
    const admission = await parked.admit();
    if (admission === "cancelled") {
      parked.consume();
      params.cleanupTyping();
      return;
    }
    if (admission === "fallback") {
      parked.fallback();
      if (params.replyOperationRunState) {
        params.replyOperationRunState.admission = { status: "accepted", mode: "followup" };
      }
      await params.touchActiveSessionEntry();
      params.cleanupTyping();
      return;
    }
    // Channel dispatch normally stamps the route-scoped source id. Internal
    // callers can derive the same per-message identity from the prepared turn.
    const steerRunId = expectDefined(
      params.restartRecoverySourceTurnId ??
        buildChannelSourceTurnId({
          provider:
            params.followupRun.originatingChannel ??
            params.followupRun.run.messageProvider ??
            params.sessionCtx.Provider,
          accountId:
            params.followupRun.originatingAccountId ??
            params.followupRun.run.agentAccountId ??
            params.sessionCtx.AccountId,
          conversationId:
            params.followupRun.originatingTo ??
            params.followupRun.originatingChatId ??
            params.sessionKey ??
            params.followupRun.run.sessionKey,
          messageId:
            params.followupRun.messageId ??
            params.sessionCtx.MessageSidFull ??
            params.sessionCtx.MessageSid,
        }) ??
        normalizeOptionalString(params.runId),
      "steered turn id",
    );
    const steerOutcome = await queueEmbeddedAgentMessageWithOutcomeAsync(
      steerSessionId,
      params.followupRun.prompt,
      {
        steeringMode: "all",
        isInboundUserMessage: true,
        ...(params.followupRun.images?.length ? { images: params.followupRun.images } : {}),
        ...(params.followupRun.imageOrder?.length
          ? { imageOrder: params.followupRun.imageOrder }
          : {}),
        ...(params.followupRun.media?.length ? { media: params.followupRun.media } : {}),
        waitForTranscriptCommit: true,
        queueIdentity: steerRunId,
        abortSignal: resolveFollowupAbortSignal(params.followupRun),
        onQueueAccepted: (accepted) => parked.accepted(accepted),
        ...(params.resolvedQueue.debounceMs !== undefined
          ? { debounceMs: params.resolvedQueue.debounceMs }
          : {}),
        ...(params.followupRun.run.sourceReplyDeliveryMode
          ? { sourceReplyDeliveryMode: params.followupRun.run.sourceReplyDeliveryMode }
          : {}),
        taskSuggestionDeliveryMode: params.followupRun.run.taskSuggestionDeliveryMode,
        ...(params.followupRun.userTurnTranscriptRecorder
          ? { userTurnTranscriptRecorder: params.followupRun.userTurnTranscriptRecorder }
          : {}),
      },
    );
    if (!steerOutcome.queued) {
      parked.fallback();
      if (params.replyOperationRunState) {
        params.replyOperationRunState.admission = { status: "accepted", mode: "followup" };
      }
      const summary = formatEmbeddedAgentQueueFailureSummary(steerOutcome);
      logVerbose(`queue: active session ${steerSessionId} rejected steering injection: ${summary}`);
      await params.touchActiveSessionEntry();
      params.cleanupTyping();
      return;
    }
    const adoptionDisposition = await finalizeAcceptedSteer({
      activeReplyOperation,
      abortKey: params.sessionKey ?? params.queueKey,
      cleanupTyping: params.cleanupTyping,
      errorMessage: steerOutcome.errorMessage,
      onAdopted: () => admitFollowupRunLifecycle(params.followupRun),
      replyOperationRunState: params.replyOperationRunState,
      steerSessionId,
      transcriptCommit: steerOutcome.transcriptCommit,
    });
    parked.consume();
    if (adoptionDisposition === "stop") {
      return;
    }
    if (params.followupRun.currentInboundAudio === true) {
      activeReplyOperation?.markAcceptedSteeredInboundAudio();
    }
    if (activeReplyOperation) {
      await refreshReplyOperationTyping(activeReplyOperation, {
        startIfIdle: params.typingShouldStartImmediately,
      });
    }
    await params.touchActiveSessionEntry();
    params.cleanupTyping();
  } catch (error) {
    if (resolveFollowupAbortSignal(params.followupRun)?.aborted) {
      parked.consume();
    } else {
      parked.fallback();
    }
    throw error;
  } finally {
    if (params.followupRun.steerPending) {
      if (resolveFollowupAbortSignal(params.followupRun)?.aborted) {
        parked.consume();
      } else {
        parked.fallback();
      }
    }
  }
}
