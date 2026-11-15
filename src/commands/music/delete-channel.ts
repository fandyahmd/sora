import { Command, Declare, type CommandContext } from 'seyfert';

/**
 * Removes Sora's panel and its saved setup for this server. When Sora created the request channel
 * itself it is deleted too, since it exists only for the panel; a channel a member picked stays.
 */
@Declare({ name: 'delete-channel', description: 'Remove Sora’s music panel and setup from this server', defaultMemberPermissions: ['ManageChannels'] })
export default class DeleteChannelCommand extends Command {
  async onPermissionsFail(ctx: CommandContext) { await ctx.write({ content: 'You need Manage Channels permission.', flags: 64, allowed_mentions: { parse: [] } }); }
  async run(ctx: CommandContext) {
    await ctx.deferReply(true);
    if (!ctx.guildId || !ctx.member) throw new Error('Use this command in a server.');
    if (!(await ctx.member.fetchPermissions()).has(['ManageChannels'])) throw new Error('You need Manage Channels permission.');
    const { channelId, channelDeleted } = await ctx.client.requestChannels.teardown(ctx.guildId);
    // Built by hand: displayText() strips the angle brackets a channel mention needs.
    const where = channelDeleted ? '' : ` from <#${channelId}>`;
    await ctx.editOrReply({
      content: `Sora’s music panel and setup have been removed${where}. Run /setup-channel to start again.`,
      allowed_mentions: { parse: [] },
    });
  }
}
