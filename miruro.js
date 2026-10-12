// Miruro for Shirox. Uses Miruro's catalog and current direct HLS sources.
var MM_BASE = 'https://www.miruro.tv';
var MM_KEY = 'miruro/catalog';

function mmId(url, episode) {
  var pattern = episode ? /\/watch\/([^/?#]+)\?ep=(\d+)/ : /\/(?:info|watch)\/([^/?#]+)/;
  var found = String(url || '').match(pattern);
  if (!found) throw new Error('Invalid Miruro link. Search again and choose the title.');
  return { id: decodeURIComponent(found[1]), episode: episode ? Number(found[2]) : null };
}

function mmClean(text) {
  return String(text || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#(?:39|039);/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function mmHeaders(headers) {
  var result = {};
  Object.keys(headers || {}).forEach(function (key) { result[key] = headers[key]; });
  return result;
}

async function mmApi(path) {
  var response = await fetch(MM_BASE + '/api' + path, {
    headers: { Accept: 'application/octet-stream, application/json', Referer: MM_BASE + '/' }
  });
  if (!response || !response.ok) throw new Error('Miruro is temporarily unavailable.');
  if (typeof response.arrayBuffer !== 'function' || typeof DecompressionStream === 'undefined') {
    throw new Error('This Shirox version needs a newer web engine for Miruro.');
  }
  var bytes = new Uint8Array(await response.arrayBuffer());
  for (var index = 0; index < bytes.length; index++) bytes[index] ^= MM_KEY.charCodeAt(index % MM_KEY.length);
  var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text());
}

function mmHref(id) {
  return MM_BASE + '/info/' + encodeURIComponent(id);
}

async function searchResults(keyword) {
  var query = String(keyword || '').trim();
  if (!query) return JSON.stringify([]);
  var data = await mmApi('/v1/anime?q=' + encodeURIComponent(query) + '&limit=15&sort=-popularity');
  var results = (data.data || []).map(function (anime) {
    var title = anime.title && (anime.title.english || anime.title.romaji || anime.title.native) || anime.id;
    return { title: title + ' [Sub & Dub]', image: anime.cover_url || '', href: mmHref(anime.id) };
  });
  return JSON.stringify(results);
}

async function extractDetails(url) {
  var handle = mmId(url, false);
  var anime = await mmApi('/v1/anime/' + encodeURIComponent(handle.id));
  var titles = anime.title || {};
  var aliases = [titles.romaji, titles.native].filter(function (value, index, values) {
    return value && values.indexOf(value) === index;
  }).join(', ');
  return JSON.stringify([{
    description: mmClean(anime.description),
    aliases: aliases,
    airdate: anime.season_year ? String(anime.season_year) : ''
  }]);
}

async function extractEpisodes(url) {
  var handle = mmId(url, false);
  var data = await mmApi('/v1/anime/' + encodeURIComponent(handle.id) + '/episodes?limit=10000');
  var seen = {};
  var episodes = (data.data || []).filter(function (episode) {
    var number = Number(episode.episode_number);
    if (!Number.isFinite(number) || number <= 0 || seen[number]) return false;
    seen[number] = true;
    return true;
  }).sort(function (left, right) {
    return Number(left.episode_number) - Number(right.episode_number);
  }).map(function (episode) {
    return {
      number: Number(episode.episode_number),
      href: MM_BASE + '/watch/' + encodeURIComponent(handle.id) + '?ep=' + encodeURIComponent(episode.episode_number)
    };
  });
  return JSON.stringify(episodes);
}

function mmTrack(playback, name) {
  return (playback.tracks || []).filter(function (track) { return track.track === name; })[0] || null;
}

function mmSource(track, preferredProvider) {
  if (!track) return null;
  var providers = (track.providers || []).slice().sort(function (left, right) {
    return (left.provider === preferredProvider ? -1 : 0) - (right.provider === preferredProvider ? -1 : 0);
  });
  for (var providerIndex = 0; providerIndex < providers.length; providerIndex++) {
    var provider = providers[providerIndex];
    var servers = provider.servers || [];
    for (var serverIndex = 0; serverIndex < servers.length; serverIndex++) {
      var server = servers[serverIndex];
      var stream = (server.streams || []).filter(function (item) {
        return item && item.format === 'hls' && /^https:\/\//i.test(item.url || '');
      })[0];
      if (stream) return { provider: provider, server: server, stream: stream };
    }
  }
  return null;
}

function mmAddSource(collection, used, label, source) {
  if (!source || used[source.stream.url]) return;
  used[source.stream.url] = true;
  collection.push({
    title: label + ' · ' + (source.provider.provider || 'Miruro') + ' · ' + (source.server.server || 'HLS'),
    streamUrl: source.stream.url,
    headers: mmHeaders(source.server.headers || source.stream.headers)
  });
}

function mmAddSubtitles(collection, used, source, label) {
  if (!source) return;
  (source.provider.subtitles || []).forEach(function (subtitle) {
    var file = subtitle.file || subtitle.url;
    if (!/^https:\/\//i.test(file || '') || used[file]) return;
    used[file] = true;
    collection.push({
      title: label + ' · ' + (subtitle.label || subtitle.language || 'Subtitle'),
      url: file,
      headers: mmHeaders(subtitle.headers || source.server.headers)
    });
  });
}

async function extractStreamUrl(url) {
  var handle = mmId(url, true);
  var playback = await mmApi('/v1/anime/' + encodeURIComponent(handle.id) + '/episodes/' + encodeURIComponent(handle.episode) + '/play');
  var softSub = mmSource(mmTrack(playback, 'ssub'), 'anikoto');
  var sub = mmSource(mmTrack(playback, 'sub'), 'icarus');
  var dub = mmSource(mmTrack(playback, 'dub'), 'anikoto');
  var streams = [], subtitles = [], usedStreams = {}, usedSubtitles = {};
  mmAddSource(streams, usedStreams, 'English Sub', softSub || sub);
  mmAddSource(streams, usedStreams, 'English Dub', dub);
  mmAddSubtitles(subtitles, usedSubtitles, softSub, 'English Sub');
  mmAddSubtitles(subtitles, usedSubtitles, dub, 'English Dub');
  if (!streams.length) throw new Error('No Miruro stream is available for this episode yet.');
  return JSON.stringify({ streams: streams, allSubtitles: subtitles });
}
