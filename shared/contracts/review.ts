/** A configurable independent reviewer; names do not grant special behavior or permissions. */
export interface ReviewParticipant {
  name: string;
  instructions: string;
  modelId?: string | null;
  tools?: string[];
}

/** Application defaults or explicit overrides for a run's autonomous review cycle. */
export interface ReviewSettings {
  enabled?: boolean;
  participants?: ReviewParticipant[];
  /** Omit or use null to continue until the team has no actionable findings. */
  maxRounds?: number | null;
}

/** An actionable observation against the actual task and changed files. */
export interface ReviewFinding {
  message: string;
  path?: string;
  line?: number;
}

/** Actual command observations, separate from a reviewer's claims about verification. */
export interface ReviewCommand {
  command: string;
  exitCode?: number;
  failed: boolean;
}

/** One independent session's persisted result within a review round. */
export interface RunReview {
  sessionId: string;
  name: string;
  round: number;
  status: string;
  summary?: string;
  findings?: ReviewFinding[];
  commands?: ReviewCommand[];
  error?: string;
}

/** Review progress is visible without turning findings into permission to apply a result. */
export interface RunReviewState {
  configuration: ReviewSettings;
  status: string;
  reports: RunReview[];
  error?: string;
}
