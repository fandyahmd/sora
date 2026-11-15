import { MusicClient } from './client.js';
import { readConfig } from './config.js';
import { startHealthServer } from './services/health.js';

// Start the probe server first so the port is listening from the moment the process is up: a host that
// health-checks this container (Render, Koyeb) then sees a live service rather than a dead deploy.
let players = 0;
const server = startHealthServer({ players: () => players });

// A misconfigured deploy should fail loudly and immediately, with the missing variable named — that is
// far easier to act on than a container that stays up and silently does nothing.
let config;
try {
  config = readConfig();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  console.error('Fix the environment and redeploy. See .env.example for every variable.');
  server.stop(true);
  process.exit(1);
}

const client = new MusicClient(config.node);
try {
  await client.start();
  await client.uploadCommands({ cachePath: './commands.json' });
  players = client.music.manager.players.size;
  console.log(`Ready: ${client.botId}`);
} catch (error) {
  // A rejected token or an unreachable gateway must not kill the probe server: the host would then
  // restart the container forever with no way to see why. Report the failure and stay up.
  console.error('Startup failed:', error instanceof Error ? error.message : error);
  console.error('The health server stays up so this message can be read from the deploy logs.');
}

async function shutdown() {
  for (const player of client.music.manager.players.values()) await player.destroy();
  client.music.manager.nodeManager.destroyAll();
  await client.close();
  server.stop(true);
  process.exit(0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
