import { DatabaseSync } from 'node:sqlite';

export function createDatabase() {
  const connection = new DatabaseSync(':memory:');
  const writes = [];
  return {
    connection,
    writes,
    database: {
      async execAsync(sql) { connection.exec(sql); },
      async runAsync(sql, ...params) {
        writes.push({ sql, params });
        return connection.prepare(sql).run(...params);
      },
      async getFirstAsync(sql, ...params) { return connection.prepare(sql).get(...params) ?? null; },
      async getAllAsync(sql, ...params) { return connection.prepare(sql).all(...params); },
      async withTransactionAsync(callback) {
        connection.exec('BEGIN');
        try {
          await callback();
          connection.exec('COMMIT');
        } catch (error) {
          connection.exec('ROLLBACK');
          throw error;
        }
      },
    },
  };
}
