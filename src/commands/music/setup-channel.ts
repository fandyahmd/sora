import { ChannelType, Command, Declare, Options, createChannelOption, type CommandContext } from 'seyfert';
const options = {
  channel: createChannelOption({ description: 'Existing text channel for music requests (optional)', required: false, channel_types: [ChannelType.GuildText] }),
};
@Declare({ name: 'setup-channel', description: 'Set up Sora’s persistent music request panel', defaultMemberPermissions: ['ManageChannels'] })
@Options(options)
export default class SetupChannelCommand extends Command {
  async onPermissionsFail(ctx: CommandContext) { await ctx.write({ content: 'You need Manage Channels permission.', flags: 64, allowed_mentions: { parse: [] } }); }
  async run(ctx: CommandContext<typeof options>) {
    await ctx.deferReply(true);
    if (!ctx.guildId || !ctx.member) throw new Error('Use this command in a server.');
    if (!(await ctx.member.fetchPermissions()).has(['ManageChannels'])) throw new Error('You need Manage Channels permission.');
    const channelId = await ctx.client.requestChannels.setup(ctx.guildId, ctx.options.channel?.id);
    await ctx.editOrReply({ content: `Sora music requests are ready in <#${channelId}>.`, allowed_mentions: { parse: [] } });
  }
}
