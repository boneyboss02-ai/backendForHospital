-- =============================================================================
-- Backfill legacy job posts created before the fee agreement was required
-- =============================================================================
-- The fee_agreement_signed CHECK constraint (migration 004) re-validates on
-- EVERY update to a job_posts row, not just inserts. Any job posted before
-- that migration ran has NULL fee_agreement_signature/accepted_at, so even
-- unrelated updates to that row (e.g. the application_count trigger firing
-- when a student applies) now fail the constraint. Backfill a placeholder
-- so existing jobs are unblocked.

UPDATE job_posts
SET
  fee_agreement_signature = 'LEGACY — posted before the fee agreement was introduced',
  fee_agreement_accepted_at = created_at
WHERE fee_agreement_signature IS NULL;

-- Same problem, same fix, for job_applications (migration 005's
-- applicant_fee_agreement_signed constraint). Any application submitted
-- before that migration ran would otherwise block on the next update
-- (e.g. the poster accepting/rejecting it).
UPDATE job_applications
SET
  fee_agreement_signature = 'LEGACY — applied before the fee agreement was introduced',
  fee_agreement_accepted_at = applied_at
WHERE fee_agreement_signature IS NULL;
