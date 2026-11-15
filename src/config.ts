function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

export function readConfig() {
  const port = Number(required('LAVALINK_PORT'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid LAVALINK_PORT');
  const secure = required('LAVALINK_SECURE');
  if (!['true', 'false'].includes(secure)) throw new Error('LAVALINK_SECURE must be true or false');
  return {
    token: required('DISCORD_TOKEN'),
    node: {
      id: 'public',
      host: required('LAVALINK_HOST'),
      port,
      secure: secure === 'true',
      password: required('LAVALINK_PASSWORD'),
    },
  };
}
