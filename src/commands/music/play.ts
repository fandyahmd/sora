import type { TrackStructure } from 'hoshimi';
import { Command, Declare, Options, createStringOption, type CommandContext } from 'seyfert';
import { displayText } from '../../ui/text.js';
import { added } from '../../feedback.js';

const options = {
  query: createStringOption({
    description: 'Song title or supported URL',
    required: true,
    min_length: 1, max_length: 500,
    async autocomplete(interaction) {
      const query = interaction.getInput().trim();
      if (!interaction.guildId || query.length < 2 || query.length > 500) return interaction.respond([]);
      try {
        const tracks = await interaction.client.music.search(query, interaction.user.id);
        await interaction.respond(tracks.slice(0, 10).map((track: TrackStructure) => ({
          name: `${track.info.title} — ${track.info.author}`.slice(0, 100),
          value: interaction.client.music.suggestions.put(interaction.guildId!, track),
        })));
      } catch (error) {
        console.error('Autocomplete error:', error);
        await interaction.respond([]);
      }
    },
  }),
};

@Declare({ name: 'play', description: 'Play a song or add tracks to the queue' })
@Options(options)
export default class PlayCommand extends Command {
  async run(ctx: CommandContext<typeof options>) {
    await ctx.deferReply(true);
    const tracks = await ctx.client.music.play(ctx, ctx.options.query.trim());
    if (ctx.guildId) await ctx.client.requestChannels.refresh(ctx.guildId);
    await ctx.editOrReply({ content: added(displayText(tracks[0]!.info.title), tracks.length - 1), allowed_mentions: { parse: [] } });
  }
}
