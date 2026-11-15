type RequestMessage = {
  guildId?: string; channelId: string; content: string;
  author: { id: string; bot?: boolean }; webhookId?: string;
};
export function requestFromMessage(message: RequestMessage, requestChannelId?: string) {
  if (!message.guildId || message.author.bot || message.webhookId || message.channelId !== requestChannelId) return;
  const query = message.content.trim();
  if (!query || query.length > 500) return;
  return query;
}
