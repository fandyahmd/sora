import { createEvent } from 'seyfert';

export default createEvent({
  data: { name: 'botReady', once: true },
  async run(user, client) {
    client.music.manager.init({ id: user.id, username: user.username });
    await client.requestChannels.restore();
    console.log(`Discord ready: ${user.username} (${user.id})`);
  },
});
