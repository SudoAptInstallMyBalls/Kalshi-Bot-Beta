// Demo launcher isolates credentials, SQLite, persisted positions and models.
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const root = require('#src/config/paths').root;
const envFile = path.join(root, '.env.demo');
if (!fs.existsSync(envFile)) throw new Error('Create .env.demo from .env.demo.example with separate demo credentials');
const config = dotenv.parse(fs.readFileSync(envFile));
for (const key of ['KALSHI_API_KEY', 'KALSHI_PRIVATE_KEY_PATH', 'BOT_CONTROL_TOKEN']) {
  if (!config[key] || config[key].startsWith('replace_')) throw new Error(`Set ${key} in .env.demo`);
}
if (!fs.existsSync(path.resolve(root, config.KALSHI_PRIVATE_KEY_PATH))) throw new Error('Demo private key file not found');
// A production base64 key inherited from the shell must never override the demo file.
delete process.env.KALSHI_PRIVATE_KEY_BASE64;
Object.assign(process.env, config, {
  KALSHI_API_BASE: 'https://external-api.demo.kalshi.co',
  KALSHI_PRIVATE_KEY_PATH: path.resolve(root, config.KALSHI_PRIVATE_KEY_PATH),
  BOT_ENV_FILE: envFile,
  BOT_DATA_DIR: path.join(root, 'data/demo'),
  HOST: '127.0.0.1',
  PORT: config.PORT || '3334',
});
require('../server.js');
