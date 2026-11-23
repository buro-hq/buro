import type { WorkSegmentPolicy } from '../../core/work-segments.ts';

/** Explicit fixture for testing rotation, archive integrity and custom policy pins. */
export const testBoundedWorkSegmentPolicy: WorkSegmentPolicy = {
  revision: 'test-bounded-work-segments',
  limits: {
    revision: 'test-bounded-work-segments',
    maxToolRounds: 3,
    maxSegments: 4,
    contextThresholdPercent: 60,
  },
  decide({ limits, toolRounds, observedTokens, maxOutputTokens, contextTokens }) {
    if (limits.maxToolRounds === undefined || limits.contextThresholdPercent === undefined)
      throw Error('The test policy requires explicit tool-round and context limits.');
    return toolRounds >= limits.maxToolRounds ||
      (observedTokens ?? 0) + maxOutputTokens >=
        (contextTokens * limits.contextThresholdPercent) / 100
      ? 'close'
      : 'continue';
  },
};
