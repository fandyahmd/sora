import { Hoshimi, SearchSources, type TrackStructure } from 'hoshimi';
export type VoiceContext = { guildId?: string; channelId: string; author: { id: string }; member?: { voice(): Promise<{ channelId?: string | null } | undefined> } };
import { Suggestions } from './suggestions.js';
import { GuildStore } from './db.js';

export class MusicService {
  readonly suggestions = new Suggestions<TrackStructure>();

  private readonly pending = new Map<string, Promise<unknown>>();
  constructor(readonly manager: Hoshimi, private readonly checkPermissions: ((ctx: VoiceContext, voiceId: string) => Promise<void>) | undefined, readonly autoplay: Pick<GuildStore, 'has' | 'toggleAutoplay'>) {}

  private serial<T>(guildId: string, task: () => Promise<T>): Promise<T> {
    const next = (this.pending.get(guildId) ?? Promise.resolve()).catch(() => {}).then(task);
    this.pending.set(guildId, next);
    void next.finally(() => { if (this.pending.get(guildId) === next) this.pending.delete(guildId); }).catch(() => {});
    return next;
  }

  async search(query: string, requester: string) {
    if (!this.manager.isUsable()) throw new Error('Music service is not ready yet. Please try again shortly.');
    const result = await this.manager.search({ query, source: SearchSources.Youtube, requester: { id: requester } });
    if (result.exception) throw new Error('Music search failed. Please try again.');
    return result.tracks;
  }

  async voice(ctx: VoiceContext) {
    if (!ctx.guildId || !ctx.member) throw new Error('Use this command in a server.');
    // Seyfert falls back to REST GET /voice-states/:id, which 404s (10065) when the member has no state.
    const state = await ctx.member.voice().catch(() => undefined);
    if (!state?.channelId) throw new Error('Join a voice channel first.');
    const player = this.manager.players.get(ctx.guildId);
    if (player?.options.voiceId && player.options.voiceId !== state.channelId) {
      throw new Error('Join the same voice channel as Sora.');
    }
    await this.checkPermissions?.(ctx, state.channelId);
    return state.channelId;
  }

  play(ctx: VoiceContext, query: string) {
    return this.serial(ctx.guildId ?? '', () => this.playRequest(ctx, query));
  }

  private async playRequest(ctx: VoiceContext, query: string) {
    query = query.trim();
    if (!query || query.length > 500) throw new Error('Song title or URL must be 1–500 characters.');
    const voiceId = await this.voice(ctx);
    const guildId = ctx.guildId!;
    let tracks: TrackStructure[];
    if (query.startsWith('track:')) {
      const track = this.suggestions.get(guildId, query);
      if (!track) throw new Error('This selection expired. Search for the song again.');
      tracks = [track];
    } else {
      tracks = (await this.search(query, ctx.author.id)).slice(0, /^https?:\/\//i.test(query) ? 100 : 1);
    }
    if (!tracks.length) throw new Error('No tracks found. Try another title or supported URL.');
    const player = this.manager.players.get(guildId) ?? this.manager.createPlayer({
      guildId, voiceId, textId: ctx.channelId, selfDeaf: true,
    });
    if (!player.connected) await player.connect();
    // A fresh player starts with autoplay off, so re-apply the guild's saved choice.
    if (this.autoplay.has(guildId)) await player.data.set('enabledAutoplay', true);
    await player.queue.add(tracks);
    if (!player.queue.current && !player.isPlaying() && !player.isPaused()) await player.play();
    return tracks;
  }

  /** Flip autoplay for the guild and, when a player is live, for the running queue too. */
  toggleAutoplay(guildId: string) {
    return this.serial(guildId, async () => {
      const enabled = await this.autoplay.toggleAutoplay(guildId);
      const player = this.manager.players.get(guildId);
      if (player) await player.data.set('enabledAutoplay', enabled);
      return enabled;
    });
  }

  control(ctx: VoiceContext, action: 'pause' | 'resume' | 'skip' | 'next' | 'previous' | 'stop') {
    return this.serial(ctx.guildId ?? '', () => this.controlRequest(ctx, action));
  }

  private async controlRequest(ctx: VoiceContext, action: 'pause' | 'resume' | 'skip' | 'next' | 'previous' | 'stop') {
    await this.voice(ctx);
    const player = this.manager.players.get(ctx.guildId!);
    if (!player) throw new Error('Nothing is playing yet. Use /play to start.');
    if (action === 'stop') await player.destroy();
    else if (action === 'previous') {
      const track = await player.queue.previous(true);
      if (!track) throw new Error('No previous track is available.');
      if (player.queue.current) await player.queue.unshift(player.queue.current);
      await player.play({ track });
    }
    else if (action === 'skip' || action === 'next') {
      if (!player.queue.tracks?.length) throw new Error('Queue is empty. Add another song first.');
      await player.skip();
    }
    else await player.setPaused(action === 'pause');
  }
}
