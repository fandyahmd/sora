/**
 * Health server. Render and Koyeb both stop an idle free instance, and the cheapest defence is to
 * answer a plain HTTP request: Render's own health check and Koyeb's TCP check hit this, and either
 * one can also be pointed at by an external pinger (UptimeRobot, cron-job.org) to keep the service
 * warm. `bun` serves it with no framework.
 *
 * GET /        -> 200 "ok"        (the liveness probe every host expects)
 * GET /health  -> 200 JSON        (the same, plus uptime and active players, for a human or a monitor)
 *
 * Set PORT to listen on a fixed port; hosts inject it, and the default keeps local runs simple.
 */
import { BRAND } from '../ui/theme.js';

export function startHealthServer(details: { players: () => number }) {
  const port = Number(process.env.PORT ?? 3000);
  const started = Date.now();

  const server = Bun.serve({
    port,
    // A monitor only needs the status code; never let a probe touch the gateway or the node.
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/health') {
        return Response.json({
          status: 'ok',
          service: BRAND,
          uptimeSeconds: Math.floor((Date.now() - started) / 1000),
          players: details.players(),
        });
      }
      return new Response('ok', { headers: { 'content-type': 'text/plain' } });
    },
  });

  console.log(`Health server listening on :${server.port}`);
  return server;
}
