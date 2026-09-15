import { describe, it, expect } from 'vitest';
import {
  shouldIgnoreStaleClientRewind,
  shouldClearClientDecision,
} from '../../src/lib/pipelineWebhookGuard.js';

describe('shouldIgnoreStaleClientRewind', () => {
  it('does not ignore the first send-to-client while still pending', () => {
    expect(
      shouldIgnoreStaleClientRewind({
        existingStatus: 'pending_client_review',
        eventType: 'pipeline_sent_to_client',
        incomingStatus: 'pending_client_review',
      })
    ).toBe(false);
  });

  it('ignores a late pipeline_sent_to_client after client approved', () => {
    expect(
      shouldIgnoreStaleClientRewind({
        existingStatus: 'client_approved',
        eventType: 'pipeline_sent_to_client',
        incomingStatus: 'pending_client_review',
      })
    ).toBe(true);
  });

  it('ignores a late sent_to_client even if payload was re-read as client_approved', () => {
    expect(
      shouldIgnoreStaleClientRewind({
        existingStatus: 'client_approved',
        eventType: 'pipeline_sent_to_client',
        incomingStatus: 'client_approved',
      })
    ).toBe(true);
  });

  it('ignores a stale pending payload after client requested changes', () => {
    expect(
      shouldIgnoreStaleClientRewind({
        existingStatus: 'changes_requested_by_client',
        eventType: 'pipeline_pm_approved',
        incomingStatus: 'pending_client_review',
      })
    ).toBe(true);
  });

  it('still applies worker resubmit after client changes', () => {
    expect(
      shouldIgnoreStaleClientRewind({
        existingStatus: 'changes_requested_by_client',
        eventType: 'pipeline_resubmitted',
        incomingStatus: 'pending_pm_review',
      })
    ).toBe(false);
  });

  it('still applies publish / cancel', () => {
    expect(
      shouldIgnoreStaleClientRewind({
        existingStatus: 'client_approved',
        eventType: 'pipeline_published',
        incomingStatus: 'published',
      })
    ).toBe(false);
    expect(
      shouldIgnoreStaleClientRewind({
        existingStatus: 'client_approved',
        eventType: 'pipeline_cancelled',
        incomingStatus: 'cancelled',
      })
    ).toBe(false);
  });

  it('does not ignore link regeneration on an approved row', () => {
    expect(
      shouldIgnoreStaleClientRewind({
        existingStatus: 'client_approved',
        eventType: 'pipeline_links_regenerated',
        incomingStatus: 'client_approved',
      })
    ).toBe(false);
  });
});

describe('shouldClearClientDecision', () => {
  it('clears on a fresh send-to-client', () => {
    expect(
      shouldClearClientDecision({
        resolvedStatus: 'pending_client_review',
        eventType: 'pipeline_sent_to_client',
        existingStatus: 'pm_approved',
      })
    ).toBe(true);
  });

  it('does not clear after the client already decided', () => {
    expect(
      shouldClearClientDecision({
        resolvedStatus: 'pending_client_review',
        eventType: 'pipeline_sent_to_client',
        existingStatus: 'client_approved',
      })
    ).toBe(false);
  });

  it('clears on resubmit back to pending PM review', () => {
    expect(
      shouldClearClientDecision({
        resolvedStatus: 'pending_pm_review',
        eventType: 'pipeline_resubmitted',
        existingStatus: 'changes_requested_by_client',
      })
    ).toBe(false);
  });
});
