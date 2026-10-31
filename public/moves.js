/* Gauntlet movement reader
 * Turns whatever is written in the sheet into filmed moves.
 *
 * The sheet is written by hand, so the same move shows up many ways:
 * R/KNEE, KNEE R, RIGHT KNEE, REAR KNEE, R/UP-ELBOW, L/UP ELBOW, BODY CROSS,
 * L/BODY JAB, HIGH R/HIGH ROUNDKICK, LOW R/ROUNDKICK, SHOVEL RH, OVERHAND RC...
 * The server also splits anything it doesn't recognise into single words
 * (BODY / CROSS), so moves are re-assembled here from neighbouring words:
 * the longest run of words that reads as exactly one move wins.
 *
 * Clips are filmed orthodox and named by role (lead/rear). The combo's first
 * jab or cross sets the stance: RJ/LC = southpaw (right is lead, play mirrored),
 * LJ/RC = orthodox. Sides written L/R become lead/rear from that.
 */
(function () {
  // technique -> filmed clip per role
  const CLIPS = {
    'jab':               { lead: 'jab', rear: 'cross' },      // a straight is a jab from the lead hand, a cross from the rear
    'cross':             { lead: 'jab', rear: 'cross' },
    'hook':              { lead: 'hook' },
    'uppercut':          { lead: 'lead-uppercut',            rear: 'rear-uppercut' },
    'body jab':          { lead: 'body-jab', rear: 'body-cross' },
    'body cross':        { lead: 'body-jab', rear: 'body-cross' },
    'overhand':          { rear: 'overhand-cross' },
    'shovel':            { lead: 'lead-shovel-hook',         rear: 'rear-shovel-hook' },
    'slip':              { lead: 'lead-slip',                rear: 'rear-slip' },
    'roll':              { lead: 'lead-roll',                rear: 'rear-roll' },
    'block':             { lead: 'lead-block',               rear: 'rear-block' },
    'check':             { lead: 'lead-check',               rear: 'rear-check' },
    'pivot':             { lead: 'lead-pivot',               rear: 'rear-pivot' },
    'post':              { lead: 'lead-post',                rear: 'rear-post' },
    'frontkick':         { lead: 'lead-frontkick',           rear: 'rear-frontkick' },
    'sidekick':          { lead: 'lead-side-kick',           rear: 'rear-side-kick' },
    'oblique':           { lead: 'lead-oblique-kick',        rear: 'rear-oblique-kick' },
    'roundkick':         { lead: 'lead-roundkick',           rear: 'rear-roundkick' },
    'low roundkick':     { lead: 'low-lead-roundkick',       rear: 'low-rear-roundkick' },
    'switch kick':       { any: 'switch-kick' },        // switch moves: one clip, whichever side is written
    'low switch kick':   { any: 'low-switch-kick' },
    'knee':              { lead: 'lead-knee',                rear: 'rear-knee' },
    'switch knee':       { any: 'switch-knee' },
    'slash':             { lead: 'lead-slash-elbow',         rear: 'rear-slash-elbow' },
    'up elbow':          { lead: 'lead-up-elbow',            rear: 'rear-up-elbow' },
    'tomahawk':          { rear: 'rear-tomahawk' },
    'spinning elbow':    { lead: 'lead-spinning-back-elbow', rear: 'rear-spinning-back-elbow' },
    'spinning backfist': { lead: 'lead-spinning-back-fist',  rear: 'rear-spinning-back-fist' },
    'spinning side kick':{ any: 'spinning-side-kick' },
    'spinning hook kick':{ any: 'spinning-hook-kick' },
    'duck':              { any: 'duck' },
    'pull':              { any: 'pull' },
    'feint':             { any: 'feint' },
    'hip feint':         { any: 'hip-feint' },
    'neutral':           { any: 'neutral' },
  };
  // which role a move is when the sheet doesn't say a side
  const DEFAULT_ROLE = { jab: 'lead', cross: 'rear', hook: 'lead', uppercut: 'rear', 'body jab': 'lead',
    'body cross': 'rear', overhand: 'rear', shovel: 'lead', slip: 'lead', roll: 'lead', block: 'lead',
    check: 'lead', pivot: 'lead', post: 'lead', frontkick: 'lead', sidekick: 'lead', oblique: 'lead',
    roundkick: 'rear', 'low roundkick': 'rear', knee: 'rear', slash: 'rear', 'up elbow': 'rear',
    tomahawk: 'rear', 'spinning elbow': 'rear', 'spinning backfist': 'rear',
    'switch kick': 'lead', 'low switch kick': 'lead', 'switch knee': 'lead' };
  // moves named by direction rather than by limb: the side flips relative to the limb rule
  const BY_DIRECTION = { slip: true };

  // phrases -> technique, longest first. Spaces already normalised.
  const NAMES = [
    ['SPINNING BACK ELBOW', 'spinning elbow'], ['SPINNING ELBOW', 'spinning elbow'], ['SPIN ELBOW', 'spinning elbow'], ['BACK ELBOW', 'spinning elbow'],
    ['SPINNING BACK FIST', 'spinning backfist'], ['SPINNING BACKFIST', 'spinning backfist'], ['SPIN BACKFIST', 'spinning backfist'], ['BACK FIST', 'spinning backfist'], ['BACKFIST', 'spinning backfist'],
    ['SPINNING SIDE KICK', 'spinning side kick'], ['SPINNING SIDEKICK', 'spinning side kick'], ['SPIN SIDE KICK', 'spinning side kick'],
    ['SPINNING HOOK KICK', 'spinning hook kick'], ['SPIN HOOK KICK', 'spinning hook kick'], ['HOOK KICK', 'spinning hook kick'],
    ['SWITCH ROUNDKICK', 'switch kick'], ['SWITCH ROUND KICK', 'switch kick'], ['SWITCH KICK', 'switch kick'],
    ['SWITCH KNEE', 'switch knee'], ['SWITCH KNEES', 'switch knee'],
    ['SHOVEL HOOK', 'shovel'], ['SHOVEL', 'shovel'],
    ['OVERHAND CROSS', 'overhand'], ['OVERHAND RIGHT', 'overhand'], ['OVERHAND LEFT', 'overhand'], ['OVERHAND', 'overhand'],
    ['UP ELBOW', 'up elbow'], ['UPELBOW', 'up elbow'], ['UPWARD ELBOW', 'up elbow'], ['UPPER ELBOW', 'up elbow'],
    ['SLASH ELBOW', 'slash'], ['SLASHING ELBOW', 'slash'], ['SLASH', 'slash'], ['ELBOW', 'slash'],
    ['TOMAHAWK ELBOW', 'tomahawk'], ['TOMAHAWK', 'tomahawk'],
    ['ROUND KICK', 'roundkick'], ['ROUNDKICK', 'roundkick'], ['ROUNDHOUSE', 'roundkick'], ['ROUNDHOUSE KICK', 'roundkick'], ['KICK', 'roundkick'],
    ['FRONT KICK', 'frontkick'], ['FRONTKICK', 'frontkick'], ['TEEP', 'frontkick'], ['PUSH KICK', 'frontkick'],
    ['SIDE KICK', 'sidekick'], ['SIDEKICK', 'sidekick'],
    ['OBLIQUE KICK', 'oblique'], ['OBLIQUE', 'oblique'],
    ['HIP FEINT', 'hip feint'], ['FEINT', 'feint'],
    ['UPPERCUT', 'uppercut'], ['UPPER CUT', 'uppercut'], ['UPPER', 'uppercut'],
    ['KNEES', 'knee'], ['KNEE', 'knee'],
    ['JAB', 'jab'], ['CROSS', 'cross'], ['STRAIGHT', 'cross'], ['HOOK', 'hook'],
    ['SLIP', 'slip'], ['ROLL', 'roll'], ['BLOCK', 'block'], ['PARRY', 'block'], ['CHECK', 'check'],
    ['PIVOT', 'pivot'], ['POST', 'post'], ['DUCK', 'duck'], ['PULL', 'pull'],
    ['NEUTRAL', 'neutral'], ['GUARD', 'neutral'], ['STANCE', 'neutral'],
  ].sort((a, b) => b[0].length - a[0].length);
  const PUNCH = { J: 'jab', C: 'cross', H: 'hook', U: 'uppercut' };
  const PREFIX = new Set(['BODY', 'LOW', 'HIGH', 'STEP', 'LEAD', 'REAR', 'SPINNING', 'SPIN', 'SWITCH', 'OVERHAND', 'SHOVEL']);
  const NOISE = new Set(['HIGH', 'STEP', 'DOUBLE', 'TRIPLE', 'QUICK', 'FAST', 'HARD', 'THE', 'A', 'AND', 'TO', 'X1', 'X2', 'X3', '2X', '3X']);

  function norm(s) {
    return String(s || '').toUpperCase()
      .replace(/[‐-―_]+/g, ' ').replace(/-/g, ' ')        // UP-ELBOW -> UP ELBOW
      .replace(/\s*\/\s*/g, '/')                         // R / KNEE -> R/KNEE
      .replace(/[^A-Z0-9/ ]+/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }

  /** One phrase -> one move, or null if it isn't exactly one move. */
  function parse(raw) {
    let t = ' ' + norm(raw) + ' ';
    if (!t.trim()) return null;
    let side = null, role = null, low = false, body = false;
    const setSide = s => { if (side && side !== s) throw 0; side = s; };
    try {
      // L/… R/… on any word: HIGH R/HIGH ROUNDKICK, L/BODY JAB
      t = t.replace(/ ([LR])\//g, (_, s) => { setSide(s); return ' '; });
      // punch codes: LJ RC LH RU (also inside SHOVEL RH, OVERHAND RC, BODY LJ)
      let techFromCode = null;
      t = t.replace(/ ([LR])([JCHU]) /g, (_, s, p) => { if (techFromCode) throw 0; setSide(s); techFromCode = PUNCH[p]; return ' '; });
      t = t.replace(/ (LEFT|RIGHT) /g, (_, w) => { setSide(w[0]); return ' '; });
      t = t.replace(/ (LEAD|FRONT(?= HAND| LEG)|REAR|BACK(?= HAND| LEG)) /g, (_, w) => { role = /LEAD|FRONT/.test(w) ? 'lead' : 'rear'; return ' '; });
      t = t.replace(/ (HAND|LEG|ARM|SIDE(?! KICK)) /g, ' ');
      t = t.replace(/ LOW /g, () => { low = true; return ' '; });
      t = t.replace(/ BODY /g, () => { body = true; return ' '; });
      // trailing single-letter side: BLOCK L, CHECK R, KNEE R
      t = t.replace(/ ([LR]) /g, (_, s) => { setSide(s); return ' '; });
      // what's left must name exactly one technique (plus harmless words)
      let rest = t.replace(/\s+/g, ' ').trim(), tech = techFromCode;
      for (const [name, k] of NAMES) {
        const re = new RegExp('(^| )' + name + '( |$)');
        if (re.test(rest)) {
          // a punch code plus a name is one move only when the name refines it: OVERHAND RC, SHOVEL RH.
          // LC + CROSS, RJ + KNEE etc. are two moves.
          if (tech && !((tech === 'cross' && k === 'overhand') || (tech === 'hook' && k === 'shovel'))) return null;
          tech = k; rest = rest.replace(re, ' ').trim();
          break;
        }
      }
      if (!tech) return null;
      if (rest.split(' ').some(w => w && !NOISE.has(w))) return null;   // another move hiding in here
      if (body && (tech === 'jab' || tech === 'cross')) tech = 'body ' + tech;
      if (low && (tech === 'roundkick' || tech === 'switch kick')) tech = 'low ' + tech;
      return { tech, side, role };
    } catch (e) { return null; }
  }

  /** first jab or cross with a side sets the stance */
  function stanceOf(moves) {
    for (const m of moves) {
      if (!m || !m.side) continue;
      if (/jab$/.test(m.tech)) return m.side === 'R' ? 'southpaw' : 'orthodox';
      if (/cross$|overhand/.test(m.tech)) return m.side === 'L' ? 'southpaw' : 'orthodox';
    }
    return 'orthodox';
  }

  function clipFor(m, stance) {
    if (!m) return null;
    const mirror = stance === 'southpaw', c = CLIPS[m.tech]; if (!c) return null;
    if (c.any) return { slug: c.any, mirror, role: null };
    let role = m.role;
    if (!role && m.side) {
      const lead = mirror ? 'R' : 'L';
      role = m.side === lead ? 'lead' : 'rear';
      if (BY_DIRECTION[m.tech]) role = role === 'lead' ? 'rear' : 'lead';
    }
    role = role || DEFAULT_ROLE[m.tech] || 'lead';
    const slug = c[role];
    return slug ? { slug, mirror, role } : null;
  }

  /**
   * Group a line's words into moves. Longest run (up to 4 words) that reads as
   * exactly one move wins; a word that can't be read stays on its own.
   * Returns [{ from, to, text, move }] with word indexes inclusive.
   */
  function group(words) {
    const out = [];
    for (let i = 0; i < words.length;) {
      let hit = null;
      for (let len = Math.min(4, words.length - i); len >= 1; len--) {
        const text = words.slice(i, i + len).join(' ');
        // BODY / LOW / HIGH / LEAD / REAR describe the move after them, never the one before
        if (len > 1 && PREFIX.has(norm(words[i + len - 1]))) continue;
        const m = parse(text);
        if (m) { hit = { from: i, to: i + len - 1, text, move: m }; break; }
      }
      out.push(hit || { from: i, to: i, text: words[i], move: null });
      i = (hit ? hit.to : i) + 1;
    }
    return out;
  }

  /** lines of words -> groups with clips, indexes into the flattened word list */
  function readCombo(lines) {
    const groups = []; let base = 0;
    for (const words of lines) {
      for (const g of group(words)) groups.push({ ...g, from: g.from + base, to: g.to + base });
      base += words.length;
    }
    const stance = stanceOf(groups.map(g => g.move));
    groups.forEach(g => { g.clip = clipFor(g.move, stance); });
    return { stance, groups };
  }

  // kept for older callers: one token on its own
  function resolve(tok, stance) { return clipFor(parse(tok), stance); }

  window.GauntletMoves = { readCombo, parse, resolve, stanceOf: words => stanceOf(words.map(parse)) };
  if (typeof module !== 'undefined') module.exports = window.GauntletMoves;
})();
