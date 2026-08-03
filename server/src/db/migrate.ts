// Forward-only migration runner. Reads src/db/migrations/*.sql in filename
// order and executes each as one multi-statement batch. Dependency-free:
// node:fs plus the WHATWG URL global (readdir/readFile accept file: URLs), so
// it needs no __dirname/path resolution. Any PGlite instance satisfies the
// executor contract (its `exec` runs multi-statement SQL).
import { readdirSync, readFileSync } from 'node:fs';

/** Minimal executor contract — PGlite's `exec(sql)` matches structurally. */
export interface SqlExecutor {
  exec(sql: string): Promise<unknown>;
}

const migrationsDir = new URL('./migrations/', import.meta.url);

/** Applies every *.sql migration in filename order. Returns the files run. */
export async function applyMigrations(db: SqlExecutor): Promise<string[]> {
  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sqlText = readFileSync(new URL(file, migrationsDir), 'utf8');
    await db.exec(sqlText);
  }
  return files;
}
