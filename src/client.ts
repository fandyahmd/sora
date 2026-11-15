import { Client } from 'seyfert';
import { displayText } from './ui/text.js';
import { Hoshimi, type NodeOptions } from 'hoshimi';
import { RequestChannels } from './services/channels.js';
import { MusicService } from './services/music.js';
import { GuildStore } from './services/db.js';

export class MusicClient extends Client {
  readonly store = new GuildStore();
  readonly music: MusicService;
  readonly requestChannels: RequestChannels;

  constructor(node: NodeOptions) {
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
        void channels.refresh(player.guildId).catch(error => console.error('Panel update failed:', error));
      });
    }
    // New track, new lyrics: the service looks them up itself and then follows the player's own
    // position, so the panel stays correct on any node whether or not its lyrics plugin works.
    manager.on('trackStart', player => {
      void channels.lyrics.trackStart(player).then(() => channels.refresh(player.guildId)).catch(error => console.error('Lyrics lookup failed:', error));
    });
  }
}

declare module 'seyfert' {
  interface SeyfertRegistry { client: MusicClient; }
}
