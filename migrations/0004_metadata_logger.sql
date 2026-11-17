-- Issues created before `logger` joined the metadata have no such key, and
-- the strict parse in src/db/issues.ts rejects them, failing the whole issue
-- list. Give them the value the consumer writes when an event has no logger.
UPDATE groups
SET metadata = json_set(metadata, '$.logger', json('null'))
WHERE json_type(metadata, '$.logger') IS NULL;
