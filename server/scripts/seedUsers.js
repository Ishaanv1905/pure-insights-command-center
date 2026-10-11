// Creates the three demo accounts if the users table is empty.
// The server does this automatically in development; this script is for when
// SEED_DEMO_USERS=false or you want to seed a fresh database explicitly.

import { loadConfig } from '../src/config/index.js';
import { createContainer } from '../src/container.js';
import { DEMO_USERS } from '../src/services/authService.js';

const container = createContainer(loadConfig());
const created = await container.services.auth.seedDemoUsers();
if (created.length === 0) {
  console.log('Users already exist - nothing seeded.');
} else {
  console.log('Seeded demo users:');
  for (const u of DEMO_USERS) console.log(`  ${u.role.padEnd(8)} ${u.email}  /  ${u.password}`);
}
container.close();
