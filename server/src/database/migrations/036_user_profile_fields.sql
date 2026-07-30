-- 036_user_profile_fields.sql - Auth + Onboarding sprint. Adds the
-- fields Register/Profile/email-verification need that Sprint A's
-- minimal users table didn't - full_name (collected at registration,
-- shown on Profile) and email_verified (the soft-verification gate
-- middleware/requireVerifiedEmail.js checks). Existing rows default to
-- email_verified=0 - the two admin-provisioned test accounts from
-- Sprint A are not silently grandfathered in as verified.

ALTER TABLE users ADD COLUMN full_name TEXT;
ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;
