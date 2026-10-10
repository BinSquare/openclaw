import { isCapturedMainRestartTurnCurrent } from "../../config/sessions/main-session-recovery.types.js";
import { hasRestartRecoveryTerminalRun } from "../../config/sessions/restart-recovery-state.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";

/** A terminal delivery source cannot claim a different, still-current accepted input. */
export function retireTerminalMainSessionRecoverySource(
  entry: InternalSessionEntry,
  sessionKey: string,
): void {
  const terminalSource = entry.restartRecoveryDeliverySourceRunId;
  const retained = entry.mainRestartRecovery;
  if (
    terminalSource &&
    hasRestartRecoveryTerminalRun(entry, terminalSource) &&
    retained?.turnIntent &&
    retained.turnIntent.runId !== terminalSource &&
    retained.turnIntent.sessionKey === sessionKey &&
    isCapturedMainRestartTurnCurrent(entry) &&
    !entry.restartRecoveryRuns?.length &&
    !entry.activeWriterRunId &&
    !entry.lifecycleRunId &&
    !entry.restartRecoveryDeliveryRunId &&
    !entry.pendingFinalDelivery &&
    !retained.reservation &&
    !retained.foregroundClaims &&
    !retained.pause &&
    !retained.acknowledgedPause &&
    !retained.tombstone &&
    !retained.capacityWait &&
    !retained.queuedInputId &&
    !entry.restartRecoveryGoal &&
    !retained.goalIntent
  ) {
    // Clear only source selection; preserve the fresh cycle, issuer and effect hints.
    entry.restartRecoveryDeliverySourceRunId = undefined;
  }
}
