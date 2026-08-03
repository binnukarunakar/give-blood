import { PGlite } from '@electric-sql/pglite';
import { expect, test } from 'vitest';

test('vitest wiring is functional', () => {
  expect(1 + 1).toBe(2);
});

test('pglite opens an in-memory database and runs SELECT 1', async () => {
  const db = new PGlite();
  try {
    const result = await db.query<{ answer: number }>('SELECT 1 AS answer');
    expect(result.rows[0]?.answer).toBe(1);
  } finally {
    await db.close();
  }
});
