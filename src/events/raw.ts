import { createEvent } from 'seyfert';

export default createEvent({
  data: { name: 'raw' },
  async run(packet, client) {
    if (packet.t === 'MESSAGE_CREATE') await client.requestChannels.request(packet.d).catch((error: unknown) => console.error('Request error:', error));
    if (packet.t === 'VOICE_STATE_UPDATE' || packet.t === 'VOICE_SERVER_UPDATE' || packet.t === 'CHANNEL_DELETE') {
      await client.music.manager.updateVoiceState({ t: packet.t, d: packet.d } as Parameters<typeof client.music.manager.updateVoiceState>[0]);
    }
  },
});
