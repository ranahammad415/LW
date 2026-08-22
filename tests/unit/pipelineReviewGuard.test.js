import { describe, it, expect } from 'vitest';
import { hasWpPostStatus, isOrphanWpPostStatus } from '../../src/lib/pipelineReviewGuard.js';

describe('isOrphanWpPostStatus', () => {
  it('treats missing and empty statuses as orphaned', () => {
    expect(isOrphanWpPostStatus(undefined)).toBe(true);
    expect(isOrphanWpPostStatus(null)).toBe(true);
    expect(isOrphanWpPostStatus('')).toBe(true);
    expect(isOrphanWpPostStatus('   ')).toBe(true);
  });

  it('treats trash and deleted as orphaned', () => {
    expect(isOrphanWpPostStatus('trash')).toBe(true);
    expect(isOrphanWpPostStatus('TRASH')).toBe(true);
    expect(isOrphanWpPostStatus('deleted')).toBe(true);
  });

  it('keeps live and draft posts', () => {
    expect(isOrphanWpPostStatus('publish')).toBe(false);
    expect(isOrphanWpPostStatus('draft')).toBe(false);
    expect(isOrphanWpPostStatus('pending')).toBe(false);
    expect(isOrphanWpPostStatus('private')).toBe(false);
    expect(isOrphanWpPostStatus('future')).toBe(false);
  });
});

describe('hasWpPostStatus', () => {
  it('is false when the plugin omitted the field', () => {
    expect(hasWpPostStatus({})).toBe(false);
    expect(hasWpPostStatus({ id: 13, status: 'pending_client_review' })).toBe(false);
  });

  it('is true when WordPress sent an explicit status, including empty', () => {
    expect(hasWpPostStatus({ wpPostStatus: '' })).toBe(true);
    expect(hasWpPostStatus({ wpPostStatus: 'publish' })).toBe(true);
    expect(hasWpPostStatus({ wp_post_status: 'trash' })).toBe(true);
  });
});
