// Entry point: boot the API server.
//
//   npm run seed     # give the index something to search (sample docs)
//   npm start        # then open http://127.0.0.1:3000

import { createApp } from './src/api/app.js';

const app = await createApp();

app.server.listen(app.config.port, app.config.host, () => {
  console.log(`search engine listening on http://${app.config.host}:${app.config.port}`);
  console.log(`index: ${app.index.docCount} documents, ${app.index.termCount} terms`);
  if (app.index.docCount === 0) {
    console.log('index is empty — run `npm run seed` for sample data, or `npm run crawl -- <url>`');
  }
});

let closing = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (closing) return;
    closing = true;
    console.log(`\n${signal} received — flushing data to disk…`);
    await app.close();
    process.exit(0);
  });
}
