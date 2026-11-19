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
