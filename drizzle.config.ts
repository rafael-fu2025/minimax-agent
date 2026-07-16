import "dotenv/config";
import type { Config } from "drizzle-kit";

const url = process.env.DATABASE_URL;
if (!url) {
  // drizzle-kit reads from `.env` automatically when we run via tsx, but warn
  // loudly here so `db:generate` doesn't silently succeed against the wrong DB.
  console.warn(
    "[drizzle.config] DATABASE_URL is not set; migrations may target the wrong database.",
  );
}

export default {
  schema: "./server/db/schema.ts",
  out: "./server/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: url ?? "postgres://postgres:postgres@localhost:5433/astryx",
  },
  verbose: true,
  strict: true,
} satisfies Config;
