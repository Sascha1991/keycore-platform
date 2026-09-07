DROP INDEX IF EXISTS audit_events_admin_staff_idx;
DROP TABLE IF EXISTS admin_permission_grants;
DROP INDEX IF EXISTS admin_role_assignments_one_active_idx;
DROP INDEX IF EXISTS admin_identities_email_idx;
DROP INDEX IF EXISTS admin_identities_employee_number_idx;
ALTER TABLE admin_identities
  DROP CONSTRAINT IF EXISTS admin_identities_email_check,
  DROP CONSTRAINT IF EXISTS admin_identities_staff_profile_check,
  DROP COLUMN IF EXISTS email_normalized,
  DROP COLUMN IF EXISTS employee_number,
  DROP COLUMN IF EXISTS last_name,
  DROP COLUMN IF EXISTS first_name;
