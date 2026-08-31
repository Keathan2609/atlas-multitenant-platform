-- The integration suite runs against a physically separate database so a test
-- run can TRUNCATE freely without destroying local development data.
-- Created here at first container init; see docs/testing.md.
CREATE DATABASE atlas_test OWNER atlas;
