import { spawn } from 'node:child_process';
import { startLocalDatabase } from './local-db.js';

const db = await startLocalDatabase();
const child = spawn('npx', ['vitest', 'run'], { stdio: 'inherit', env: { ...process.env, RUN_DYNAMODB_TESTS: '1' }, shell: false });
child.on('exit', code => { db?.kill(); process.exit(code ?? 1); });
child.on('error', error => { db?.kill(); console.error(error.message); process.exit(1); });
