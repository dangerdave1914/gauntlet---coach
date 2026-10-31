/* Gauntlet movement resolver
 * Notation is written by side (L/R = left/right). The clips are filmed
 * orthodox and named by role (lead/rear). So a code only becomes a clip once
 * we know the combo's stance:
 *   orthodox  -> left is lead,  play as filmed
 *   southpaw  -> right is lead, play mirrored
 * Stance comes from the combo itself: the first jab or cross decides it
 * (RJ / LC = southpaw, LJ / RC = orthodox). No jab or cross = orthodox.
 */
(function () {
  // technique -> clip for each role; null = not filmed for that role
  const T = {
    'jab':               { lead: 'jab' },
    'cross':             { rear: 'cross' },
    'hook':              { lead: 'hook' },
    'uppercut':          { lead: 'lead-uppercut',           rear: 'rear-uppercut' },
    'body jab':          { lead: 'body-jab' },
    'body cross':        { rear: 'body-cross' },
    'overhand':          { rear: 'overhand-cross' },
    'shovel':            { lead: 'lead-shovel-hook',        rear: 'rear-shovel-hook' },
    'slip':              { lead: 'lead-slip',               rear: 'rear-slip' },
    'roll':              { lead: 'lead-roll',               rear: 'rear-roll' },
    'block':             { lead: 'lead-block',              rear: 'rear-block' },
    'check':             { lead: 'lead-check',              rear: 'rear-check' },
    'pivot':             { lead: 'lead-pivot',              rear: 'rear-pivot' },
    'post':              { lead: 'lead-post',               rear: 'rear-post' },
    'frontkick':         { lead: 'lead-frontkick',          rear: 'rear-frontkick' },
    'sidekick':          { lead: 'lead-side-kick',          rear: 'rear-side-kick' },
    'oblique':           { lead: 'lead-oblique-kick',       rear: 'rear-oblique-kick' },
    'roundkick':         { lead: 'lead-roundkick',          rear: 'rear-roundkick' },
    'low roundkick':     { lead: 'low-lead-roundkick',      rear: 'low-rear-roundkick' },
    'switch kick':       { lead: 'switch-kick' },
    'low switch kick':   { lead: 'low-switch-kick' },
    'knee':              { lead: 'lead-knee',               rear: 'rear-knee' },
    'switch knee':       { lead: 'switch-knee' },
    'slash':             { lead: 'lead-slash-elbow',        rear: 'rear-slash-elbow' },
    'up elbow':          { lead: 'lead-up-elbow',           rear: 'rear-up-elbow' },
    'tomahawk':          { rear: 'rear-tomahawk' },
    'spinning elbow':    { lead: 'lead-spinning-back-elbow', rear: 'rear-spinning-back-elbow' },
    'spinning backfist': { lead: 'lead-spinning-back-fist',  rear: 'rear-spinning-back-fist' },
  };
  const NOSIDE = { 'DUCK': 'duck', 'PULL': 'pull', 'FEINT': 'feint', 'HIP FEINT': 'hip-feint',
    'SPINNING SIDE KICK': 'spinning-side-kick', 'SPINNING HOOK KICK': 'spinning-hook-kick',
    'NEUTRAL': 'neutral', 'GUARD': 'neutral' };
  const PUNCH = { J: 'jab', C: 'cross', H: 'hook', U: 'uppercut' };

  /** token -> { tech, side } with side 'L' | 'R' | null */
  function parse(tok) {
    let t = String(tok).toUpperCase().replace(/\s+/g, ' ').trim();
    if (NOSIDE[t]) return { clip: NOSIDE[t] };
    let low = false;
    if (t.startsWith('LOW ')) { low = true; t = t.slice(4); }
    let m;
    if ((m = t.match(/^([LR])([JCHU])$/))) return { tech: PUNCH[m[2]], side: m[1] };
    if ((m = t.match(/^OVERHAND ([LR])C$/))) return { tech: 'overhand', side: m[1] };
    if ((m = t.match(/^SHOVEL ([LR])H$/))) return { tech: 'shovel', side: m[1] };
    if ((m = t.match(/^(BLOCK|CHECK) ([LR])$/))) return { tech: m[1].toLowerCase(), side: m[2] };
    if ((m = t.match(/^ROLL (LEFT|RIGHT)$/))) return { tech: 'roll', side: m[1][0] };
    if ((m = t.match(/^([LR])\/(.+)$/))) {
      const side = m[1];
      let body = m[2].replace(/ ELBOW$/, (s) => m[2].startsWith('UP') ? s : '');
      const map = {
        'BODY JAB': 'body jab', 'BODY CROSS': 'body cross', 'SLIP': 'slip', 'BLOCK': 'block',
        'CHECK': 'check', 'PIVOT': 'pivot', 'POST': 'post', 'FRONTKICK': 'frontkick',
        'SIDEKICK': 'sidekick', 'SIDE KICK': 'sidekick', 'OBLIQUE': 'oblique', 'OBLIQUE KICK': 'oblique',
        'ROUNDKICK': 'roundkick', 'SWITCH KICK': 'switch kick', 'KNEE': 'knee',
        'SWITCH KNEE': 'switch knee', 'SLASH': 'slash', 'UP ELBOW': 'up elbow', 'TOMAHAWK': 'tomahawk',
        'SPINNING ELBOW': 'spinning elbow', 'SPINNING BACK ELBOW': 'spinning elbow',
        'SPINNING BACKFIST': 'spinning backfist', 'SPINNING BACK FIST': 'spinning backfist',
      };
      let tech = map[body];
      if (tech && low) tech = tech === 'roundkick' ? 'low roundkick' : tech === 'switch kick' ? 'low switch kick' : tech;
      if (tech) return { tech, side };
    }
    return {};
  }

  /** first jab or cross decides; default orthodox */
  function stanceOf(tokens) {
    for (const tok of tokens) {
      const t = String(tok).toUpperCase().trim();
      if (t === 'RJ' || t === 'LC') return 'southpaw';
      if (t === 'LJ' || t === 'RC') return 'orthodox';
    }
    return 'orthodox';
  }

  /** token + stance -> { slug, mirror, role } or null when there's no clip for it */
  function resolve(tok, stance) {
    const p = parse(tok);
    const mirror = stance === 'southpaw';
    if (p.clip) return { slug: p.clip, mirror, role: null };
    if (!p.tech) return null;
    const leadSide = mirror ? 'R' : 'L';
    const role = p.side === leadSide ? 'lead' : 'rear';
    const slug = (T[p.tech] || {})[role];
    return slug ? { slug, mirror, role } : null;
  }

  window.GauntletMoves = { resolve, stanceOf, parse };
  if (typeof module !== 'undefined') module.exports = window.GauntletMoves;
})();
