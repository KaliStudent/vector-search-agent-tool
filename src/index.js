const FEEDS = [
  { name: 'Ars Technica', url: 'https://arstechnica.com/feed/' },
  { name: 'The Next Web', url: 'https://thenextweb.com/feed/' },
  { name: 'Mashable', url: 'https://mashable.com/feeds/rss/all' },
  { name: 'The Information', url: 'https://www.theinformation.com/feed' },
  { name: 'TechCrunch', url: 'https://techcrunch.com/feed/' },
  { name: 'daily.dev', url: 'https://daily.dev/feed.xml' },
  { name: 'XDA Developers', url: 'https://www.xda-developers.com/feed/' },
  { name: 'Engadget', url: 'https://www.engadget.com/rss.xml' },
  { name: "Tom's Hardware", url: 'https://www.tomshardware.com/feeds/all' },
  { name: 'GlassyOwl', url: 'https://www.glassyowl.com/feed/' },
  { name: 'Gizmodo', url: 'https://gizmodo.com/rss' },
  { name: 'TechRadar', url: 'https://www.techradar.com/rss' },
  { name: 'MakeUseOf', url: 'https://www.makeuseof.com/feed/' },
  { name: 'GeekWire', url: 'https://www.geekwire.com/feed/' },
  { name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml' },
];

const CACHE_KEY = 'aggregated-feed';
const CACHE_TTL = 300;

function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function parseFeedItems(xml, sourceName) {
  const items = [];
  const itemRegex = /<item[\s\S]*?>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i)?.[1]?.trim();
    const link = block.match(/<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/i)?.[1]?.trim();
    const pubDate = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1]?.trim();
    const description = block.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i)?.[1]?.trim();
    if (title && link) {
      items.push({ title, link, pubDate: pubDate || '', description: description || '', source: sourceName });
    }
  }
  const entryRegex = /<entry[\s\S]*?>([\s\S]*?)<\/entry>/gi;
  while ((match = entryRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = block.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
    const link = block.match(/<link[^>]*href="([^"]*)"[^>]*\/?>/i)?.[1]?.trim() ||
                 block.match(/<link[^>]*>([\s\S]*?)<\/link>/i)?.[1]?.trim();
    const pubDate = block.match(/<published>([\s\S]*?)<\/published>/i)?.[1]?.trim() ||
                    block.match(/<updated>([\s\S]*?)<\/updated>/i)?.[1]?.trim();
    const description = block.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i)?.[1]?.trim() ||
                        block.match(/<content[^>]*>([\s\S]*?)<\/content>/i)?.[1]?.trim() || '';
    if (title && link) {
      items.push({ title, link, pubDate: pubDate || '', description: description || '', source: sourceName });
    }
  }
  return items;
}

function buildRssXml(items) {
  const rssItems = items.map(i => `    <item>
      <title>${escapeXml(i.title)}</title>
      <link>${escapeXml(i.link)}</link>
      <pubDate>${escapeXml(i.pubDate)}</pubDate>
      <description>${escapeXml(i.description ? i.description.substring(0, 300) : '')}</description>
      <source>${escapeXml(i.source)}</source>
    </item>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Tech News Aggregator</title>
    <link>https://rss-aggregator.workers.dev</link>
    <description>Top tech news from Ars Technica, TechCrunch, The Verge, and more</description>
    <atom:link href="https://rss-aggregator.workers.dev" rel="self" type="application/rss+xml" />
    <language>en-us</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${rssItems}
  </channel>
</rss>`;
}

async function aggregateFeeds() {
  const responses = await Promise.allSettled(
    FEEDS.map(async (feed) => {
      try {
        const resp = await fetch(feed.url, {
          headers: { 'User-Agent': 'Cloudflare-Workers-RSS-Aggregator/1.0' },
          cf: { cacheTtl: 60 },
        });
        if (!resp.ok) return [];
        const xml = await resp.text();
        return parseFeedItems(xml, feed.name);
      } catch {
        return [];
      }
    })
  );

  const allItems = responses
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value);

  allItems.sort((a, b) => {
    const dateA = a.pubDate ? new Date(a.pubDate) : new Date(0);
    const dateB = b.pubDate ? new Date(b.pubDate) : new Date(0);
    return dateB - dateA;
  });

  return allItems.slice(0, 50);
}

async function getEmbedding(ai, text) {
  const response = await ai.run('@cf/baai/bge-small-en-v1.5', { text: [text] });
  return response.data[0];
}

async function indexItems(vectorize, ai, items) {
  const vectors = [];
  for (const item of items) {
    const text = `${item.title}. ${item.description || ''}`;
    const embedding = await getEmbedding(ai, text);
    vectors.push({
      id: btoa(item.link).replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 64),
      values: embedding,
      metadata: {
        title: item.title,
        link: item.link,
        source: item.source,
        pubDate: item.pubDate,
        description: item.description || ''
      }
    });
  }
  if (vectors.length > 0) {
    await vectorize.upsert(vectors);
  }
  return vectors.length;
}

async function handleSearch(request, env) {
  const url = new URL(request.url);
  const query = url.searchParams.get('q');
  if (!query) {
    return new Response(JSON.stringify({ error: 'Missing q parameter' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  const queryEmbedding = await getEmbedding(env.AI, query);
  const results = await env.VECTORIZE.query(queryEmbedding, {
    topK: 10,
    returnMetadata: true
  });
  return new Response(JSON.stringify({
    query,
    results: results.matches.map(m => ({
      score: m.score,
      title: m.metadata.title,
      link: m.metadata.link,
      source: m.metadata.source,
      pubDate: m.metadata.pubDate,
      description: m.metadata.description
    }))
  }), {
    headers: { 
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/search') {
      return handleSearch(request, env);
    }
    const cached = await env.RSS_CACHE.get(CACHE_KEY, { type: 'text' });
    if (cached) {
      return new Response(cached, {
        headers: {
          'Content-Type': 'application/xml; charset=utf-8',
          'Cache-Control': 'public, max-age=300',
        },
      });
    }
    const items = await aggregateFeeds();
    const xml = buildRssXml(items);
    ctx.waitUntil(indexItems(env.VECTORIZE, env.AI, items));
    await env.RSS_CACHE.put(CACHE_KEY, xml, { expirationTtl: CACHE_TTL });
    return new Response(xml, {
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
      },
    });
  },
  async scheduled(event, env, ctx) {
    const items = await aggregateFeeds();
    const xml = buildRssXml(items);
    ctx.waitUntil(indexItems(env.VECTORIZE, env.AI, items));
    await env.RSS_CACHE.put(CACHE_KEY, xml, { expirationTtl: CACHE_TTL });
  },
};
