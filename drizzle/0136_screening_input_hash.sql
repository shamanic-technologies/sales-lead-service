-- BLIND-SCREEN-CACHE-1101: a stored screen verdict is reused only for the SAME judged input. Verdicts made on a blank
-- teaser (10-27 to 11-01) were served again to the same candidates once human-service re-offered them WITH facts, so
-- they were declined without their real facts ever being read. NULL (every older row) = never reused: judged again.
ALTER TABLE "candidate_screenings" ADD COLUMN IF NOT EXISTS "input_hash" text;
