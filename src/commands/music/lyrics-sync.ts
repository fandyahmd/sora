import { Command, Declare, Options, createNumberOption, type CommandContext } from 'seyfert';
import { lyricsSyncCopy } from '../../feedback.js';

const options = {
  seconds: createNumberOption({
    description: 'Video intro length in seconds (negative to advance lyrics)',
    required: true,
    min_value: -120, max_value: 120,
  }),
};

/** Last-resort fix for recordings whose intro differs from the synced lyrics. Applies to this playback only. */
@Declare({ name: 'lyrics-sync', description: 'Shift lyrics to match the current song (video intro offset)' })
@Options(options)
export default class LyricsSyncCommand extends Command {
  async run(ctx: CommandContext<typeof options>) {
    await ctx.deferReply(true);
    if (!ctx.guildId) throw new Error('Use this command in a server.');
    // Same-guild voice authorization runs before changing the playback's lyric clock.
    await ctx.client.music.voice(ctx);
    const player = ctx.client.music.manager.players.get(ctx.guildId);
    if (!player) throw new Error('Nothing is playing yet. Use /play to start.');
    const applied = await ctx.client.requestChannels.lyrics.setOffset(player, ctx.options.seconds);
    await ctx.client.requestChannels.refresh(ctx.guildId);
    await ctx.editOrReply({ content: lyricsSyncCopy(applied), allowed_mentions: { parse: [] } });
  }
}
