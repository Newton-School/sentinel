// Global vitest setup — runs before each test file (registered via setupFiles
// in vitest.config.ts).
//
// DB-touching tests run against Postgres. Each vitest worker gets its own
// database (sentinel_test_<workerId>) for cross-worker isolation; the DB tests
// mock `src/config.js` with `DATABASE_URL: process.env.DATABASE_URL` and call
// `initDb()` + `resetTestDb()` for a clean slate per test. We export the
// per-worker URL into the env here so both the mocks and any real-config test
// resolve the same database.
import { ensureTestDatabase, TEST_DATABASE_URL } from "./helpers/pgTest.js";

process.env.DATABASE_URL = TEST_DATABASE_URL;
await ensureTestDatabase();
