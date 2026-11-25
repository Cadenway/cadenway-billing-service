import { z } from 'zod';

const sequence = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const brokerProgress = z.object({
  stream: z.string().min(1),
  createdAt: z.string().min(1),
  firstSequence: sequence,
  lastSequence: sequence,
  retainedGapCount: sequence,
  consumers: z.array(
    z.object({
      handler: z.string().min(1),
      createdAt: z.string().min(1),
      deliveredSequence: sequence,
      ackFloorSequence: sequence,
      pending: sequence,
      ackPending: sequence,
    }),
  ),
});

/** Validates persisted broker observations before a rebuild resumes. */
export const usageRebuildCheckpoint = z.object({
  version: z.literal(1),
  start: brokerProgress,
  advisory: z.object({ createdAt: z.string().min(1), lastSequence: sequence }).optional(),
  promotion: brokerProgress.optional(),
  verified: brokerProgress.optional(),
});
