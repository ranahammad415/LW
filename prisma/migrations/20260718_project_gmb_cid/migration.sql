-- Manual Google Business Profile binding for the DataForSEO fallback path.
-- Stores a Google CID, `place_id:...`, or business-name keyword used to pull
-- Business Profile info/reviews via DataForSEO while the native Business
-- Profile API quota (currently 0) is pending approval.
ALTER TABLE `project`
  ADD COLUMN `gmbCid` VARCHAR(200) NULL;
