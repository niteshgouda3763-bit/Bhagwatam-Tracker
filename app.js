(function () {
  const $ = (id) => document.getElementById(id);
  const views = ['viewLoading', 'viewLogin', 'viewName', 'viewPlaylist', 'viewClass'];
  let token = sessionStorage.getItem('idtoken') || '';
  let pendingName = '';
  const LABELS = { locked: '🔒 Locked', not_started: 'Not started', video_done: 'Video done — take the quiz', quiz_done: '✓ Completed' };

  function show(id) { views.forEach(function (v) { $(v).hidden = (v !== id); }); }
  function notice(text) { const n = $('notice'); n.textContent = text || ''; n.hidden = !text; }

  async function api(action, extra) {
    const res = await fetch(CONFIG.API_URL, {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ action: action, token: token }, extra || {}))
    });
    const data = await res.json();
    if (!data.ok) {
      if (data.error === 'AUTH') { signOut(); throw new Error('Please sign in again.'); }
      throw new Error(data.error);
    }
    return data;
  }

  function signOut() {
    leaveClass();
    token = '';
    sessionStorage.removeItem('idtoken');
    if (window.google && google.accounts) google.accounts.id.disableAutoSelect();
    $('userbox').hidden = true;
    show('viewLogin');
  }

  async function start() {
    show('viewLoading');
    notice('');
    try {
      const me = await api('me');
      $('userName').textContent = me.name || me.email;
      $('userbox').hidden = false;
      if (me.needsName) { showNameForm(); }
      else { await loadPlaylist(); }
    } catch (e) { notice(e.message); show('viewLogin'); }
  }

  function showNameForm() {
    $('nameEdit').hidden = false;
    $('nameConfirm').hidden = true;
    show('viewName');
    $('inName').focus();
  }

  async function loadPlaylist() {
    leaveClass();
    const d = await api('playlist');
    notice('');
    $('sumDone').textContent = d.completed + ' / ' + d.totalClasses;
    $('sumMarks').textContent = d.marks + ' / ' + d.maxMarks;
    $('bar').style.width = (d.totalClasses ? Math.round(d.completed / d.totalClasses * 100) : 0) + '%';
    const list = $('classList');
    list.textContent = '';
    d.classes.forEach(function (c) {
      const li = document.createElement('li');
      li.className = 'cls ' + c.status;
      const num = document.createElement('div'); num.className = 'num'; num.textContent = c.no;
      const info = document.createElement('div'); info.className = 'info';
      const ttl = document.createElement('div'); ttl.className = 'ttl'; ttl.textContent = c.title;
      const chip = document.createElement('div'); chip.className = 'chip';
      chip.textContent = LABELS[c.status] + (c.status === 'quiz_done' ? ' · ' + c.score + ' marks' : '');
      info.appendChild(ttl); info.appendChild(chip);
      li.appendChild(num); li.appendChild(info);
      li.addEventListener('click', function () {
        if (c.status === 'locked') { notice('Please complete the previous class and its quiz first.'); return; }
        openClass(c.no);
      });
      list.appendChild(li);
    });
    show('viewPlaylist');
  }

  /* ---------- Name (with on-page confirmation) ---------- */
  $('formName').addEventListener('submit', function (ev) {
    ev.preventDefault();
    const name = $('inName').value.trim().replace(/\s+/g, ' ');
    if (name.length < 2) { notice('Please enter your full name.'); return; }
    notice('');
    pendingName = name;
    $('confName').textContent = name;
    $('nameEdit').hidden = true;
    $('nameConfirm').hidden = false;
  });
  $('btnEdit').addEventListener('click', function () { $('nameEdit').hidden = false; $('nameConfirm').hidden = true; });
  $('btnYes').addEventListener('click', async function () {
    try {
      const r = await api('setName', { name: pendingName });
      $('userName').textContent = r.name;
      await loadPlaylist();
    } catch (e) { notice(e.message); }
  });
  $('btnOut').addEventListener('click', signOut);

  /* ---------- Class page with real YouTube player and watch tracking ---------- */
  let T = null;       // current class session
  let yt = null;      // YouTube player
  let tickTimer = null, flushTimer = null;
  const ytWait = [];

  window.onYouTubeIframeAPIReady = function () { while (ytWait.length) ytWait.shift()(); };
  function loadYT(cb) {
    if (window.YT && YT.Player) { cb(); return; }
    ytWait.push(cb);
    if (!document.getElementById('ytapi')) {
      const s = document.createElement('script');
      s.id = 'ytapi';
      s.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(s);
    }
  }

  function parseRanges(str) {
    const cover = {};
    String(str || '').split(',').forEach(function (p) {
      const m = /^(\d+)-(\d+)$/.exec(p.trim());
      if (!m) return;
      for (let s = +m[1]; s <= +m[2]; s++) cover[s] = 1;
    });
    return cover;
  }
  function toRanges(keys) {
    const out = [];
    let a = null, b = null;
    keys.forEach(function (k) {
      if (a === null) { a = b = k; }
      else if (k === b + 1) { b = k; }
      else { out.push([a, b]); a = b = k; }
    });
    if (a !== null) out.push([a, b]);
    return out;
  }

  async function openClass(no) {
    notice('');
    try {
      const info = await api('classInfo', { no: no });
      leaveClass();
      T = {
        no: info.no, dur: info.duration, maxSpeed: info.maxSpeed, needPct: info.watchPercent,
        cover: parseRanges(info.ranges), pend: {}, srv: info.watched, done: info.videoDone,
        quiz: info.quizScore, lastT: null, ready: false
      };
      $('clsTitle').textContent = info.title;
      $('playerBox').innerHTML = '<div id="ytp"></div>';
      show('viewClass');
      renderProgress('');
      renderGate();
      loadYT(function () {
        if (!T) return;
        yt = new YT.Player('ytp', {
          videoId: info.videoId,
          playerVars: { rel: 0, modestbranding: 1, playsinline: 1, iv_load_policy: 3 },
          events: {
            onReady: function () { if (T) { T.ready = true; if (!T.dur) T.dur = Math.floor(yt.getDuration()); } },
            onStateChange: function (e) { if (e.data === 2 || e.data === 0) flush(); }
          }
        });
      });
      tickTimer = setInterval(tick, 1000);
      flushTimer = setInterval(function () { flush(); }, 15000);
    } catch (e) { notice(e.message); }
  }

  function leaveClass() {
    if (T) { flush(); }
    clearInterval(tickTimer); clearInterval(flushTimer);
    tickTimer = flushTimer = null;
    if (yt && yt.destroy) { try { yt.destroy(); } catch (e) {} }
    yt = null; T = null;
  }

  function tick() {
    if (!T || !yt || !T.ready) return;
    let st, t, rate;
    try { st = yt.getPlayerState(); t = yt.getCurrentTime(); rate = yt.getPlaybackRate(); } catch (e) { return; }
    const hidden = document.hidden;
    let warn = '';
    if (st === 1 && !hidden) {
      if (rate > T.maxSpeed) {
        warn = 'Playing faster than ' + T.maxSpeed + 'x. This time is not counted.';
      } else if (T.lastT !== null && t > T.lastT && (t - T.lastT) <= rate + 1.5) {
        for (let s = Math.floor(T.lastT) + 1; s <= Math.floor(t); s++) {
          if (s >= 0 && s < T.dur && !T.cover[s]) { T.cover[s] = 1; T.pend[s] = 1; }
        }
      }
    } else if (st === 1 && hidden) {
      warn = 'This tab is hidden. Time is not counted.';
    }
    T.lastT = (st === 1 && !hidden) ? t : null;
    renderProgress(warn);
    if (!T.done && pctNow() >= T.needPct) flush();
  }

  function pctNow() {
    if (!T || !T.dur) return 0;
    return Math.min(100, Math.round((T.srv + Object.keys(T.pend).length) / T.dur * 100));
  }

  function renderProgress(warn) {
    if (!T) return;
    const p = pctNow();
    $('wbar').style.width = p + '%';
    $('wtext').textContent = 'Counted watch time: ' + p + '% (needs ' + T.needPct + '%). Skipped parts do not count.';
    $('wwarn').textContent = warn || '';
    $('wwarn').hidden = !warn;
  }

  function renderGate() {
    if (!T) return;
    const g = $('gateBox');
    g.textContent = '';
    const h = document.createElement('h2');
    const p = document.createElement('p');
    if (T.quiz !== null) {
      h.textContent = 'Quiz completed';
      p.textContent = 'You scored ' + T.quiz + ' marks in this class.';
    } else if (T.done) {
      h.textContent = 'Video marked as watched';
      p.textContent = 'The quiz opens in the next stage of the build.';
    } else {
      h.textContent = 'Quiz locked';
      p.textContent = 'Watch at least ' + T.needPct + '% of the video. The quiz unlocks after that.';
    }
    g.appendChild(h); g.appendChild(p);
  }

  async function flush() {
    const cur = T;
    if (!cur) return;
    const keys = Object.keys(cur.pend).map(Number).sort(function (a, b) { return a - b; });
    if (!keys.length) return;
    cur.pend = {};
    try {
      const r = await api('track', { no: cur.no, ranges: toRanges(keys) });
      cur.srv = r.watched;
      if (r.done && !cur.done) { cur.done = true; if (T === cur) renderGate(); }
      if (T === cur) renderProgress('');
    } catch (e) {
      keys.forEach(function (k) { cur.pend[k] = 1; });
    }
  }

  document.addEventListener('visibilitychange', function () { if (document.hidden) flush(); });
  window.addEventListener('pagehide', function () { flush(); });
  $('btnBack').addEventListener('click', async function () { try { await loadPlaylist(); } catch (e) { notice(e.message); } });

  function init() {
    google.accounts.id.initialize({
      client_id: CONFIG.CLIENT_ID,
      callback: function (r) { token = r.credential; sessionStorage.setItem('idtoken', token); start(); },
      auto_select: true
    });
    google.accounts.id.renderButton($('gbtn'), { theme: 'outline', size: 'large', shape: 'pill', text: 'continue_with' });
    if (token) start(); else show('viewLogin');
  }
  window.onGoogleLibraryLoad = init;
  if (window.google && google.accounts) init();
})();
