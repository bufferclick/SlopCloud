/*
 * SlopCloud site UI. Depends on slopcloud.js (window.SlopCloud) and the SSDA
 * API (Supabase Edge Function, see supabase/functions/ssda in the repository).
 */
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  // SSDA API — runs as a Supabase Edge Function inside the SlopCloud project.
  // Override with localStorage.setItem('ssda.api', 'http://localhost:8787') for
  // local development; blank nothing to configure for normal use.
  var API_BASE = localStorage.getItem('ssda.api') ||
    'https://zfshvxknthgzlgzulpuq.supabase.co/functions/v1/ssda';

  var els = {
    form: $('add-form'),
    url: $('url-input'),
    format: $('format-select'),
    saveBtn: $('save-btn'),
    fileBtn: $('file-btn'),
    progressWrap: $('progress-wrap'),
    progressBar: $('progress-bar'),
    status: $('status'),
    list: $('song-list'),
    emptyNote: $('empty-note'),
    songsCount: $('songs-count'),
    storageInfo: $('storage-info'),
    clearBtn: $('clear-btn'),
    player: $('player'),
    playerTitle: $('player-title'),
    playerArtist: $('player-artist'),
    playerToggle: $('player-toggle'),
    playerSeek: $('player-seek'),
    playerTime: $('player-time'),
    playerClose: $('player-close'),
  };

  var state = {
    songs: [],
    playingId: null,
    objectUrl: null,
    seeking: false,
    busy: false,
  };

  var audio = new Audio();
  audio.addEventListener('timeupdate', onTimeUpdate);
  audio.addEventListener('loadedmetadata', onTimeUpdate);
  audio.addEventListener('ended', function () {
    updatePlayButtons();
    els.playerToggle.textContent = '▶';
    els.playerToggle.setAttribute('aria-label', 'Play');
    updateRowProgress(state.playingId, 1);
  });

  // ---------- helpers ----------

  function fmtBytes(n) {
    if (!n && n !== 0) return '';
    var units = ['B', 'KB', 'MB', 'GB'];
    var i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(1)) + ' ' + units[i];
  }

  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    var m = Math.floor(sec / 60);
    var s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function setStatus(msg, kind) {
    els.status.textContent = msg || '';
    els.status.className = 'status' + (kind ? ' ' + kind : '');
  }

  function showProgress(loaded, total) {
    els.progressWrap.classList.remove('hidden');
    if (total > 0) {
      els.progressBar.classList.remove('indeterminate');
      els.progressBar.style.width = Math.min(100, Math.round((loaded / total) * 100)) + '%';
    } else {
      els.progressBar.classList.add('indeterminate');
      els.progressBar.style.width = '';
    }
  }

  function hideProgress() {
    els.progressWrap.classList.add('hidden');
    els.progressBar.style.width = '0';
    els.progressBar.classList.remove('indeterminate');
  }

  function busy(on) {
    state.busy = on;
    els.saveBtn.disabled = on;
    els.fileBtn.disabled = on;
    els.format.disabled = on;
  }

  function sanitizeName(s) {
    return (s || 'track').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'track';
  }

  function saveBlobToFile(blob, filename) {
    var a = document.createElement('a');
    var url = URL.createObjectURL(blob);
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 5000);
  }

  // ---------- API status ----------

  function apiUrl(path) {
    return API_BASE.replace(/\/+$/, '') + path;
  }

  function checkApi() {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 6000);
    fetch(apiUrl('/api/health'), { signal: ctrl.signal })
      .then(function (res) { return res.ok ? res.json() : Promise.reject(new Error('HTTP ' + res.status)); })
      .then(function (data) {
        clearTimeout(timer);
        if (!data.ok) throw new Error('bad health response');
      })
      .catch(function () {
        clearTimeout(timer);
        setStatus('The SSDA API is not reachable right now. Saving and downloading songs will not work.', 'error');
      });
  }

  // ---------- songs ----------

  function refreshStorage() {
    SlopCloud.usage().then(function (u) {
      els.storageInfo.textContent = u.songs + ' song' + (u.songs === 1 ? '' : 's') +
        ' · ' + fmtBytes(u.used) + ' used' +
        (u.quota ? ' of ' + fmtBytes(u.quota) : '');
    }).catch(function () {
      els.storageInfo.textContent = '';
    });
  }

  function renderSongs() {
    els.list.innerHTML = '';
    els.emptyNote.classList.toggle('hidden', state.songs.length > 0);
    els.songsCount.textContent = state.songs.length ? '(' + state.songs.length + ')' : '';

    state.songs.forEach(function (song) {
      var li = document.createElement('li');
      li.className = 'song';
      li.dataset.id = song.id;

      var art = document.createElement('div');
      art.className = 'art';
      if (song.artworkUrl) {
        var img = document.createElement('img');
        img.src = song.artworkUrl;
        img.alt = '';
        img.loading = 'lazy';
        img.addEventListener('error', function () { art.textContent = '♪'; });
        art.appendChild(img);
      } else {
        art.textContent = '♪';
      }

      var main = document.createElement('div');
      main.className = 'song-main';
      var title = document.createElement('div');
      title.className = 'song-title';
      title.textContent = song.title;
      var sub = document.createElement('div');
      sub.className = 'song-sub';
      sub.textContent = [
        song.artist,
        song.ext ? '.' + song.ext : '',
        fmtBytes(song.size),
        song.duration ? fmtTime(song.duration) : '',
        new Date(song.savedAt).toLocaleDateString(),
      ].filter(Boolean).join(' · ');
      var prog = document.createElement('div');
      prog.className = 'song-progress';
      prog.innerHTML = '<div></div>';
      main.appendChild(title);
      main.appendChild(sub);
      main.appendChild(prog);

      var actions = document.createElement('div');
      actions.className = 'song-actions';

      var playBtn = document.createElement('button');
      playBtn.type = 'button';
      playBtn.className = 'btn icon play-btn';
      playBtn.dataset.id = song.id;
      playBtn.setAttribute('aria-label', 'Play');
      playBtn.textContent = '▶';

      var dlBtn = document.createElement('button');
      dlBtn.type = 'button';
      dlBtn.className = 'btn icon';
      dlBtn.dataset.id = song.id;
      dlBtn.dataset.action = 'download';
      dlBtn.setAttribute('aria-label', 'Download song to files');
      dlBtn.textContent = '⬇';

      var delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn icon';
      delBtn.dataset.id = song.id;
      delBtn.dataset.action = 'delete';
      delBtn.setAttribute('aria-label', 'Delete cached song');
      delBtn.textContent = '🗑';

      actions.appendChild(playBtn);
      actions.appendChild(dlBtn);
      actions.appendChild(delBtn);

      li.appendChild(art);
      li.appendChild(main);
      li.appendChild(actions);
      els.list.appendChild(li);
    });

    updatePlayButtons();
    refreshStorage();
  }

  function updatePlayButtons() {
    var btns = els.list.querySelectorAll('.play-btn');
    btns.forEach(function (b) {
      var playing = b.dataset.id === state.playingId && !audio.paused;
      b.textContent = playing ? '⏸' : '▶';
      b.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    });
    if (state.playingId) {
      var paused = audio.paused;
      els.playerToggle.textContent = paused ? '▶' : '⏸';
      els.playerToggle.setAttribute('aria-label', paused ? 'Play' : 'Pause');
    }
  }

  function updateRowProgress(id, ratio) {
    if (!id) return;
    var row = els.list.querySelector('.song[data-id="' + id + '"] .song-progress > div');
    if (row) row.style.width = Math.round((ratio || 0) * 100) + '%';
  }

  function onTimeUpdate() {
    var dur = audio.duration || 0;
    var cur = audio.currentTime || 0;
    if (!state.seeking) {
      els.playerSeek.value = dur ? String(Math.round((cur / dur) * 1000)) : '0';
    }
    els.playerTime.textContent = fmtTime(cur) + ' / ' + fmtTime(dur);
    updateRowProgress(state.playingId, dur ? cur / dur : 0);
  }

  function releaseUrl() {
    if (state.objectUrl) {
      URL.revokeObjectURL(state.objectUrl);
      state.objectUrl = null;
    }
  }

  function stopPlayback() {
    audio.pause();
    releaseUrl();
    audio.removeAttribute('src');
    audio.load();
    state.playingId = null;
    els.player.classList.add('hidden');
    updatePlayButtons();
  }

  async function playSong(id) {
    var song = state.songs.filter(function (s) { return s.id === id; })[0];
    if (!song) return;

    if (state.playingId === id) {
      if (audio.paused) {
        try { await audio.play(); } catch (e) { /* ignore */ }
      } else {
        audio.pause();
      }
      updatePlayButtons();
      return;
    }

    try {
      releaseUrl();
      var url = await SlopCloud.createObjectURL(id);
      state.objectUrl = url;
      state.playingId = id;
      audio.src = url;
      await audio.play();
      els.playerTitle.textContent = song.title;
      els.playerArtist.textContent = song.artist;
      els.player.classList.remove('hidden');
      updatePlayButtons();
    } catch (e) {
      setStatus('Could not play this song: ' + e.message, 'error');
      stopPlayback();
    }
  }

  // ---------- add / download flows ----------

  async function saveToCache() {
    var url = els.url.value.trim();
    if (!url) return;
    busy(true);
    setStatus('Fetching track info…');
    showProgress(0, 0);
    try {
      var record = await SlopCloud.fetchAndCache(API_BASE, url, {
        format: els.format.value,
        onProgress: showProgress,
      });
      setStatus('Saved to cache: ' + record.artist + ' – ' + record.title, 'ok');
      els.url.value = '';
      await reloadSongs();
    } catch (e) {
      setStatus(e.message, 'error');
    } finally {
      busy(false);
      hideProgress();
    }
  }

  async function downloadToFiles() {
    var url = els.url.value.trim();
    if (!url) {
      setStatus('Enter a SoundCloud link first.', 'error');
      return;
    }
    busy(true);
    setStatus('Fetching track info…');
    showProgress(0, 0);
    try {
      var infoRes = await fetch(apiUrl('/api/info?url=' + encodeURIComponent(url)));
      if (!infoRes.ok) {
        var body = await infoRes.json().catch(function () { return null; });
        throw new Error((body && body.error && body.error.message) || ('SSDA /api/info failed (' + infoRes.status + ')'));
      }
      var info = await infoRes.json();
      var filename = sanitizeName((info.artist || 'Unknown') + ' - ' + (info.title || 'track'));

      var audioRes = await fetch(apiUrl('/api/audio?url=' + encodeURIComponent(url) + '&format=' + encodeURIComponent(els.format.value)));
      if (!audioRes.ok) {
        var audioBody = await audioRes.json().catch(function () { return null; });
        throw new Error((audioBody && audioBody.error && audioBody.error.message) || ('SSDA /api/audio failed (' + audioRes.status + ')'));
      }
      var total = Number(audioRes.headers.get('Content-Length')) || 0;
      var type = audioRes.headers.get('Content-Type') || 'audio/mpeg';
      var ext = (audioRes.headers.get('X-SSDA-Extension') || 'mp3').replace(/^\./, '');

      var chunks = [];
      var loaded = 0;
      if (audioRes.body && audioRes.body.getReader) {
        var reader = audioRes.body.getReader();
        while (true) {
          var part = await reader.read();
          if (part.done) break;
          chunks.push(part.value);
          loaded += part.value.length;
          showProgress(loaded, total);
        }
      } else {
        var buf = await audioRes.arrayBuffer();
        chunks.push(new Uint8Array(buf));
        loaded = buf.byteLength;
        showProgress(loaded, total);
      }

      saveBlobToFile(new Blob(chunks, { type: type }), filename + '.' + ext);
      setStatus('Saved to files: ' + filename + '.' + ext, 'ok');
    } catch (e) {
      setStatus(e.message, 'error');
    } finally {
      busy(false);
      hideProgress();
    }
  }

  // ---------- events ----------

  els.form.addEventListener('submit', function (e) {
    e.preventDefault();
    saveToCache();
  });

  els.fileBtn.addEventListener('click', function () {
    downloadToFiles();
  });

  els.clearBtn.addEventListener('click', async function () {
    if (!state.songs.length) return;
    if (!confirm('Delete all cached songs from this site?')) return;
    stopPlayback();
    try {
      await SlopCloud.clearAll();
      await reloadSongs();
      setStatus('All cached songs deleted.', 'ok');
    } catch (e) {
      setStatus(e.message, 'error');
    }
  });

  els.list.addEventListener('click', async function (e) {
    var btn = e.target.closest('button');
    if (!btn) return;
    var id = btn.dataset.id;
    var action = btn.dataset.action;
    try {
      if (action === 'delete') {
        var song = state.songs.filter(function (s) { return s.id === id; })[0];
        if (!song) return;
        if (!confirm('Delete "' + song.title + '" from the cache?')) return;
        if (state.playingId === id) stopPlayback();
        await SlopCloud.deleteSong(id);
        await reloadSongs();
        setStatus('Deleted from cache: ' + song.title, 'ok');
      } else if (action === 'download') {
        var s = state.songs.filter(function (x) { return x.id === id; })[0];
        if (!s) return;
        var blob = await SlopCloud.getSongBlob(id);
        saveBlobToFile(blob, sanitizeName(s.artist + ' - ' + s.title) + '.' + (s.ext || 'bin'));
        setStatus('Saved to files: ' + s.title, 'ok');
      } else {
        await playSong(id);
      }
    } catch (err) {
      setStatus(err.message, 'error');
    }
  });

  els.playerToggle.addEventListener('click', async function () {
    if (!state.playingId) return;
    if (audio.paused) {
      try { await audio.play(); } catch (e) { /* ignore */ }
    } else {
      audio.pause();
    }
    updatePlayButtons();
  });

  els.playerSeek.addEventListener('input', function () {
    state.seeking = true;
  });
  els.playerSeek.addEventListener('change', function () {
    if (audio.duration) {
      audio.currentTime = (Number(els.playerSeek.value) / 1000) * audio.duration;
    }
    state.seeking = false;
    onTimeUpdate();
  });

  els.playerClose.addEventListener('click', stopPlayback);

  // ---------- boot ----------

  async function reloadSongs() {
    try {
      state.songs = await SlopCloud.listSongs();
    } catch (e) {
      state.songs = [];
      setStatus('Storage unavailable: ' + e.message, 'error');
    }
    renderSongs();
  }

  async function boot() {
    checkApi();
    try {
      await SlopCloud.init();
    } catch (e) {
      setStatus('Storage unavailable: ' + e.message, 'error');
    }
    await reloadSongs();
  }

  boot();
})();
