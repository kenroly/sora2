import { buildServer } from './server.js';
import { runtimeConfig } from './config.js';

async function main() {
  const app = buildServer();
  await app.listen({
    port: runtimeConfig.PORT,
    host: runtimeConfig.HOST
  });
}

main().catch((error) => {
  console.error('Monitor gateway failed to start', error);
  process.exit(1);
});


