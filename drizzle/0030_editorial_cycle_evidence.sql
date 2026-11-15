ALTER TABLE editorial_cycle_media_tasks DROP CONSTRAINT editorial_cycle_media_tasks_kind_check;
ALTER TABLE editorial_cycle_media_tasks ADD CONSTRAINT editorial_cycle_media_tasks_kind_check CHECK(kind IN ('render','youtube_audio','evidence'));
