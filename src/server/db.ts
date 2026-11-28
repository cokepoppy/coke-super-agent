import mysql, { type Pool } from 'mysql2/promise';
import { config } from './config.ts';

export const pool: Pool = mysql.createPool({
  ...config.mysql,
  waitForConnections: true,
  connectionLimit: 8,
  queueLimit: 32,
  charset: 'utf8mb4',
  timezone: 'Z',
  decimalNumbers: true,
});

// A task holds its named lock for the entire run. Do not take those long-lived
// connections from the request pool: doing so can starve every status update.
export const runLeasePool: Pool = mysql.createPool({
  ...config.mysql,
  waitForConnections: true,
  connectionLimit: 8,
  queueLimit: 0,
  charset: 'utf8mb4',
  timezone: 'Z',
  decimalNumbers: true,
});
