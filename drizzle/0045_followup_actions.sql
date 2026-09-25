-- Which leads a campaign performing an INTERNAL leg actually acted on.
--
-- The follow-up queue hands a person to a worker (claim-next) and the worker records that it
-- answered them (kind 'acted'). Both are keyed on the lifecycle row of the campaign that HOLDS the
-- person — for ai-meeting-booking that is the PREDECESSOR cold-email campaign, never the AI
-- campaign itself — and neither write recorded who did it: the claim lease is overwritten on every
-- claim and released on every statement. So nothing could say which people the AI leg acted on, and
-- a consumer pricing that leg had nothing to divide its spend by.
--
-- An append-only ledger, written in the SAME statement as the claim / the 'acted' write, carrying
-- the campaign that ACTED (the x-campaign-id the worker was dispatched for) apart from the campaign
-- that HOLDS the row. No foreign key to leads_campaigns: the paid-pool requeue archives and deletes
-- lifecycle rows, and a ledger of what happened must survive that.
CREATE TABLE IF NOT EXISTS followup_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  brand_ids text[] NOT NULL,
  lead_campaign_id uuid NOT NULL,
  lead_id uuid NOT NULL,
  held_by_campaign_id text NOT NULL,
  acting_campaign_id text,
  run_id text,
  action text NOT NULL,
  occurred_at timestamptz NOT NULL,
  source text NOT NULL DEFAULT 'live',
  source_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT followup_actions_action_check CHECK (action IN ('claimed', 'acted'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_fa_acting_campaign ON followup_actions (acting_campaign_id, action);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_fa_brand_ids ON followup_actions USING gin (brand_ids);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_fa_source_ref ON followup_actions (source_ref) WHERE source_ref IS NOT NULL;
--> statement-breakpoint
-- History. Every claim that handed somebody out, and every 'acted' that followed a send, before this
-- ledger existed — read from the orchestrator's own job results (windmill v2_job_completed: the
-- claim-followup step's response and the record-followup step's response, each walked up to the
-- root flow whose input names the dispatched campaign and its run). That is a record of the claim
-- itself, not an inference from timing. Windmill's retention starts 2026-09-18; the first claim that
-- found anybody is 2026-09-21 15:22 UTC (before that the workflow asked its own campaign, which holds
-- nobody), so this is the complete history. Joined onto leads_campaigns, so an environment without
-- those rows (CI) inserts nothing; `source_ref` (the windmill job id) makes re-running a no-op.
INSERT INTO followup_actions
  (org_id, brand_ids, lead_campaign_id, lead_id, held_by_campaign_id, acting_campaign_id, run_id,
   action, occurred_at, source, source_ref)
SELECT lc.org_id, lc.brand_ids, lc.id, lc.lead_id, lc.campaign_id, v.acting, v.run_id,
       v.action, v.occurred_at::timestamptz, 'windmill_backfill', v.job
FROM (VALUES
  ('01a0c490-1bfb-f37a-432c-dd4e665030ea', '63f72b85-e147-4eff-83cc-282b952ad03e', '8c748ddd-86a2-4d7f-9f67-1528c7136665', '6e0cc200-f7ad-475c-805e-35b753088be1', 'claimed', '2026-09-21 15:22:53.92216+00'),
  ('01a0c490-5e50-fd3d-786a-bfba657981e3', '63f72b85-e147-4eff-83cc-282b952ad03e', '8c748ddd-86a2-4d7f-9f67-1528c7136665', '6e0cc200-f7ad-475c-805e-35b753088be1', 'acted', '2026-09-21 15:23:10.902622+00'),
  ('01a0c55a-df9f-5a2c-5769-31816d395be6', '63f72b85-e147-4eff-83cc-282b952ad03e', '8c748ddd-86a2-4d7f-9f67-1528c7136665', 'aa682b79-2af6-49c4-8954-a9fe6fadd97e', 'claimed', '2026-09-21 19:04:22.319763+00'),
  ('01a0c55b-36f8-78da-f957-e55a83b44636', '63f72b85-e147-4eff-83cc-282b952ad03e', '8c748ddd-86a2-4d7f-9f67-1528c7136665', 'aa682b79-2af6-49c4-8954-a9fe6fadd97e', 'acted', '2026-09-21 19:04:44.615415+00'),
  ('01a0c839-b289-545b-371e-75ce83451bf9', '63f72b85-e147-4eff-83cc-282b952ad03e', '8c748ddd-86a2-4d7f-9f67-1528c7136665', '49760afb-dd9d-4e99-ac10-7ef0f13055df', 'claimed', '2026-09-22 08:26:59.723287+00'),
  ('01a0c83d-0edf-90cb-03b1-909f4be95931', 'c9324b82-9385-4b1e-a242-9d1223e407de', '8c748ddd-86a2-4d7f-9f67-1528c7136665', 'edc65b9a-2703-497c-9916-330683881ae5', 'claimed', '2026-09-22 08:30:39.959771+00'),
  ('01a0c83d-c51c-5164-acd5-12b6706be64e', 'c9324b82-9385-4b1e-a242-9d1223e407de', '8c748ddd-86a2-4d7f-9f67-1528c7136665', 'edc65b9a-2703-497c-9916-330683881ae5', 'acted', '2026-09-22 08:31:26.993773+00'),
  ('01a0c875-2de2-ef8a-11ed-ebbcff407bf9', '63f72b85-e147-4eff-83cc-282b952ad03e', '8c748ddd-86a2-4d7f-9f67-1528c7136665', 'f5780419-e958-4395-a102-49c2a63558cb', 'claimed', '2026-09-22 09:31:57.897399+00'),
  ('01a0c8ad-92ca-39e5-6516-d0cdbe2f685d', '63f72b85-e147-4eff-83cc-282b952ad03e', '8c748ddd-86a2-4d7f-9f67-1528c7136665', '14d401c9-f6c2-4ce1-8df4-48414f758d1e', 'claimed', '2026-09-22 10:33:33.748016+00'),
  ('01a0c8e5-e381-45dd-1822-4ece011fbcc1', '63f72b85-e147-4eff-83cc-282b952ad03e', '8c748ddd-86a2-4d7f-9f67-1528c7136665', '169adee4-3a4b-48b4-8384-636f2c407e00', 'claimed', '2026-09-22 11:35:04.447657+00'),
  ('01a0c91e-1fdd-30eb-b3be-4d1651c96b38', '63f72b85-e147-4eff-83cc-282b952ad03e', '8c748ddd-86a2-4d7f-9f67-1528c7136665', '9c79fd7f-6734-48c3-9495-293260acfab4', 'claimed', '2026-09-22 12:36:29.89343+00'),
  ('01a0c956-6684-2b49-77e4-78bf8e33dd18', '63f72b85-e147-4eff-83cc-282b952ad03e', '8c748ddd-86a2-4d7f-9f67-1528c7136665', 'b63914c8-01f2-4662-9347-b64a82de0950', 'claimed', '2026-09-22 13:37:57.986993+00'),
  ('01a0c98e-a670-e90c-becc-e9408a1f4d49', '63f72b85-e147-4eff-83cc-282b952ad03e', '8c748ddd-86a2-4d7f-9f67-1528c7136665', 'eed980d7-6989-42a8-b596-73e1f168c906', 'claimed', '2026-09-22 14:39:24.37966+00'),
  ('01a0c9c6-e3f1-53ec-3318-beb7ea95c3e4', '63f72b85-e147-4eff-83cc-282b952ad03e', '8c748ddd-86a2-4d7f-9f67-1528c7136665', 'f6661c40-60ac-499f-b2bc-6040790bd6a1', 'claimed', '2026-09-22 15:40:50.135468+00'),
  ('01a0c9ff-3cae-6237-e868-3840b2fb6206', '63f72b85-e147-4eff-83cc-282b952ad03e', '8c748ddd-86a2-4d7f-9f67-1528c7136665', '9aab9f89-729b-49d9-9538-f793205a53e7', 'claimed', '2026-09-22 16:42:22.89777+00'),
  ('01a0ca37-9e7d-5412-f953-d0881320147a', '63f72b85-e147-4eff-83cc-282b952ad03e', '8c748ddd-86a2-4d7f-9f67-1528c7136665', 'b54a3699-d748-45ac-9e67-9d5771ec6d98', 'claimed', '2026-09-22 17:43:57.954694+00'),
  ('01a0ca6f-e834-57a2-5441-2fedd2207460', '63f72b85-e147-4eff-83cc-282b952ad03e', '8c748ddd-86a2-4d7f-9f67-1528c7136665', 'dbcf4dce-5391-450e-856c-a60e0a1c2379', 'claimed', '2026-09-22 18:45:26.893747+00'),
  ('01a0caa8-2f60-bc61-22e8-6167d10e7960', '63f72b85-e147-4eff-83cc-282b952ad03e', '8c748ddd-86a2-4d7f-9f67-1528c7136665', 'c7bc5f12-ffa5-4a50-8d67-ec9eee646ac3', 'claimed', '2026-09-22 19:46:55.054501+00'),
  ('01a0cae0-9a91-d92d-935c-91e0c8bf4773', '63f72b85-e147-4eff-83cc-282b952ad03e', '8c748ddd-86a2-4d7f-9f67-1528c7136665', '389b893f-25bd-488b-b428-850999feaca8', 'claimed', '2026-09-22 20:48:32.49764+00'),
  ('01a0cb18-ee06-c911-8808-2d47520a7142', '63f72b85-e147-4eff-83cc-282b952ad03e', '8c748ddd-86a2-4d7f-9f67-1528c7136665', 'd49b73d7-8bf8-4450-be6d-77f130d66a9c', 'claimed', '2026-09-22 21:50:03.878661+00'),
  ('01a0cb51-4924-21a8-6b62-e82134da4d6b', '63f72b85-e147-4eff-83cc-282b952ad03e', '8c748ddd-86a2-4d7f-9f67-1528c7136665', '29e67639-c1b1-4729-8dc4-508471c39f35', 'claimed', '2026-09-22 22:51:37.217396+00'),
  ('01a0cb89-86cd-ac35-f687-f94718672c78', '63f72b85-e147-4eff-83cc-282b952ad03e', '8c748ddd-86a2-4d7f-9f67-1528c7136665', '3609d729-6ba6-42f8-8d51-ebcbb32f5dc3', 'claimed', '2026-09-22 23:53:03.037698+00'),
  ('01a0cbc2-236b-775c-70e3-bf321ba800d8', '63f72b85-e147-4eff-83cc-282b952ad03e', '8c748ddd-86a2-4d7f-9f67-1528c7136665', '8c6009de-f88f-4f29-ada7-785c47cc7f01', 'claimed', '2026-09-23 00:54:53.132115+00'),
  ('01a0cbfa-68f0-2f8f-87ec-0d631927f9d9', '63f72b85-e147-4eff-83cc-282b952ad03e', '8c748ddd-86a2-4d7f-9f67-1528c7136665', 'e9b4dad9-fa65-4ad3-b3cf-d181a941cac6', 'claimed', '2026-09-23 01:56:20.961016+00'),
  ('01a0cc32-a3d6-ea05-19eb-d1b4ac742f72', '63f72b85-e147-4eff-83cc-282b952ad03e', '8c748ddd-86a2-4d7f-9f67-1528c7136665', 'c43dba77-8694-408a-a551-c0e878e6e1f0', 'claimed', '2026-09-23 02:57:46.046371+00'),
  ('01a0cc6b-5140-eb23-646c-9375cfcc8d69', '63f72b85-e147-4eff-83cc-282b952ad03e', '8c748ddd-86a2-4d7f-9f67-1528c7136665', '4d29571d-db2c-42aa-b436-a1b01ba3a16e', 'claimed', '2026-09-23 03:59:40.446018+00'),
  ('01a0cca3-97b2-193a-4a6e-ae811a06a47f', '63f72b85-e147-4eff-83cc-282b952ad03e', '8c748ddd-86a2-4d7f-9f67-1528c7136665', '41d8d7a8-c413-460a-9b1c-fd49c6371896', 'claimed', '2026-09-23 05:01:08.501772+00'),
  ('01a0ccdb-d4aa-947c-e916-84d4b98a3b6a', '63f72b85-e147-4eff-83cc-282b952ad03e', '8c748ddd-86a2-4d7f-9f67-1528c7136665', '9f418ce6-e425-42b6-9cf2-7bab4f4a882b', 'claimed', '2026-09-23 06:02:34.111602+00'),
  ('01a0cd14-0dbf-62ee-1388-c50e747b5e82', '63f72b85-e147-4eff-83cc-282b952ad03e', '8c748ddd-86a2-4d7f-9f67-1528c7136665', '93b281c2-1fc2-4c82-bae0-9cfe4bfda2a6', 'claimed', '2026-09-23 07:03:58.749305+00'),
  ('01a0cd4c-5b65-c7dd-cbeb-ccb102abc932', '63f72b85-e147-4eff-83cc-282b952ad03e', '8c748ddd-86a2-4d7f-9f67-1528c7136665', 'b5d91218-88b5-4921-8193-fb2a883df934', 'claimed', '2026-09-23 08:05:28.646363+00'),
  ('01a0cd84-9e5d-1412-acd0-5fba53188971', '63f72b85-e147-4eff-83cc-282b952ad03e', '8c748ddd-86a2-4d7f-9f67-1528c7136665', '97b30004-9319-4bb0-8e75-ca6f0f4f1ae8', 'claimed', '2026-09-23 09:06:55.80731+00'),
  ('01a0cdbd-085f-c630-5132-707059fbfa14', '63f72b85-e147-4eff-83cc-282b952ad03e', '8c748ddd-86a2-4d7f-9f67-1528c7136665', '6e884675-8ec5-45d2-b357-9174bf982df2', 'claimed', '2026-09-23 10:08:32.956516+00'),
  ('01a0cdf5-567c-ae40-190b-4bc46f90a009', '63f72b85-e147-4eff-83cc-282b952ad03e', '8c748ddd-86a2-4d7f-9f67-1528c7136665', '8b3236df-75d4-4583-a71c-e78f26fd679a', 'claimed', '2026-09-23 11:10:02.976443+00'),
  ('01a0ce2d-97d9-fdbb-f825-7648b016fb36', '63f72b85-e147-4eff-83cc-282b952ad03e', '8c748ddd-86a2-4d7f-9f67-1528c7136665', '5e2908b9-a833-4e1e-b1f3-f2f3be4c684c', 'claimed', '2026-09-23 12:11:29.736797+00'),
  ('01a0ce65-df13-0c49-f884-de1cadac15e4', '63f72b85-e147-4eff-83cc-282b952ad03e', '8c748ddd-86a2-4d7f-9f67-1528c7136665', 'b02dc8d1-9545-4e6f-973d-962438cb10a4', 'claimed', '2026-09-23 13:12:57.975784+00'),
  ('01a0ce9e-3c7a-7d53-293e-6a9e724210e4', '63f72b85-e147-4eff-83cc-282b952ad03e', '8c748ddd-86a2-4d7f-9f67-1528c7136665', '463d2528-d252-4b15-8586-aa85e0747d23', 'claimed', '2026-09-23 14:14:31.930099+00'),
  ('01a0ced6-87de-0c40-e1cd-95cd612791b0', '63f72b85-e147-4eff-83cc-282b952ad03e', '8c748ddd-86a2-4d7f-9f67-1528c7136665', '67247122-ba38-4bc4-9404-498e540a79dd', 'claimed', '2026-09-23 15:16:01.218398+00'),
  ('01a0cf0e-befc-a477-3060-ce910ab77556', '63f72b85-e147-4eff-83cc-282b952ad03e', '8c748ddd-86a2-4d7f-9f67-1528c7136665', '31874eb5-4902-479d-ae0f-d9dae7e9cdb9', 'claimed', '2026-09-23 16:17:25.376783+00'),
  ('01a0cf47-017d-1c66-8f91-38688591bf26', '63f72b85-e147-4eff-83cc-282b952ad03e', '8c748ddd-86a2-4d7f-9f67-1528c7136665', '5bd03d1d-b00e-4349-b5e3-3344337e72e2', 'claimed', '2026-09-23 17:18:52.383087+00'),
  ('01a0cf7f-5713-2c10-31d1-772ce228ce1a', '63f72b85-e147-4eff-83cc-282b952ad03e', '8c748ddd-86a2-4d7f-9f67-1528c7136665', '223d1952-786d-4422-ac03-8c8ab920e046', 'claimed', '2026-09-23 18:20:24.305336+00'),
  ('01a0cfb7-9d63-a3a2-4e8b-b818b10f62dc', '63f72b85-e147-4eff-83cc-282b952ad03e', '8c748ddd-86a2-4d7f-9f67-1528c7136665', '81dba27c-80c7-45de-9549-f509931673c8', 'claimed', '2026-09-23 19:21:52.316434+00'),
  ('01a0cfef-ff9c-ae12-6c4c-f74045b1a935', '63f72b85-e147-4eff-83cc-282b952ad03e', '8c748ddd-86a2-4d7f-9f67-1528c7136665', 'c78f8ae0-a11f-4199-8d82-5a98b16703c7', 'claimed', '2026-09-23 20:23:27.477089+00'),
  ('01a0d028-4074-7b99-0b3c-cdec82708360', '63f72b85-e147-4eff-83cc-282b952ad03e', '8c748ddd-86a2-4d7f-9f67-1528c7136665', 'e8e683b6-3fab-43a0-a562-e47958ffcffa', 'claimed', '2026-09-23 21:24:54.844626+00'),
  ('01a0d060-9826-ccc4-969e-2862e3bdc895', '63f72b85-e147-4eff-83cc-282b952ad03e', '8c748ddd-86a2-4d7f-9f67-1528c7136665', '835fa8cb-dce8-42e3-92d0-e77b104904e1', 'claimed', '2026-09-23 22:26:26.55953+00'),
  ('01a0d098-dd4c-c8b0-f4eb-3cb187d5e537', '63f72b85-e147-4eff-83cc-282b952ad03e', '8c748ddd-86a2-4d7f-9f67-1528c7136665', '24e35e19-9a3d-4b5b-82d7-fd050d2ebae6', 'claimed', '2026-09-23 23:27:54.284584+00'),
  ('01a0d0d1-167a-50b3-c8ec-cb5a5f71ec42', '63f72b85-e147-4eff-83cc-282b952ad03e', '8c748ddd-86a2-4d7f-9f67-1528c7136665', '28f04081-16b0-441e-84b0-313af49f9b94', 'claimed', '2026-09-24 00:29:18.950262+00'),
  ('01a0d109-684f-a26a-8f5f-03572f8c8480', '63f72b85-e147-4eff-83cc-282b952ad03e', '8c748ddd-86a2-4d7f-9f67-1528c7136665', 'fceed2e8-371c-4830-bdad-3ccf858d2f62', 'claimed', '2026-09-24 01:30:49.942496+00'),
  ('01a0d141-a39a-139b-0477-464e7401f3b7', '63f72b85-e147-4eff-83cc-282b952ad03e', '8c748ddd-86a2-4d7f-9f67-1528c7136665', 'cde98765-4569-4e56-b157-a2fb13413c02', 'claimed', '2026-09-24 02:32:15.091646+00'),
  ('01a0d179-f9da-941e-34e7-a64b1c88e77c', '63f72b85-e147-4eff-83cc-282b952ad03e', '8c748ddd-86a2-4d7f-9f67-1528c7136665', '24786ac3-b01f-4f39-b0a4-47974f3c4735', 'claimed', '2026-09-24 03:33:47.189674+00'),
  ('01a0d1b2-3bd2-aa49-06ea-efc65fa1f396', '63f72b85-e147-4eff-83cc-282b952ad03e', '8c748ddd-86a2-4d7f-9f67-1528c7136665', '8ea90a73-d685-4937-b8ad-f0735ccf77bd', 'claimed', '2026-09-24 04:35:14.129788+00'),
  ('01a0d1ea-7b26-2a86-1e2f-c0da0bc044ea', '63f72b85-e147-4eff-83cc-282b952ad03e', '8c748ddd-86a2-4d7f-9f67-1528c7136665', 'bec75801-b77c-4e75-a84c-f2db232ac580', 'claimed', '2026-09-24 05:36:40.332938+00'),
  ('01a0d222-e381-5883-0e3c-c9c24d5f551e', '63f72b85-e147-4eff-83cc-282b952ad03e', '8c748ddd-86a2-4d7f-9f67-1528c7136665', 'fd94146e-9410-4bf1-ace2-be8a13f383ad', 'claimed', '2026-09-24 06:38:17.076426+00'),
  ('01a0d25b-53f7-c1f0-4d71-9de573cd9a30', '63f72b85-e147-4eff-83cc-282b952ad03e', '8c748ddd-86a2-4d7f-9f67-1528c7136665', '2e59b93f-a55e-489b-af1a-2ad08c7f3cd3', 'claimed', '2026-09-24 07:39:55.902141+00'),
  ('01a0d293-9a4a-4dff-daab-ddd11934b1bb', '63f72b85-e147-4eff-83cc-282b952ad03e', '8c748ddd-86a2-4d7f-9f67-1528c7136665', 'bc27ac67-df73-4c9f-8113-ddbdc5caf8ed', 'claimed', '2026-09-24 08:41:23.952007+00'),
  ('01a0d2cc-288d-2dc8-365c-affd01fa7145', '63f72b85-e147-4eff-83cc-282b952ad03e', '8c748ddd-86a2-4d7f-9f67-1528c7136665', 'a514ca7c-473a-46d6-91f3-c0602804bacb', 'claimed', '2026-09-24 09:43:10.336842+00'),
  ('01a0d304-6ad9-7c60-f36c-9ead6b247eed', '63f72b85-e147-4eff-83cc-282b952ad03e', '8c748ddd-86a2-4d7f-9f67-1528c7136665', '563f1973-c0a4-4a7d-b639-d9ec63f2aaae', 'claimed', '2026-09-24 10:44:37.382148+00'),
  ('01a0d33c-a6b2-23f1-34b4-4ef6bebe9fee', '63f72b85-e147-4eff-83cc-282b952ad03e', '8c748ddd-86a2-4d7f-9f67-1528c7136665', 'c95d19ab-0849-4f83-88ea-5473b3cd54d6', 'claimed', '2026-09-24 11:46:02.779924+00'),
  ('01a0d375-e1e1-0912-cf03-26ae6cf3105e', '63f72b85-e147-4eff-83cc-282b952ad03e', '8c748ddd-86a2-4d7f-9f67-1528c7136665', '9cc34627-4aa0-427e-8432-558a4be38303', 'claimed', '2026-09-24 12:48:33.756061+00'),
  ('01a0d462-3cce-07ce-928b-48775e339aae', '234df07e-7f24-4241-b03b-73f60f565223', '8c748ddd-86a2-4d7f-9f67-1528c7136665', 'fbd5812a-65c6-4709-9bf7-ffc128c8b790', 'claimed', '2026-09-24 17:06:43.182121+00'),
  ('01a0d462-8322-9d25-00e0-a2c9994249ca', '234df07e-7f24-4241-b03b-73f60f565223', '8c748ddd-86a2-4d7f-9f67-1528c7136665', 'fbd5812a-65c6-4709-9bf7-ffc128c8b790', 'acted', '2026-09-24 17:07:01.168022+00'),
  ('01a0d55f-d0a6-4f4b-0c9c-6a4571669798', '982c7d05-b19d-4264-a073-02d38df09cf8', '8c748ddd-86a2-4d7f-9f67-1528c7136665', '7aea98d9-bf14-4139-9671-f30f08fd41b8', 'claimed', '2026-09-24 21:43:41.703521+00'),
  ('01a0d55f-fc78-ada8-7953-4cf8a29a4aea', '982c7d05-b19d-4264-a073-02d38df09cf8', '8c748ddd-86a2-4d7f-9f67-1528c7136665', '7aea98d9-bf14-4139-9671-f30f08fd41b8', 'acted', '2026-09-24 21:43:52.775797+00'),
  ('01a0d739-1516-bfe9-9dac-f4909222d2dc', '982c7d05-b19d-4264-a073-02d38df09cf8', '8c748ddd-86a2-4d7f-9f67-1528c7136665', 'f62565a8-fff1-4974-9cb4-e67273ab57b2', 'claimed', '2026-09-25 06:20:37.70026+00'),
  ('01a0d771-7445-b55e-b095-224e6ecf88b7', '982c7d05-b19d-4264-a073-02d38df09cf8', '8c748ddd-86a2-4d7f-9f67-1528c7136665', '736839f8-4810-46ef-9bd8-9af995ceaa29', 'claimed', '2026-09-25 07:22:12.073289+00'),
  ('01a0d771-b1fe-3253-0166-12341d7dd4b0', '982c7d05-b19d-4264-a073-02d38df09cf8', '8c748ddd-86a2-4d7f-9f67-1528c7136665', '736839f8-4810-46ef-9bd8-9af995ceaa29', 'acted', '2026-09-25 07:22:27.866117+00'),
  ('01a0d8ce-6077-973e-6bc1-d61e6d63d5fd', '982c7d05-b19d-4264-a073-02d38df09cf8', '8c748ddd-86a2-4d7f-9f67-1528c7136665', '746dd389-55b2-461e-8e5c-312ec8557fc6', 'claimed', '2026-09-25 13:43:19.002644+00'),
  ('01a0d8ce-8b77-482e-91ed-08d548d973ba', '982c7d05-b19d-4264-a073-02d38df09cf8', '8c748ddd-86a2-4d7f-9f67-1528c7136665', '746dd389-55b2-461e-8e5c-312ec8557fc6', 'acted', '2026-09-25 13:43:30.024125+00')
) AS v(job, lcid, acting, run_id, action, occurred_at)
JOIN leads_campaigns lc ON lc.id = v.lcid::uuid
ON CONFLICT (source_ref) WHERE source_ref IS NOT NULL DO NOTHING;
