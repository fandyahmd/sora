import { Command, Declare, type CommandContext } from 'seyfert';
import { queueCard } from '../../ui/cards.js';

@Declare({ name: 'queue', description: 'View the current track and upcoming queue' })
export default class QueueCommand extends Command {
  async run(ctx: CommandContext) {
    await ctx.deferReply(true);
    if (!ctx.guildId) throw new Error('Use this command in a server.');
    await ctx.editOrReply(queueCard(ctx.client.music.manager.players.get(ctx.guildId)));
  }
}
