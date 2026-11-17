import pg from "pg";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5000,
});

// Idle clients can emit errors when PostgreSQL restarts. Keep the API alive so
// request handlers can return their normal unavailable responses.
pool.on("error", () => {
  console.error("PostgreSQL idle connection unavailable");
});

export default pool;
