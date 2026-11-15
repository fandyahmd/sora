import { ComponentCommand, type ComponentContext } from 'seyfert';
import { queueCard } from '../ui/cards.js';
import { runControl } from '../services/control.js';
import { autoplayCopy } from '../feedback.js';

/**
 * Static handler for the panel buttons. Stateless (no in-memory collector), so it keeps
 * working after a restart; every action re-validates the bound panel before touching playback.
 */
export default class MusicControls extends ComponentCommand {
  componentType = 'Button' as const;
  customId = /^music:(pause|resume|previous|next|stop|queue|autoplay)$/;

  async run(ctx: ComponentContext<'Button'>) {
    const action = ctx.customId.slice(6) as 'pause' | 'resume' | 'previous' | 'next' | 'stop' | 'queue' | 'autoplay';
    const binding = ctx.guildId && ctx.client.requestChannels.store.get(ctx.guildId);
    if (!binding || binding.requestChannelId !== ctx.channelId || binding.panelMessageId !== ctx.interaction.message.id) {
      await ctx.deferReply(true);
      await ctx.editOrReply({ content: 'This panel is inactive. Use /setup-channel to restore it.', allowed_mentions: { parse: [] } });
      return;
    }
    if (action === 'queue') {
      await ctx.deferReply(true);
      await ctx.editOrReply(queueCard(ctx.client.music.manager.players.get(ctx.guildId!)));
      return;
    }
    if (action === 'autoplay') {
      await ctx.deferReply(true);
      const enabled = await ctx.client.music.toggleAutoplay(ctx.guildId!);
      await ctx.client.requestChannels.refresh(ctx.guildId!);
      await ctx.editOrReply({ content: autoplayCopy(enabled), allowed_mentions: { parse: [] } });
      return;
    }
    await runControl(ctx as never, action);
  }
}
