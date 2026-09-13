ALTER TABLE suppliers
  DROP CONSTRAINT suppliers_record_version_check,
  DROP COLUMN record_version;
