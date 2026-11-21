/*
 * SlopCloud API - browser-side song storage. Standalone, no dependencies.
 *
 * Songs are kept in the site's own storage:
 *   - audio bytes  -> Cache API   (caches 'slopcloud-v2-audio')
 *   - metadata     -> IndexedDB   (db 'slopcloud', store 'songs')
 * Nothing is written to the device's downloads folder. Clearing this site's
 * stored data (or pressing delete/clear in the UI) removes the songs.
 *
 * Public API (all async unless noted):
 *   init()                                  open storage; returns SlopCloud
 *   fetchAndCache(apiBase, url, opts)       download a SoundCloud link into the
 *                                           cache; opts = { format='auto',
 *                                           onProgress(loaded,total),
 *                                           skipIfCached=false }; returns the
 *                                           song record { id, title, artist,
 *                                           ext, size, note, snip, ... }
 *   importFile(file)                        store a local audio File in the cache
 *   listSongs()                             array of song records, newest first
 *   getSong(id)                             one record, or null
 *   getSongBlob(id)                         the audio Blob
 *   createObjectURL(id) / releaseObjectURL(url)   playback URLs
 *   deleteSong(id) / clearAll()             remove one / all
 *   usage()                                 { used, quota, songs }
 *   saveFile(blob, filename)                trigger a browser download (not async)
 */
(function () {
  'use strict';

  var AUDIO_CACHE = 'slopcloud-v2-audio';
  var LEGACY_AUDIO_CACHES = ['slopcloud-v1-audio'];
  var DB_NAME = 'slopcloud';
  var DB_VERSION = 2;
  var STORE = 'songs';

  // Retry transient gateway failures (502/503/504).
  async function fetchRetry(url, tries) {
    tries = tries || 3;
    var res = null;
    for (var i = 0; i < tries; i++) {
      res = await fetch(url);
      if (res.status !== 502 && res.status !== 503 && res.status !== 504) return res;
      if (i < tries - 1) await new Promise(function (r) { setTimeout(r, 700 * (i + 1)); });
    }
    return res;
  }

  function apiError(kind, base, res, errBody) {
    if (errBody && errBody.error && errBody.error.message) return new Error(errBody.error.message);
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      return new Error('The API at ' + (base || 'SSDA') + ' did not respond (' + res.status +
        '). It may be starting up — try again in a moment.');
    }
    return new Error('SSDA ' + kind + ' failed (' + res.status + ')');
  }

  function cacheKey(id) {
    return new URL('./slopcloud/audio/' + id, location.href).href;
  }

  function hashId(str) {
    // FNV-1a 32-bit, twice with different seeds -> 16 hex chars
    function fnv(s, seed) {
      var h = seed >>> 0;
      for (var i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = (h * 16777619) >>> 0;
      }
      return h.toString(16).padStart(8, '0');
    }
    return fnv(str, 2166136261) + fnv(str, 2166136262);
  }

  function openDb() {
    return new Promise(function (resolve, reject) {
      if (!('indexedDB' in self)) return reject(new Error('IndexedDB is unavailable in this browser.'));
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        // v2: start from a clean slate - old entries were saved by earlier
        // builds and some contain audio that does not play
        if (db.objectStoreNames.contains(STORE)) {
          db.deleteObjectStore(STORE);
        }
        db.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('Could not open the SlopCloud database.')); };
    });
  }

  function tx(db, mode, fn) {
    return new Promise(function (resolve, reject) {
      var t = db.transaction(STORE, mode);
      var store = t.objectStore(STORE);
      var out = fn(store);
      t.oncomplete = function () {
        // resolve the request's result (undefined for put/delete/clear or a
        // missing key -> null), never the request object itself
        resolve(out && out.result !== undefined ? out.result : null);
      };
      t.onerror = function () { reject(t.error); };
      t.onabort = function () { reject(t.error || new Error('Database transaction failed.')); };
    });
  }

  var dbPromise = null;
  function db() {
    if (!dbPromise) dbPromise = openDb();
    return dbPromise;
  }

  async function audioCache() {
    if (!('caches' in self)) {
      throw new Error('The Cache API is unavailable (needs https or localhost).');
    }
    return caches.open(AUDIO_CACHE);
  }

  var SlopCloud = {
    /** Open storage. Safe to call repeatedly. */
    init: async function () {
      await db();
      await audioCache();
      // drop legacy audio caches from earlier versions
      if ('caches' in self) {
        for (var i = 0; i < LEGACY_AUDIO_CACHES.length; i++) {
          try { await caches.delete(LEGACY_AUDIO_CACHES[i]); } catch (e) { /* ignore */ }
        }
      }
      return SlopCloud;
    },

    /**
     * Fetch a track from an SSDA server and store it in the browser cache.
     * opts: { format='auto', onProgress(loaded,total), skipIfCached=false }
     * Returns the song metadata record.
     */
    fetchAndCache: async function (apiBase, soundcloudUrl, opts) {
      opts = opts || {};
      var base = (apiBase || '').replace(/\/+$/, '');
      var format = opts.format || 'auto';

      var infoRes = await fetchRetry(base + '/api/info?url=' + encodeURIComponent(soundcloudUrl));
      if (!infoRes.ok) {
        var errBody = await infoRes.json().catch(function () { return null; });
        throw apiError('/api/info', base, infoRes, errBody);
      }
      var info = await infoRes.json();
      var id = hashId(info.permalink_url || soundcloudUrl);

      if (opts.skipIfCached) {
        var existing = await SlopCloud.getSong(id);
        if (existing) return existing;
      }

      var res = await fetchRetry(base + '/api/audio?url=' + encodeURIComponent(soundcloudUrl) + '&format=' + encodeURIComponent(format));
      if (!res.ok) {
        var audioErr = await res.json().catch(function () { return null; });
        throw apiError('/api/audio', base, res, audioErr);
      }

      var total = Number(res.headers.get('Content-Length')) || 0;
      var type = res.headers.get('Content-Type') || 'audio/mpeg';
      var ext = (res.headers.get('X-SSDA-Extension') || '').replace(/^\./, '');
      if (!ext) ext = { 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/flac': 'flac' }[type.split(';')[0].trim()] || 'bin';

      var chunks = [];
      var loaded = 0;
      if (res.body && res.body.getReader) {
        var reader = res.body.getReader();
        while (true) {
          var part = await reader.read();
          if (part.done) break;
          chunks.push(part.value);
          loaded += part.value.length;
          if (opts.onProgress) opts.onProgress(loaded, total);
        }
      } else {
        var buf = await res.arrayBuffer();
        chunks.push(new Uint8Array(buf));
        loaded = buf.byteLength;
        if (opts.onProgress) opts.onProgress(loaded, total);
      }

      var blob = new Blob(chunks, { type: type });
      var record = {
        id: id,
        title: info.title || 'Untitled',
        artist: info.artist || 'Unknown artist',
        duration: info.duration || null,
        artworkUrl: info.artwork_url || null,
        sourceUrl: info.permalink_url || soundcloudUrl,
        ext: ext,
        mime: type.split(';')[0].trim(),
        size: blob.size,
        savedAt: Date.now(),
        note: res.headers.get('X-SSDA-Format-Note') || '',
        snip: !!info.snip,
      };

      var cache = await audioCache();
      await cache.put(
        new Request(cacheKey(id)),
        new Response(blob, { headers: { 'Content-Type': record.mime, 'X-SlopCloud-Title': encodeURIComponent(record.title) } })
      );
      await tx(await db(), 'readwrite', function (store) { store.put(record); });
      return record;
    },

    /**
     * Save an audio file from the user's device into the cache (for example a
     * file downloaded elsewhere when SoundCloud blocks streaming). Stored and
     * played exactly like songs fetched from a link.
     */
    importFile: async function (file, opts) {
      opts = opts || {};
      if (!file) throw new Error('No file selected.');
      var name = (file.name || 'audio').replace(/\.[^.]+$/, '');
      var ext = ((file.name.match(/\.([^.]+)$/) || [])[1] || '').toLowerCase();
      var mime = file.type || '';
      if (ext === 'mp3') mime = 'audio/mpeg';
      else if (ext === 'm4a' || ext === 'mp4') { mime = 'audio/mp4'; ext = 'm4a'; }
      else if (ext === 'aac') mime = 'audio/aac';
      else if (ext === 'opus' || ext === 'ogg' || ext === 'oga') mime = 'audio/ogg';
      else if (ext === 'wav') mime = 'audio/wav';
      else if (ext === 'flac') mime = 'audio/flac';
      if (!mime) mime = 'audio/mpeg';
      if (!ext) ext = 'bin';
      var id = 'file:' + hashId(name + ':' + file.size + ':' + (file.lastModified || 0));
      var record = {
        id: id,
        title: name || 'Imported audio',
        artist: opts.artist || 'Imported file',
        duration: null,
        artworkUrl: null,
        sourceUrl: null,
        ext: ext,
        mime: mime.split(';')[0].trim(),
        size: file.size,
        savedAt: Date.now(),
      };
      var cache = await audioCache();
      await cache.put(
        new Request(cacheKey(id)),
        new Response(file, { headers: { 'Content-Type': record.mime, 'X-SlopCloud-Title': encodeURIComponent(record.title) } })
      );
      await tx(await db(), 'readwrite', function (store) { store.put(record); });
      return record;
    },

    /** All stored songs, newest first. */
    listSongs: async function () {
      var songs = await tx(await db(), 'readonly', function (store) { return store.getAll(); });
      return (songs || []).sort(function (a, b) { return (b.savedAt || 0) - (a.savedAt || 0); });
    },

    getSong: async function (id) {
      return tx(await db(), 'readonly', function (store) { return store.get(id); }) || null;
    },

    /** Audio bytes of a stored song (Blob). */
    getSongBlob: async function (id) {
      var cache = await audioCache();
      var res = await cache.match(cacheKey(id));
      if (!res) throw new Error('Song not found in cache (it may have been cleared).');
      return res.blob();
    },

    /** Object URL for playback. Caller must revoke it when done. */
    createObjectURL: async function (id) {
      var blob = await SlopCloud.getSongBlob(id);
      return URL.createObjectURL(blob);
    },

    /** Remove one song. */
    deleteSong: async function (id) {
      var cache = await audioCache();
      await cache.delete(cacheKey(id));
      await tx(await db(), 'readwrite', function (store) { store.delete(id); });
    },

    /** Remove every stored song. */
    clearAll: async function () {
      await caches.delete(AUDIO_CACHE);
      await tx(await db(), 'readwrite', function (store) { return store.clear(); });
    },

    /** Storage statistics: { used, quota, songs } */
    usage: async function () {
      var songs = await SlopCloud.listSongs();
      var used = songs.reduce(function (sum, s) { return sum + (s.size || 0); }, 0);
      var quota = 0;
      if (navigator.storage && navigator.storage.estimate) {
        try {
          var est = await navigator.storage.estimate();
          used = est.usage || used;
          quota = est.quota || 0;
        } catch (e) { /* keep song-sum estimate */ }
      }
      return { used: used, quota: quota, songs: songs.length };
    },

    /** Trigger a browser download of a Blob. */
    saveFile: function (blob, filename) {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        URL.revokeObjectURL(a.href);
        a.remove();
      }, 4000);
    },
  };

  self.SlopCloud = SlopCloud;
})();
