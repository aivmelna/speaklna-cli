// 把 App 的回话变成给人 / 给模型看的一句话
export const STORE_HINT = 'Speaklna is not installed. Get it from the Mac App Store (search "Speaklna").';

const ERR = {
  empty: 'Nothing to read (empty text).',
  too_long: 'Text is too long (limit 20000 characters).',
  unknown_voice: 'Unknown voice. Run `speaklna voices` to see the available ones.',
  bad_request: 'The app rejected the request.',
};

export function describe(op, res) {
  switch (res.status) {
    case 'unsupported': return 'Speaklna only works on macOS; nothing was done.';
    case 'not_installed': return STORE_HINT;
    case 'no_reply': return 'Speaklna did not answer. AI support needs Speaklna 1.1 or later: update it from the Mac App Store, open it once, and try again.';
    case 'error': return ERR[res.error] ?? `Speaklna error: ${res.error}`;
  }
  const r = res.reply;
  switch (op) {
    case 'speak':
      if (r.result === 'muted') return 'Muted: the user is in a call, so nothing was spoken.';
      if (r.result === 'queued') return 'Queued; it will be read after the current one.';
      return 'Speaking.';
    case 'stop': return r.stopped ? `Stopped ${r.stopped} AI reading(s).` : 'Nothing from AI was playing.';
    case 'status':
      return [`state: ${r.state}`, `speaking: ${r.speaking ?? 'nobody'}`, `muted: ${r.muted ? 'yes' + (r.muteReason ? ` (${r.muteReason})` : '') : 'no'}`, `queued: ${r.queued ?? 0}`].join('\n');
    case 'voices':
      return (r.voices ?? []).map((v) => `${v.id === r.default ? '*' : ' '} ${v.name} (${v.id}, ${v.kind})`).join('\n') || 'No voices.';
  }
  return JSON.stringify(r);
}
