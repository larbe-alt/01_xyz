/**
 * Throwaway inspector: dump the column schema + a sample row + row count for
 * each parquet file passed as an argument. Used to understand the fuel_o2
 * recorder's on-disk schema (which differs from this repo's recorder schema).
 *
 *   tsx src/scripts/inspect-parquet.ts data/raw/*.parquet
 */
import duckdb from "duckdb";

function all(db: duckdb.Database, sql: string): Promise<any[]> {
  return new Promise((resolve, reject) =>
    db.all(sql, (err: Error | null, rows: any[]) => (err ? reject(err) : resolve(rows))),
  );
}

const files = process.argv.slice(2);
const db = new duckdb.Database(":memory:");

for (const f of files) {
  const q = `'${f.replace(/'/g, "''")}'`;
  console.log("\n========================================");
  console.log(f);
  console.log("========================================");
  try {
    const schema = await all(db, `DESCRIBE SELECT * FROM read_parquet(${q})`);
    console.log("COLUMNS:");
    for (const c of schema) console.log(`  ${c.column_name.padEnd(22)} ${c.column_type}`);
    const cnt = await all(db, `SELECT count(*) AS n FROM read_parquet(${q})`);
    console.log(`ROWS: ${cnt[0].n}`);
    const sample = await all(db, `SELECT * FROM read_parquet(${q}) LIMIT 2`);
    console.log("SAMPLE:");
    for (const row of sample) {
      const trimmed: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) {
        const s = typeof v === "string" && v.length > 80 ? v.slice(0, 80) + "…" : v;
        trimmed[k] = typeof s === "bigint" ? s.toString() : s;
      }
      console.log("  " + JSON.stringify(trimmed));
    }
  } catch (e) {
    console.log("  ERROR:", e instanceof Error ? e.message : String(e));
  }
}

await new Promise<void>((r) => db.close(() => r()));
