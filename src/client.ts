import { Client } from 'seyfert';
import { displayText } from './ui/text.js';
import { Hoshimi, type NodeOptions } from 'hoshimi';
import { RequestChannels } from './services/channels.js';
import { MusicService } from './services/music.js';
import { GuildStore } from './services/db.js';

export class MusicClient extends Client {
  readonly music: MusicService;
  readonly requestChannels: RequestChannels;

  constructor(node: NodeOptions, readonly store: GuildStore) {
    super({
      commands: {
        defaults: {
          onRunError: async (ctx, error) => {
            console.error('Command error:', error);
            await ctx.editOrReply({
              content: displayText(error instanceof Error ? error.message : 'Unable to complete this command. Please try again.', 300),
              allowed_mentions: { parse: [] },
            });
          },
        },
      },
    });
    const manager = new Hoshimi({
      nodes: [node],
      nodeOptions: { sessionOptions: { resumable: true, byLibrary: true, timeout: 60 } },
      playerOptions: { onDisconnect: { autoDestroy: true } },
      sendPayload: async (guildId, payload) => { await this.gateway.send(this.gateway.calculateShardId(guildId), payload); },
    });
    manager.on('nodeReady', (node) => console.log(`Lavalink ready: ${node.id}`));
    manager.on('nodeError', (_node, error) => console.error('Lavalink node error:', error));
    manager.on('playerError', (_player, error) => console.error('Lavalink player error:', error));
    manager.on('trackError', (_player, _track, payload) => console.error('Track exception:', payload));
    this.music = new MusicService(manager, async (ctx, voiceId) => {
      const me = await this.guilds.fetchSelf(ctx.guildId!);
      if (!(await this.channels.memberPermissions(voiceId, me)).has(['ViewChannel', 'Connect', 'Speak'])) {
        throw new Error('Sora needs View Channel, Connect, and Speak in your voice channel.');
      }
      if (!(await this.channels.memberPermissions(ctx.channelId, me)).has(['ViewChannel', 'SendMessages'])) {
        throw new Error('Sora needs View Channel and Send Messages in this text channel.');
      }
    }, this.store);
    this.requestChannels = new RequestChannels(this, this.store);
    const channels = this.requestChannels;
    for (const event of ['queueEnd', 'playerDestroy', 'playerPaused', 'playerResumed', 'queueUpdate'] as const) {
      manager.on(event, (...[player]) => {
        // A finished player has nothing left to sing, so its lines and ticker go with it.
        if (event === 'queueEnd' || event === 'playerDestroy') channels.lyrics.forget(player.guildId);
        if (event === 'playerPaused' || event === 'playerResumed') channels.lyrics.align(player);
        void channels.refresh(player.guildId).catch(error => console.error('Panel update failed:', error));
      });
    }
    // Position corrections and seeks re-arm the boundary timer without adding a polling loop.
    manager.on('playerUpdate', player => {
      // Hoshimi 0.6.1 resets the wall-clock anchor on every node packet, even while paused.
      // Freeze it here or resume's position getter counts paused time until the next node correction.
      if (player.isPaused()) player.lastPositionUpdate = null;
      channels.lyrics.align(player);
    });
    // New title immediately; LRCLIB latency must not hold the controller behind the playing audio.
    manager.on('trackStart', player => {
      const lookup = channels.lyrics.trackStart(player);
      void channels.refresh(player.guildId).catch(error => console.error('Panel update failed:', error));
      void lookup.catch(error => console.error('Lyrics lookup failed:', error));
    });
  }
}

declare module 'seyfert' {
  interface SeyfertRegistry { client: MusicClient; }
}
