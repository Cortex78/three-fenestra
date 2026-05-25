-- Migration 001: Enable PostGIS and UUID generation
-- Run first: core extensions required by all subsequent migrations.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS postgis_topology;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- trigram index on text search
CREATE EXTENSION IF NOT EXISTS btree_gin; -- composite GIN indexes
