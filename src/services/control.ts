import { displayText } from '../ui/text.js';
import { editedCopy, PUBLIC_ACTIONS, type ControlAction } from '../feedback.js';

export type { ControlAction };

/** Minimal context surface a control needs; slash commands and buttons both satisfy it. */
export type ControlContext = {
  guildId?: string;
  channelId: string;
  deferReply: (ephemeral?: boolean) => Promise<unknown>;
  editOrReply: (body: unknown) => Promise<unknown>;
  fetchResponse: () => Promise<{ id: string } | undefined>;
  client: {
    music: { control: (ctx: never, action: never) => Promise<unknown> };
    requestChannels: {
      refresh: (guildId: string) => Promise<unknown>;
      expireResponse: (guildId: string | undefined, channelId: string, messageId: string) => void;
    };
  };
};

/**
 * One code path for pause, resume, previous, next, skip and stop, shared by slash commands and
 * panel buttons: acknowledge the interaction first (three-second budget), act, then answer once.
 * Stop confirms publicly and self-destructs in the request channel; everything else stays private.
 */
export async function runControl(ctx: ControlContext, action: ControlAction, options: { refreshPanel?: boolean } = {}) {
  await ctx.deferReply(!PUBLIC_ACTIONS.has(action));
  try {
    await ctx.client.music.control(ctx as never, action as never);
    if (options.refreshPanel !== false && ctx.guildId) await ctx.client.requestChannels.refresh(ctx.guildId);
    await ctx.editOrReply({ content: editedCopy(action), allowed_mentions: { parse: [] } });
    if (PUBLIC_ACTIONS.has(action)) {
      const message = await ctx.fetchResponse().catch(() => undefined);
      if (message) ctx.client.requestChannels.expireResponse(ctx.guildId, ctx.channelId, message.id);
    }
  } catch (error) {
    await ctx.editOrReply({
      content: displayText(error instanceof Error ? error.message : 'Unable to update playback. Please try again.', 300),
      allowed_mentions: { parse: [] },
    });
  }
}
