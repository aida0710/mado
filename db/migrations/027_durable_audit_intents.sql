-- Mutation実行前にpending audit intentを永続化し、process crashやaudit完了失敗でも
-- 「何も記録されない」状態を避ける。

ALTER TABLE audit_events
  DROP CONSTRAINT IF EXISTS audit_events_outcome_check;

ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_outcome_check
  CHECK (outcome IN ('pending', 'success', 'denied', 'failure'));
