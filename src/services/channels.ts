/**
 * Request channel: persistent panel, instant cleanup of member messages, and short-lived feedback.
 * Every Discord write for the request channel funnels through here, so the contract
 * "member's line disappears, Sora answers in its place, the answer self-destructs"
 * is implemented exactly once.
 */
import { ChannelType, type GatewayMessageCreateDispatchData } from 'seyfert';
import type { MusicClient } from '../client.js';
import { displayText } from '../ui/text.js';
import { bannerFile } from '../ui/banner.js';
import { idleCard, playerCard } from '../ui/cards.js';
import { added, failed } from '../feedback.js';
import { GuildStore } from './db.js';
import { LyricsService } from './lyrics.js';
import { requestFromMessage } from './requests.js';

const FEEDBACK_LIFETIME = 5_000;
const CLEANUP_WARNING_INTERVAL = 60_000;

/**
 * Discord allows one message 5 edits per 5 s and refills one per second. The panel draws from a token
 * bucket: a small reserve so ordinary traffic never waits, refilled at Discord's own rate. Staying just
 * inside the budget matters because Seyfert sleeps through a 429 *in-place*, stalling every later write.
 */
const PANEL_REFILL_MS = 1_000;
const PANEL_BURST_TOKENS = 3;

/** Live lyrics are rendered into the panel, so the service that fetches them drives the same refresh. */
export class RequestChannels {
  readonly lyrics: LyricsService;
  private readonly pending = new Map<string, Promise<unknown>>();
  /** Latest-state-wins panel writer: `wanted` = a draw is owed, `writing` = the loop in flight. */
  private readonly wanted = new Set<string>();
  private readonly writing = new Map<string, Promise<unknown>>();
  private readonly drawn = new Map<string, number>();
  /** Edit budget left for this guild's panel, in Discord's own units (one edit per second). */
  private readonly tokens = new Map<string, number>();
  private lastCleanupWarning = -Infinity;
  constructor(private readonly client: MusicClient, readonly store: Pick<GuildStore, 'get' | 'entries' | 'set' | 'clear'>) {
    this.lyrics = new LyricsService(guildId => this.refresh(guildId));
  }

  /** One mutation per guild at a time, so overlapping requests cannot write the panel twice. */
  private serial<T>(guildId: string, task: () => Promise<T>): Promise<T> {
    const next = (this.pending.get(guildId) ?? Promise.resolve()).catch(() => {}).then(task);
    this.pending.set(guildId, next);
    void next.finally(() => { if (this.pending.get(guildId) === next) this.pending.delete(guildId); }).catch(() => {});
    return next;
  }

  /**
   * Write the panel, collapsed: many callers, one message edit.
   *
   * Discord allows this message 5 edits per 5 s and refills one per second, and answers a sixth call
   * with 429 `retry-after` which Seyfert sleeps through *inside* the request — so a burst (a skip fires
   * trackStart, playerUpdate and queueUpdate at once) must never queue one edit per caller.
   *
   * The pacing is a token bucket, not a fixed gap: a fixed 1.1 s delay is safe but it also holds back
   * the *first* edit after a quiet spell, and that delay is visible as a lyric line landing late on
   * Discord. The bucket refills at Discord's own 1/s, holds a small reserve so ordinary traffic never
   * queues, and applies its wait before the request rather than letting the HTTP layer absorb a 429.
   */
  private draw(guildId: string): Promise<unknown> {
    this.wanted.add(guildId);
    const existing = this.writing.get(guildId);
    if (existing) return existing;
    const run = (async () => {
      try {
        for (;;) {
          // A macrotask of slack lets callers that fire in the same tick — exactly what a skip does —
          // join this draw instead of each scheduling their own edit.
          await new Promise(resolve => setTimeout(resolve, 0).unref());
          const now = Date.now();
          const tokens = Math.min(PANEL_BURST_TOKENS, (this.tokens.get(guildId) ?? PANEL_BURST_TOKENS) + (now - (this.drawn.get(guildId) ?? now)) / PANEL_REFILL_MS);
          if (tokens < 1) {
            // Too soon: wait exactly until one token exists, then draw once from the newest state.
            await new Promise(resolve => setTimeout(resolve, Math.ceil((1 - tokens) * PANEL_REFILL_MS)).unref());
            continue;
          }
          this.wanted.delete(guildId);
          this.tokens.set(guildId, Math.min(PANEL_BURST_TOKENS, tokens) - 1);
          this.drawn.set(guildId, Date.now());
          await this.write(guildId);
          if (!this.wanted.has(guildId)) break;
        }
      } finally { this.writing.delete(guildId); }
    })();
    this.writing.set(guildId, run);
    return run;
  }

  /** Panel payload for the guild's current player state: idle card, or player card with artwork. */
  private body(guildId: string) {
    const player = this.client.music.manager.players.get(guildId);
    const current = player?.destroyed ? undefined : player?.queue.current;
    if (!current) return { ...idleCard(this.client.botId), files: bannerFile() };
    const playback = {
      title: current.info.title, uri: current.info.uri, artworkUrl: current.info.artworkUrl,
      author: current.info.author, length: current.info.length, isStream: current.info.isStream,
      requesterId: (current.requester as { id?: string } | undefined)?.id,
      paused: player!.isPaused(),
      hasPrevious: !!player!.queue.history.length, hasNext: !!player!.queue.tracks.length,
      autoplay: this.client.music.autoplay.has(guildId),
    };
    return playerCard(playback, this.lyrics.current(guildId));
  }

  setup(guildId: string, channelId?: string) {
    return this.serial(guildId, async () => {
      const old = this.store.get(guildId);
      // Only a channel Sora created and nobody chose may be deleted later, so track where it came from.
      const made = channelId || old ? undefined : await this.createChannel(guildId);
      const target = channelId ?? old?.requestChannelId ?? made!.id;
      const owned = channelId ? false : old ? old.channelOwned ?? false : made!.created;
      const channel = await this.client.channels.fetch(target);
      if (channel.type !== ChannelType.GuildText || !('guildId' in channel) || channel.guildId !== guildId) throw new Error('Choose a text channel in this server.');
      const me = await this.client.guilds.fetchSelf(guildId);
      if (!(await this.client.channels.memberPermissions(target, me)).has(['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'EmbedLinks', 'ManageMessages', 'AttachFiles'])) {
        throw new Error('Sora needs View Channel, Send Messages, Read Message History, Embed Links, Manage Messages, and Attach Files in the request channel.');
      }
      if (old?.requestChannelId === target) {
        try {
          await this.client.messages.edit(old.panelMessageId, target, this.body(guildId));
          await this.store.set(guildId, { requestChannelId: target, panelMessageId: old.panelMessageId, channelOwned: owned });
          return target;
        } catch (error) {
          if (!this.stale(error)) throw error;
          await this.publish(guildId, target, old.panelMessageId, owned);
        }
      } else await this.publish(guildId, target, undefined, owned);
      if (old && old.requestChannelId !== target) await this.client.messages.edit(old.panelMessageId, old.requestChannelId, {
        components: [], attachments: [], allowed_mentions: { parse: [] },
      }).catch(() => {});
      return target;
    });
  }

  /**
   * Drop the guild's setup. The channel goes too when Sora created it, because that channel exists
   * only for the panel; a channel the member picked is theirs and is left standing.
   */
  teardown(guildId: string) {
    return this.serial(guildId, async () => {
      const binding = this.store.get(guildId);
      if (!binding) throw new Error('Sora is not set up in this server yet.');
      // Forget the guild first: a failed channel delete must not leave a binding to a dead channel.
      await this.store.clear(guildId);
      if (!binding.channelOwned) {
        await this.clear(binding.panelMessageId, binding.requestChannelId);
        return { channelId: binding.requestChannelId, channelDeleted: false };
      }
      // Deleting the channel removes the panel with it, so no separate message delete is needed.
      await this.client.channels.delete(binding.requestChannelId).catch(error => {
        console.warn('Request channel delete failed.', binding.requestChannelId, (error as { code?: number })?.code ?? 'unknown');
      });
      return { channelId: binding.requestChannelId, channelDeleted: true };
    });
  }

  /** Reuse an existing channel by name when there is one; otherwise create it. `created` marks Sora's own channel. */
  private async createChannel(guildId: string) {
    const me = await this.client.guilds.fetchSelf(guildId);
    if (!(await me.fetchPermissions()).has(['ManageChannels'])) throw new Error('Sora needs Manage Channels permission to create a channel.');
    const existing = (await this.client.guilds.channels.list(guildId))
      .find(channel => channel.type === ChannelType.GuildText && 'name' in channel && channel.name === 'sora-request-song');
    if (existing) return { id: existing.id, created: false };
    const channel = await this.client.guilds.channels.create(guildId, {
      name: 'sora-request-song', type: ChannelType.GuildText,
      topic: 'Join a voice channel, then send a song title or supported URL for Sora.',
    });
    return { id: channel.id, created: true };
  }

  /** Rewrite the panel message once, recovering from a stale or deleted one. */
  private async write(guildId: string) {
    const binding = this.store.get(guildId);
    if (!binding) return;
    try {
      await this.client.messages.edit(binding.panelMessageId, binding.requestChannelId, this.body(guildId));
    } catch (error) {
      if (!this.stale(error)) { console.error('Panel update failed:', error); return; }
      await this.publish(guildId, binding.requestChannelId, binding.panelMessageId, binding.channelOwned);
    }
  }

  /**
   * Ask for the panel to be current. Deliberately NOT chained through `serial`: one write per guild is
   * already guaranteed by `draw`'s single-flight loop, and serialising here would make every caller
   * wait its turn and then draw its own stale payload — the exact lag this design removes.
   */
  refresh(guildId: string) {
    return this.draw(guildId);
  }

  /**
   * A panel from before Components V2, deleted by hand, or otherwise unusable cannot be patched in place.
   * Seyfert reports Discord's numeric code as a string (`API_Bad Request_50035`), so both shapes are accepted.
   */
  private stale(error: unknown) {
    const failure = error as { code?: number | string; detail?: string } | null;
    if (failure?.code === 10008) return true;
    const code = String(failure?.code ?? '');
    return code === '50035' || code.endsWith('_50035') || String(failure?.detail ?? '').includes('COMPONENTS_V2');
  }

  /** Post a fresh panel and point the guild at it, removing the message it replaces. */
  private async publish(guildId: string, channelId: string, staleId?: string, channelOwned = false) {
    const message = await this.client.messages.write(channelId, this.body(guildId));
    try { await this.store.set(guildId, { requestChannelId: channelId, panelMessageId: message.id, channelOwned }); }
    catch (error) { await this.client.messages.delete(message.id, channelId).catch(() => {}); throw error; }
    if (staleId && staleId !== message.id) await this.client.messages.delete(staleId, channelId).catch(() => {});
    return message.id;
  }

  async restore() {
    for (const [guildId] of this.store.entries()) {
      try { await this.refresh(guildId); }
      catch (error) { console.error('Panel restore failed:', guildId, error); }
    }
  }

  /** Delete a message, tolerating the two failure modes Discord reports for ordinary races. */
  private clear(messageId: string, channelId: string) {
    return this.client.messages.delete(messageId, channelId).catch(error => {
      const code = (error as { code?: number } | null)?.code;
      if (code === 10008) return;
      if (Date.now() - this.lastCleanupWarning < CLEANUP_WARNING_INTERVAL) return;
      this.lastCleanupWarning = Date.now();
      console.warn(code === 50013
        ? 'Request cleanup failed: bot needs Manage Messages in request channel.'
        : 'Request cleanup failed.', channelId, code ?? 'unknown');
    });
  }

  /** Feedback and control confirmations share one five-second lifetime. */
  expire(messageId: string, channelId: string) {
    setTimeout(() => { void this.clear(messageId, channelId); }, FEEDBACK_LIFETIME).unref();
  }

  /** Only expire inside the configured request channel, so Sora never deletes in someone else's channel. */
  expireResponse(guildId: string | undefined, channelId: string, messageId: string) {
    if (guildId && this.store.get(guildId)?.requestChannelId === channelId) this.expire(messageId, channelId);
  }

  /** Post short-lived feedback as its own message: the panel stays a pure player view. */
  notify(channelId: string, content: string) {
    return this.client.messages.write(channelId, { content: displayText(content, 300), allowed_mentions: { parse: [] } })
      .then(message => { this.expire(message.id, channelId); })
      .catch(error => console.warn('Request feedback failed.', channelId, (error as { code?: number })?.code ?? 'unknown'));
  }

  async request(message: GatewayMessageCreateDispatchData) {
    if (!message.guild_id) return;
    const binding = this.store.get(message.guild_id);
    if (message.author.bot || message.webhook_id || message.channel_id !== binding?.requestChannelId || message.id === binding.panelMessageId) return;
    // Erase the member's line at once: Discord forbids editing it, so Sora answers in its place.
    await this.clear(message.id, message.channel_id);
    if (!message.content.trim()) return; // Nothing to answer.
    const query = requestFromMessage({
      guildId: message.guild_id, channelId: message.channel_id, author: message.author,
      content: message.content, webhookId: message.webhook_id,
    }, binding.requestChannelId);
    try {
      if (!query) throw new Error('Song title or URL must be 1–500 characters.');
      const member = await this.client.members.fetch(message.guild_id, message.author.id);
      const tracks = await this.client.music.play({ guildId: message.guild_id, channelId: message.channel_id, author: message.author, member }, query);
      await Promise.all([
        this.refresh(message.guild_id),
        this.notify(message.channel_id, added(tracks[0]!.info.title, tracks.length - 1)),
      ]);
    } catch (error) {
      await this.notify(message.channel_id, failed(error instanceof Error ? error.message : 'Please try again.'));
    }
  }
}
