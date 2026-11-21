import { QuotaUsageError } from '../../errors/quotas/quota-usage.error.js';

/**
 * Measures the verified bytes of one ready attachment. The Storage event contract records file
 * usage at `file.uploaded.v1` and removes it at `file.deleted.v1`. A pending reservation does
 * not contribute measured bytes.
 */
export function attachmentUsageBytes(
  attachment:
    | { readonly state: 'ready'; readonly verifiedSizeBytes: number }
    | { readonly state: 'pending' | 'deleted' },
): number {
  if (attachment.state !== 'ready') return 0;
  const size = attachment.verifiedSizeBytes;
  if (!Number.isSafeInteger(size) || size < 1) {
    throw new QuotaUsageError('storage', 'invalid-usage');
  }
  return size;
}
