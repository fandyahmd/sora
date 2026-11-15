import { Command, Declare, type CommandContext } from 'seyfert';
import { autoplayCopy } from '../../feedback.js';

/** Autoplay keeps the queue alive by queuing related tracks whenever it runs dry. */
@Declare({ name: 'autoplay', description: 'Toggle autoplay: keep music playing when the queue ends' })
export default class AutoplayCommand extends Command {
  async run(ctx: CommandContext) {
    if (!ctx.guildId) throw new Error('Use this command in a server.');
    await ctx.deferReply(true);
    const enabled = await ctx.client.music.toggleAutoplay(ctx.guildId);
    if (ctx.client.requestChannels.store.get(ctx.guildId)) await ctx.client.requestChannels.refresh(ctx.guildId);
    await ctx.editOrReply({ content: autoplayCopy(enabled), allowed_mentions: { parse: [] } });
  }
}
