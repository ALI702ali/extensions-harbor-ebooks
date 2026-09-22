// Harbor eBook source: Turath Arabic Books
// Uses Turath's public HTTP API directly; no fetch, DOM, storage, or external deps.

const API = "https://api.turath.io";
const API_VERSION = 3;
const PAGE_SIZE_HINT = 24;
const SEARCH_PAGE_SIZE = 20;
const MAX_SECTION_PAGES = 40;
const MAX_PAGE_FETCH_CONCURRENCY = 6;

function apiUrl(path, params = {}) {
  const url = new URL(API + path);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function getJson(path, params = {}) {
  const res = await harbor.http(apiUrl(path, params), {
    responseType: "text",
    headers: { Accept: "application/json" },
    timeoutMs: 20000,
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${path}`);
  }
  try {
    return JSON.parse(res.body);
  } catch {
    throw new Error(`Invalid JSON from ${path}`);
  }
}

function cleanText(value) {
  return String(value || "")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseMeta(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return {}; }
}

function encodeId(obj) {
  return encodeURIComponent(JSON.stringify(obj));
}

function decodeId(value) {
  return JSON.parse(decodeURIComponent(value));
}

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function uniqueByBook(hits) {
  const seen = new Set();
  const out = [];
  for (const hit of hits || []) {
    const id = Number(hit?.book_id);
    if (!Number.isFinite(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(hit);
  }
  return out;
}

async function bookSummary(bookId, fallback = {}) {
  try {
    const book = await getJson("/book", {
      id: bookId,
      include: "indexes",
      ver: API_VERSION,
    });
    const meta = book?.meta || {};
    const indexes = book?.indexes || {};
    const volumes = Array.isArray(indexes.volumes) ? indexes.volumes : [];
    const bounds = indexes.volume_bounds || {};
    const boundValues = Object.values(bounds).flatMap((v) => Array.isArray(v) ? v : []);
    const maxPage = boundValues.length ? Math.max(...boundValues.map(Number).filter(Number.isFinite)) : undefined;
    return {
      id: String(bookId),
      title: cleanText(meta.name || fallback.title || `كتاب ${bookId}`),
      author: cleanText(fallback.author || "") || undefined,
      description: cleanText(meta.info_long || meta.info || "") || undefined,
      volumes: volumes.length || undefined,
      chapters: Array.isArray(indexes.headings) ? indexes.headings.length || undefined : undefined,
      genres: fallback.category ? [fallback.category] : undefined,
      originalLanguage: "ar",
      status: "completed",
      score: undefined,
      tags: ["عربي", "تراث", "Turath"],
      // Useful internal hints for the chapters() method.
      _pageCount: maxPage,
    };
  } catch {
    return {
      id: String(bookId),
      title: cleanText(fallback.title || `كتاب ${bookId}`),
      author: cleanText(fallback.author || "") || undefined,
      originalLanguage: "ar",
      tags: ["عربي", "Turath"],
    };
  }
}

async function searchBooks(query, page) {
  const data = await getJson("/search", {
    q: query,
    page,
    ver: API_VERSION,
  });
  return data?.data || [];
}

async function buildSearchResults(query, offset) {
  const requestedPage = Math.floor(offset / SEARCH_PAGE_SIZE) + 1;
  const pagesToRead = 3;
  const hits = [];
  for (let p = requestedPage; p < requestedPage + pagesToRead; p++) {
    const rows = await searchBooks(query, p);
    hits.push(...rows);
    if (!rows.length) break;
  }

  const unique = uniqueByBook(hits).slice(0, PAGE_SIZE_HINT);
  const results = [];
  for (const hit of unique) {
    const meta = parseMeta(hit?.meta);
    results.push(await bookSummary(hit.book_id, {
      title: meta.name || meta.title,
      author: meta.author_name || meta.author,
      category: meta.category_name,
    }));
  }
  return results;
}

async function fetchPages(bookId, start, end) {
  const pages = [];
  let next = start;
  while (next <= end) {
    const batch = [];
    while (next <= end && batch.length < MAX_PAGE_FETCH_CONCURRENCY) {
      batch.push(next++);
    }
    const responses = await Promise.all(batch.map(async (pg) => {
      try {
        const data = await getJson("/page", {
          book_id: bookId,
          pg,
          ver: API_VERSION,
        });
        return { pg, text: cleanText(data?.text || "") };
      } catch {
        return { pg, text: "" };
      }
    }));
    for (const item of responses.sort((a, b) => a.pg - b.pg)) {
      if (item.text) pages.push(item);
    }
  }
  return pages;
}

const plugin = {
  id: "turath-arabic",
  name: "Turath Arabic Books",

  async popular(offset) {
    // The Turath API is search-oriented rather than exposing a stable popular-books feed.
    // Use broad Arabic queries to populate Harbor's home list with real Arabic books.
    const seeds = ["الله", "كتاب", "الإسلام", "العلم"];
    const seed = seeds[Math.floor(offset / PAGE_SIZE_HINT) % seeds.length];
    return buildSearchResults(seed, offset);
  },

  async search(query, offset) {
    const q = cleanText(query);
    if (!q) return this.popular(offset);
    return buildSearchResults(q, offset);
  },

  async detail(id) {
    const bookId = Number(id);
    if (!Number.isFinite(bookId)) return null;

    const book = await getJson("/book", {
      id: bookId,
      include: "indexes",
      ver: API_VERSION,
    });
    if (!book?.meta) return null;

    const meta = book.meta;
    const indexes = book.indexes || {};
    const headings = Array.isArray(indexes.headings) ? indexes.headings : [];
    const volumeNames = Array.isArray(indexes.volumes) ? indexes.volumes : [];
    const bounds = indexes.volume_bounds || {};
    const boundValues = Object.values(bounds).flatMap((v) => Array.isArray(v) ? v : []);

    return {
      id: String(bookId),
      title: cleanText(meta.name || String(bookId)),
      description: cleanText(meta.info_long || meta.info || "") || undefined,
      author: meta.author_name || undefined,
      chapters: headings.length || undefined,
      volumes: volumeNames.length || undefined,
      originalLanguage: "ar",
      genres: ["كتب عربية", "تراث إسلامي"],
      status: "completed",
      // Keep opaque source identifiers intact.
      wikidataId: undefined,
      isbn: undefined,
      _volumeBounds: bounds,
      _maxPage: boundValues.length ? Math.max(...boundValues.map(Number).filter(Number.isFinite)) : undefined,
      _headings: headings,
    };
  },

  async chapters(id) {
    const bookId = Number(id);
    if (!Number.isFinite(bookId)) return [];

    const book = await getJson("/book", {
      id: bookId,
      include: "indexes",
      ver: API_VERSION,
    });
    if (!book?.indexes) return [];

    const indexes = book.indexes;
    const headings = Array.isArray(indexes.headings) ? indexes.headings : [];
    const bounds = indexes.volume_bounds || {};
    const maxPage = Object.values(bounds).flatMap((v) => Array.isArray(v) ? v : [])
      .map(Number)
      .filter(Number.isFinite)
      .reduce((a, b) => Math.max(a, b), 0);

    const chapterRows = [];

    if (headings.length) {
      for (let i = 0; i < headings.length; i++) {
        const h = headings[i] || {};
        const start = Number(h.page);
        if (!Number.isFinite(start) || start < 1) continue;

        let end = maxPage || start;
        for (let j = i + 1; j < headings.length; j++) {
          const candidate = Number(headings[j]?.page);
          if (Number.isFinite(candidate) && candidate > start) {
            end = candidate - 1;
            break;
          }
        }
        end = Math.min(end, start + MAX_SECTION_PAGES - 1);

        chapterRows.push({
          id: encodeId({ bookId, start, end }),
          chapter: String(i + 1),
          position: i,
          title: cleanText(h.title || `صفحة ${start}`),
          volume: undefined,
          volumeTitle: undefined,
          pages: Math.max(1, end - start + 1),
          language: "ar",
        });
      }
    }

    if (!chapterRows.length && maxPage > 0) {
      let index = 0;
      for (let start = 1; start <= maxPage; start += MAX_SECTION_PAGES) {
        const end = Math.min(maxPage, start + MAX_SECTION_PAGES - 1);
        chapterRows.push({
          id: encodeId({ bookId, start, end }),
          chapter: String(++index),
          position: index - 1,
          title: `صفحات ${start}–${end}`,
          pages: end - start + 1,
          language: "ar",
        });
      }
    }

    return chapterRows;
  },

  async content(chapterId) {
    const payload = decodeId(chapterId);
    const bookId = Number(payload?.bookId);
    const start = Number(payload?.start);
    const end = Number(payload?.end);
    if (!Number.isFinite(bookId) || !Number.isFinite(start) || !Number.isFinite(end)) {
      throw new Error("Invalid Turath chapter id");
    }

    const pages = await fetchPages(bookId, start, Math.min(end, start + MAX_SECTION_PAGES - 1));
    return pages.map((p) => p.text).filter(Boolean).join("\n\n");
  },

  async tags() {
    return [
      { id: "lang:ar", name: "العربية", group: "اللغة" },
      { id: "type:classical", name: "التراث الإسلامي", group: "النوع" },
    ];
  },
};
