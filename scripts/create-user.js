// Create an account (and API key) from the command line.
// Usage: npm run create-user -- someone@example.com

import { makeConfig } from '../src/config.js';
import { JsonStore } from '../src/storage/store.js';
import { emptyUsersData, createAccount } from '../src/api/auth.js';

const email = process.argv[2];
if (!email) {
  console.error('usage: npm run create-user -- <email>');
  process.exit(1);
}

const config = makeConfig();
const store = await new JsonStore(config.dataDir, 'users', emptyUsersData()).load();

try {
  const { user, apiKey } = createAccount(store.data, email);
  await store.save();
  console.log(`account created: ${user.email} (${user.id})`);
  console.log(`api key (shown once, store it now): ${apiKey}`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
