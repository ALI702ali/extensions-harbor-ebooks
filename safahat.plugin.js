// Harbor eBook source: Safahat Arabic Books
// Scrapes the public Safahat/Hindawi HTML catalog using Harbor HTTP + HTML parsing.
// No external dependencies, fetch(), DOM globals, or storage.

const BASE = "https://www.safahat.org";
const SOURCE_PAGE_SIZE = 20;
const HARBOR_PAGE_SIZE = 48;

function abs(url) {
  if (!url) return undefined;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("//")) return "https:" + url;
  if (url.startsWith("/")) return BASE + url;
  return BASE + "/" + url;
}

async function requestText(url, options = {}) {
  const res = await harbor.http(url, {
    responseType: "text",
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "ar,en;q=0.8",
      ...(options.headers || {}),
    },
    ...options,
  });
  if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
  return res.body;
}

async function getDoc(pathOrUrl) {
  const url = /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : abs(pathOrUrl);
  return harbor.parseHtml(await requestText(url));
}

async function searchDoc(query) {
  const body = "keyword=" + encodeURIComponent(query);
  return harbor.parseHtml(
    await requestText(BASE + "/layout/search/", {
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }),
  );
}

function clean(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanTitle(value) {
  return clean(value)
    .replace(/^كتاب بعنوان\s*/u, "")
    .replace(/^كتاب\s+بعنوان\s*/u, "")
    .trim();
}

function bookIdFromHref(href) {
  const m = String(href || "").match(/^\/books\/(\d+)\/$/);
  return m ? m[1] : null;
}

function chapterPathFromHref(href, id) {
  const value = String(href || "");
  const prefix = "/books/" + id + "/";
  if (!value.startsWith(prefix)) return null;

  let tail = value.slice(prefix.length).split(/[?#]/)[0];
  tail = tail.replace(/^\\/+/, "").replace(/\\/+$/, "");
  if (!tail || tail.includes("/")) return null;

  return prefix + tail + "/";
}

function extractBookSummary(link) {
  const href = link.attr("href") || "";
  const id = bookIdFromHref(href);
  if (!id) return null;

  const img = link.querySelector("img");
  const alt = img?.attr("alt") || "";
  const explicitTitle =
    link.querySelector(".title")?.text() ||
    link.querySelector(".bookTitle")?.text() ||
    link.attr("title") ||
    "";
  const title = cleanTitle(
    explicitTitle ||
      alt.replace(/^كتاب بعنوان\s*/u, "") ||
      link.text(),
  );

  return {
    id,
    title: title || ("كتاب " + id),
    cover: abs(img?.attr("data-src") || img?.attr("src")),
    originalLanguage: "ar",
    _url: abs(href),
  };
}

function parseBookList(doc) {
  const byId = new Map();
  for (const link of doc.querySelectorAll('a[href^="/books/"]')) {
    const item = extractBookSummary(link);
    if (!item) continue;

    const old = byId.get(item.id);
    if (!old || (!old.cover && item.cover) || old.title.startsWith("كتاب ")) {
      byId.set(item.id, old ? { ...old, ...item } : item);
    }
  }

  return [...byId.values()].map(({ _url, ...book }) => book);
}

function findNextUrl(doc) {
  for (const a of doc.querySelectorAll("a")) {
    const rel = (a.attr("rel") || "").toLowerCase();
    const text = clean(a.text());
    if (
      rel.split(/\s+/).includes("next") ||
      /^(التالي|التالية|»|›|)$/u.test(text) ||
      /التالي/u.test(text)
    ) {
      const href = a.attr("href");
      if (href) return abs(href);
    }
  }
  return undefined;
}

function detailFromDoc(doc, id) {
  const titleNode =
    doc.querySelector(".details h2") ||
    doc.querySelector("article.book h2") ||
    doc.querySelector("h1") ||
    doc.querySelector("h2");

  const authorNode =
    doc.querySelector(".author a") ||
    doc.querySelector("article.book .author a") ||
    doc.querySelector(".author");

  const coverNode =
    doc.querySelector(".cover img") ||
    doc.querySelector("article.book img");

  const categories = doc
    .querySelectorAll(".tags a")
    .map((x) => clean(x.text()))
    .filter(Boolean);

  const descriptionCandidates = [
    doc.querySelector(".content"),
    doc.querySelector("article.book .content"),
    doc.querySelector(".details .content"),
  ].filter(Boolean);

  let description = "";
  for (const node of descriptionCandidates) {
    const text = clean(node.text());
    if (text.length > description.length) description = text;
  }

  const epubNode =
    doc.querySelector("#epub[href]") ||
    doc.querySelector('a[href$=".epub"]');

  const pdfNode = doc.querySelector('a[href$=".pdf"]');

  const wordText = doc
    .querySelector(".tags span")
    ?.text();

  return {
    id,
    title: cleanTitle(titleNode?.text() || id),
    author: clean(authorNode?.text()) || undefined,
    cover: abs(coverNode?.attr("src") || coverNode?.attr("data-src")),
    description: description || undefined,
    genres: categories,
    originalLanguage: "ar",
    chapters: undefined,
    _wordCount: clean(wordText) || undefined,
    _epub: abs(epubNode?.attr("href")),
    _pdf: abs(pdfNode?.attr("href")),
  };
}

function sanitizeDetail(detail) {
  const { _wordCount, _epub, _pdf, ...publicDetail } = detail;
  const extras = [];
  if (_wordCount) extras.push("عدد الكلمات: " + _wordCount);
  if (_epub) extras.push("EPUB متاح من المصدر");
  if (_pdf) extras.push("PDF متاح من المصدر");

  if (extras.length) {
    publicDetail.description = [publicDetail.description, extras.join(" • ")]
      .filter(Boolean)
      .join("\n\n");
  }
  return publicDetail;
}

function listingPathForPage(sectionPath, page) {
  if (page <= 1) return sectionPath;
  return sectionPath.replace(/\/$/, "") + "/" + page + "/";
}

async function collectListing(sectionPath, offset) {
  let page = Math.floor(offset / SOURCE_PAGE_SIZE) + 1;
  let skip = offset % SOURCE_PAGE_SIZE;
  const out = [];

  while (out.length < HARBOR_PAGE_SIZE) {
    const doc = await getDoc(listingPathForPage(sectionPath, page));
    const items = parseBookList(doc);

    if (!items.length) break;

    for (let i = skip; i < items.length && out.length < HARBOR_PAGE_SIZE; i++) {
      out.push(items[i]);
    }
    skip = 0;

    if (out.length >= HARBOR_PAGE_SIZE) break;

    const next = findNextUrl(doc);
    if (!next) break;

    page += 1;
  }

  return out;
}

async function collectSearch(query, offset) {
  let doc = await searchDoc(query);
  let skip = offset;
  const out = [];
  let guard = 0;

  while (guard++ < 40 && out.length < HARBOR_PAGE_SIZE) {
    const items = parseBookList(doc);
    if (!items.length) break;

    const start = Math.min(skip, items.length);
    for (let i = start; i < items.length && out.length < HARBOR_PAGE_SIZE; i++) {
      out.push(items[i]);
    }
    skip = Math.max(0, skip - items.length);

    if (out.length >= HARBOR_PAGE_SIZE) break;

    const next = findNextUrl(doc);
    if (!next) break;

    doc = await getDoc(next);
  }

  return out;
}

async function chaptersForBook(id) {
  const doc = await getDoc("/books/" + id + "/");
  const seen = new Set();
  const chapters = [];

  for (const a of doc.querySelectorAll('a[href^="/books/"]')) {
    const href = a.attr("href") || "";
    const path = chapterPathFromHref(href, id);
    if (!path || seen.has(path)) continue;

    const title = clean(a.text());
    if (!title || /^(الرجوع إلى الصفحة الرئيسية للكتاب|Safahat)$/u.test(title)) continue;

    seen.add(path);
    chapters.push({
      id: path.slice(1),
      chapter: path.split("/").filter(Boolean).pop(),
      position: chapters.length,
      title,
      pages: 0,
      language: "ar",
      volume: undefined,
    });
  }

  return chapters;
}

function textFromSelector(doc, selector) {
  const chunks = doc
    .querySelectorAll(selector)
    .map((node) => clean(node.text()))
    .filter(Boolean);
  return chunks.join("\n\n");
}

async function contentForChapter(chapterId) {
  const doc = await getDoc("/" + chapterId);

  const candidates = [
    "article p, article blockquote, article h1, article h2, article h3",
    ".content p, .content blockquote, .content h1, .content h2, .content h3",
    ".chapter p, .chapter blockquote, .chapter h1, .chapter h2, .chapter h3",
    "main p, main blockquote, main h1, main h2, main h3",
  ];

  let best = "";
  for (const selector of candidates) {
    const text = textFromSelector(doc, selector);
    if (text.length > best.length) best = text;
  }

  if (best) return best;

  const article = doc.querySelector("article") || doc.querySelector("main");
  return clean(article?.text() || "");
}

const plugin = {
  id: "safahat-arabic",
  name: "Safahat Arabic Books",

  async popular(offset, tagId) {
    const sectionPath =
      tagId?.startsWith("cat:")
        ? decodeURIComponent(tagId.slice(4))
        : "/books/";

    return collectListing(sectionPath, Number(offset) || 0);
  },

  async search(query, offset) {
    const q = clean(query);
    if (!q) return [];
    return collectSearch(q, Number(offset) || 0);
  },

  async detail(id) {
    const doc = await getDoc("/books/" + id + "/");
    return sanitizeDetail(detailFromDoc(doc, String(id)));
  },

  async chapters(id) {
    return chaptersForBook(String(id));
  },

  async content(chapterId) {
    return contentForChapter(String(chapterId));
  },

  async tags() {
    const doc = await getDoc("/books/");
    const tags = [];
    const seen = new Set();

    for (const a of doc.querySelectorAll('a[href^="/books/categories/"]')) {
      const href = a.attr("href");
      const name = clean(a.text());
      if (!href || !name || seen.has(href)) continue;
      seen.add(href);
      tags.push({
        id: "cat:" + encodeURIComponent(href),
        name,
        group: "التصنيفات",
      });
    }

    return tags;
  },
};
