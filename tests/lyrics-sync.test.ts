import assert from 'node:assert/strict';
import { test } from 'bun:test';

// The command uses real Seyfert option decorators; only the Discord interaction is stubbed.
test('lyrics-sync validates voice access and sets a bounded absolute offset for this track', async () => {
  const { default: SyncCommand } = await import('../src/commands/music/lyrics-sync.js');
  const command = new SyncCommand();
  const calls: string[] = [];
  const replies: string[] = [];
  const player = { guildId: 'g' };
  const context = {
    guildId: 'g', options: { seconds: 2.5 },
    deferReply: async (privateReply: boolean) => { assert.equal(privateReply, true); },
    editOrReply: async (body: { content: string }) => { replies.push(body.content); },
    client: {
      music: { voice: async () => { calls.push('voice'); }, manager: { players: new Map([['g', player]]) } },
      requestChannels: {
        lyrics: { setOffset: (target: unknown, seconds: number) => { assert.equal(target, player); calls.push(`offset:${seconds}`); return seconds; } },
        refresh: async () => { calls.push('refresh'); },
      },
    },
  };
  await command.run(context as never);
  assert.deepEqual(calls, ['voice', 'offset:2.5', 'refresh']);
  assert.match(replies[0]!, /later.*2\.5s/i);
  calls.length = 0;
  context.client.music.voice = async () => { throw new Error('Join the same voice channel as Sora.'); };
  await assert.rejects(() => command.run(context as never), /same voice/);
  assert.deepEqual(calls, [], 'no sync mutation before voice authorization');
});

test('lyrics-sync publishes a decimal seconds option bounded to -120 through 120', async () => {
  const { default: SyncCommand } = await import('../src/commands/music/lyrics-sync.js');
  const definition = new SyncCommand().toJSON();
  assert.equal(definition.name, 'lyrics-sync');
  assert.deepEqual(definition.options?.map(option => ({
    name: option.name, type: option.type, required: 'required' in option ? option.required : undefined,
    min: 'min_value' in option ? option.min_value : undefined, max: 'max_value' in option ? option.max_value : undefined,
  })), [{ name: 'seconds', type: 10, required: true, min: -120, max: 120 }]);
});
