-- Add explicit committed state for reservation lifecycle (reserved -> committed -> consumed/released)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'reservation_status'
      AND e.enumlabel = 'committed'
  ) THEN
    ALTER TYPE reservation_status ADD VALUE 'committed' AFTER 'reserved';
  END IF;
END $$;
