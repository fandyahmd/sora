import { ActionRow, Button, ButtonStyle, Container, MediaGallery, MediaGalleryItem, MessageFlags, Section, Separator, Spacing, TextDisplay, Thumbnail } from 'seyfert';
import { BANNER, BRAND, COLORS, EMOJI, inviteURL, supportURL } from './theme.js';
import { clip, displayText, duration, httpURL, lyricText } from './text.js';
import type { LyricsSlice } from '../services/lyrics.js';

export type Track = {
  info: { title: string; author?: string; uri?: string; artworkUrl?: string | null; length?: number; isStream?: boolean };
  requester?: unknown;
};
export type Playback = {
  title: string; uri?: string; artworkUrl?: string | null; author?: string; length?: number; isStream?: boolean;
  requesterId?: string; paused: boolean; hasPrevious: boolean; hasNext: boolean; autoplay?: boolean;
};
export type Player = { queue: { current?: Track | null; tracks: readonly Track[] }; destroyed?: boolean };

/** Components V2 flag: cards replace the legacy embed/content layout. */
export const CARD_FLAGS = MessageFlags.IsComponentsV2;

function mention(userId?: string) {
  return userId && /^\d{17,20}$/.test(userId) ? `<@${userId}>` : 'Unknown';
}
/** Linked title; only validated http(s) URLs become links, everything else stays plain escaped text. */
function titleLink(title: string, uri?: string) {
  const url = httpURL(uri);
  const text = displayText(title, 200);
  return url ? `[${text}](${url})` : text;
}
function trackLine(track: Track) {
  return `${titleLink(track.info.title, track.info.uri)} · ${duration(track.info.length, track.info.isStream)}`;
}

/** Button labels and disabled states for the current player state. */
export function panelState(playback?: Playback) {
  return {
    label: playback ? `${displayText(playback.title)} — ${playback.paused ? 'Paused' : 'Now playing'}` : 'Ready to play',
    buttons: [
      { id: 'previous', label: `${EMOJI.previous} Previous`, disabled: !playback?.hasPrevious },
      { id: playback?.paused ? 'resume' : 'pause', label: playback?.paused ? `${EMOJI.playing} Resume` : `${EMOJI.paused} Pause`, disabled: !playback },
      { id: 'next', label: `${EMOJI.next} Next`, disabled: !playback?.hasNext },
      { id: 'stop', label: `${EMOJI.stop} Stop`, disabled: !playback },
      { id: 'queue', label: `${EMOJI.queue} Queue`, disabled: false },
      { id: 'autoplay', label: `${EMOJI.autoplay} Autoplay${playback?.autoplay ? ' on' : ''}`, disabled: !playback },
    ],
  };
}

/**
 * Three lines around the one being sung, only the current one emphasised. Every line is untrusted
 * text from the node, so it is sanitised before it is wrapped in the markdown *we* control.
 */
export function lyricsBlock(slice?: LyricsSlice) {
  const lines = (slice?.lines ?? []).slice(0, 200).map(line => line.trim() ? lyricText(line) : ' ');
  if (!lines.length) return [];
  const focus = slice!.index;
  const start = Math.max(0, Math.min(focus < 0 ? 0 : focus - 1, lines.length - 3));
  const text = [
    `-# ${EMOJI.lyrics} Lyrics`,
    ...lines.slice(start, start + 3).map((line, offset) => (start + offset === focus ? `**${line}**` : `-# ${line}`)),
  ].join('\n');
  // Trailing divider only: the card already separates the heading above, and the meta line follows.
  return [new TextDisplay().setContent(clip(text, 900)), new Separator().setDivider(true).setSpacing(Spacing.Small)];
}

/** Discord caps an ActionRow at 5 buttons, so controls are split into a transport row and a utility row. */
export function controlRows(playback?: Playback) {
  const buttons = panelState(playback).buttons.map(button => new Button()
    .setCustomId(`music:${button.id}`).setLabel(button.label).setDisabled(button.disabled)
    .setStyle(button.id === 'stop' ? ButtonStyle.Danger
      : button.id === 'autoplay' && playback?.autoplay ? ButtonStyle.Success
      : ['pause', 'resume'].includes(button.id) ? ButtonStyle.Primary : ButtonStyle.Secondary));
  return [
    new ActionRow<Button>().addComponents(...buttons.slice(0, 4)),
    new ActionRow<Button>().addComponents(...buttons.slice(4)),
  ];
}

/**
 * Idle card: banner, one line of copy, and whichever links this deployment actually has.
 * A self-hosted copy without a support server simply shows no Support link.
 */
export function idleCard(botId?: string) {
  const links = [
    supportURL() ? `[Support](${supportURL()})` : '',
    inviteURL(botId) ? `[Invite](${inviteURL(botId)})` : '',
  ].filter(Boolean).join(' | ');
  const card = new Container().setColor(COLORS.idle).addComponents(
    new MediaGallery().addItems(new MediaGalleryItem().setMedia(`attachment://${BANNER}`)),
    new TextDisplay().setContent(`There are no songs playing right now${links ? `\n${links}` : ''}`),
  );
  return { components: [card], flags: CARD_FLAGS };
}

export function playerCard(playback: Playback, slice?: LyricsSlice) {
  // Playing needs no announcement — the panel itself is the announcement. Only a pause does.
  const status = playback.paused ? `${EMOJI.paused} Paused` : '';
  const artist = playback.author && !playback.title.toLowerCase().includes(playback.author.toLowerCase()) ? displayText(playback.author, 80) : '';
  const subtitle = [status, artist].filter(Boolean).join(' · ');
  const heading = `## ${titleLink(playback.title, playback.uri)}${subtitle ? `\n### ${subtitle}` : ''}`;
  const text = new TextDisplay().setContent(heading);
  const artwork = httpURL(playback.artworkUrl);
  const card = new Container().setColor(playback.paused ? COLORS.paused : COLORS.playing).addComponents(
    artwork
      ? new Section().setAccessory(new Thumbnail().setMedia(artwork).setDescription(displayText(playback.title, 100))).addComponents(text)
      : text,
    new Separator().setDivider(true).setSpacing(Spacing.Small),
    ...lyricsBlock(slice),
    new TextDisplay().setContent(`-# ${duration(playback.length, playback.isStream)} · Requested by ${mention(playback.requesterId)}`),
    ...controlRows(playback),
  );
  // Clearing attachments drops the idle banner uploaded by the previous payload.
  return { components: [card], flags: CARD_FLAGS, attachments: [] as never[] };
}

/** Read-only queue snapshot, bounded so a huge queue cannot exceed the text display limit. */
export function queueCard(player?: Player) {
  const current = !player?.destroyed ? player?.queue.current : undefined;
  const tracks = (!player?.destroyed ? player?.queue.tracks : undefined) ?? [];
  const lines = tracks.slice(0, 10).map((track, index) => `${index + 1}. ${trackLine(track)}`);
  const text = [
    `## ${BRAND} Queue`,
    current ? `**${EMOJI.playing} Now playing**\n${trackLine(current)}` : '-# Nothing playing right now.',
    '',
    `**Up next** · ${tracks.length} queued`,
    lines.join('\n') || '-# Queue is empty.',
    ...(tracks.length > 10 ? [`-# Showing first 10 of ${tracks.length} queued`] : []),
  ].join('\n');
  return { components: [new Container().setColor(COLORS.playing).addComponents(new TextDisplay().setContent(clip(text, 3900)))], flags: CARD_FLAGS };
}
