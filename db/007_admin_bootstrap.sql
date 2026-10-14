-- =====================================================================
-- No seeded administrator.
--
-- The real administrator is promoted at startup from the ADMIN_PHONE
-- environment variable — see src/db/migrate.ts. That keeps a personal number
-- out of a public repository, and makes the grant reversible by changing a
-- Railway variable rather than editing an applied migration.
-- =====================================================================

-- Guard against a second one ever being seeded by accident.
COMMENT ON COLUMN users.roles IS
  'Role array. Administrators are granted via the ADMIN_PHONE environment '
  'variable at startup, never seeded into a migration — a committed admin '
  'phone number is a credential in version control.';
