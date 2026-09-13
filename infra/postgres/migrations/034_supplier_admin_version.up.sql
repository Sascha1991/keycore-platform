ALTER TABLE suppliers
  ADD COLUMN record_version INTEGER NOT NULL DEFAULT 1,
  ADD CONSTRAINT suppliers_record_version_check CHECK (record_version > 0);
