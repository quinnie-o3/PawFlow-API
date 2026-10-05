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

  entities: [
    join(
      __dirname,
      '..',
      'src',
      'providers',
      'entities',
      '*.entity.{ts,js}',
    ).replace(/\\/g, '/'),
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
