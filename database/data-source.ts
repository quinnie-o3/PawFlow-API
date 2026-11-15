import 'dotenv/config';
import { join } from 'node:path';
import { DataSource } from 'typeorm';

const AppDataSource = new DataSource({
  type: 'postgres',

  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),

  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,

  synchronize: false,

  // P3-BE11: same DB_SSL contract as the application (disable | require | no-verify),
  // so migrations can run against a TLS-only staging/production database.
  ssl:
    process.env.DB_SSL?.trim().toLowerCase() === 'require'
      ? { rejectUnauthorized: true }
      : process.env.DB_SSL?.trim().toLowerCase() === 'no-verify'
        ? { rejectUnauthorized: false }
        : false,

  entities: [
    join(__dirname, '..', 'src', '**', '*.entity.{ts,js}').replace(
      /\\/g,
      '/',
    ),
  ],

  migrations: [
    join(__dirname, '..', 'src', 'database', 'migrations', '*.{ts,js}').replace(
      /\\/g,
      '/',
    ),
  ],

  migrationsTableName: 'migrations',
});

export default AppDataSource;
