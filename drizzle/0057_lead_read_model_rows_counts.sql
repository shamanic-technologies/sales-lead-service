-- Counts and filters of a read model (tab counts, board counts, a standing column, a bucket) read
-- one model's rows. Without an index that carries those columns, every count was a scan of the
-- whole lead_read_model_rows table (all models of all orgs, ~310k rows): ~75ms per count on the
-- largest model and the table's dominant read load. Led by model_id + standing so a standing
-- filter or GROUP BY reads only the model's index entries; buckets/sent/delivered/stage ride
-- along for bucket and funnel counts.
CREATE INDEX IF NOT EXISTS idx_lrmr_model_standing
  ON lead_read_model_rows (model_id, standing) INCLUDE (buckets, sent, delivered, stage);
