CREATE TABLE admin_password_credentials (
  admin_id UUID PRIMARY KEY REFERENCES admin_identities(id) ON DELETE RESTRICT,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT admin_password_credentials_hash_check CHECK (
    password_hash ~ '^scrypt\$[0-9]+\$[0-9]+\$[0-9]+\$[a-f0-9]{32}\$[a-f0-9]{128}$'
  ),
  CONSTRAINT admin_password_credentials_lifecycle_check CHECK (
    updated_at >= created_at
  )
);
