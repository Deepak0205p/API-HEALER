import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    host: process.env.SQL_HOST!,
    database: process.env.SQL_DB_NAME!,
    user: process.env.SQL_ADMIN_USER || process.env.SQL_USER!,
    password: process.env.SQL_ADMIN_PASSWORD || process.env.SQL_PASSWORD!,
    ssl: false,
  },
});
