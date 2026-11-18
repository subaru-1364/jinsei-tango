// ==================== 外部公開API連携（書籍検索・書影・辞書） (api.js) ====================
// ※ 規約準拠：すべてAPIキー不要・従量課金なしの無料公開エンドポイントのみ使用

// ==================== ISBN 正規化・変換 ====================

function normalizeIsbnInput(str) {
    if (!str) return "";
    var half = String(str).replace(/[０-９]/g, function(ch) {
        return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
    }).replace(/[－ー―‐]/g, "-");
    var digitsOnly = half.replace(/[-\s]/g, "").toUpperCase();
    if (/^\d{9}[\dX]$/.test(digitsOnly) || /^\d{13}$/.test(digitsOnly)) {
        return digitsOnly;
    }
    return "";
}

// 10桁ISBN（ISBN-10）を13桁ISBN（ISBN-13）へ変換（openBD照会率向上用）
function toIsbn13(isbn) {
    var clean = normalizeIsbnInput(isbn);
    if (!clean) return "";
    if (clean.length === 13) return clean;
    if (clean.length !== 10) return clean;
    var base = "978" + clean.slice(0, 9);
    var sum = 0;
    for (var i = 0; i < 12; i++) {
        var digit = parseInt(base.charAt(i), 10);
        if (isNaN(digit)) return clean;
        sum += (i % 2 === 0) ? digit : (digit * 3);
    }
    var check = (10 - (sum % 10)) % 10;
    return base + String(check);
}

function extractIsbnsFromText(rawText) {
    var list = [];
    if (!rawText) return list;
    var cleaned = rawText.replace(/\x7b\x7bISBN2?\|/gi, "ISBN ");
    var regex = /(?:ISBN(?:-1[03])?[:：\s]*)?(97[89][-\s0-9]{10,16}|[0-9]{9}[0-9Xx]|4-[-\s0-9]{8,12}[0-9Xx])/g;
    var m;
    while ((m = regex.exec(cleaned)) !== null) {
        var norm = toIsbn13(m[1]) || normalizeIsbnInput(m[1]);
        if (norm && list.indexOf(norm) === -1) {
            list.push(norm);
        }
        if (list.length >= 4) break;
    }
    return list;
}

// ==================== 書影URL抽出ヘルパー ====================

function extractCoverFromOpenBdEntry(entry) {
    if (!entry) return "";
    if (entry.summary && entry.summary.cover) {
        var cov = sanitizeCoverUrl(entry.summary.cover);
        if (cov) return cov;
    }
    try {
        var onix = entry.onix;
        if (onix && onix.CollateralDetail && Array.isArray(onix.CollateralDetail.SupportingResource)) {
            var resList = onix.CollateralDetail.SupportingResource;
            for (var i = 0; i < resList.length; i++) {
                var r = resList[i];
                if (r.ResourceVersion && Array.isArray(r.ResourceVersion)) {
                    for (var j = 0; j < r.ResourceVersion.length; j++) {
                        var rv = r.ResourceVersion[j];
                        if (rv.ResourceLink) {
                            var link = sanitizeCoverUrl(rv.ResourceLink);
                            if (link) return link;
                        }
                    }
                }
            }
        }
    } catch (e) {}
    return "";
}

function extractThumbFromGoogleBooksItems(items) {
    if (!Array.isArray(items)) return "";
    for (var i = 0; i < items.length; i++) {
        var vi = items[i] && items[i].volumeInfo;
        if (vi && vi.imageLinks) {
            var rawThumb = vi.imageLinks.thumbnail || vi.imageLinks.smallThumbnail || "";
            if (rawThumb) {
                var safe = sanitizeCoverUrl(rawThumb);
                if (safe) return safe;
            }
        }
    }
    return "";
}

// ==================== 書籍検索・書影取得 API (openBD / Google Books / Wikipedia) ====================

function lookupBookByIsbnApi(isbn) {
    var isbn13 = toIsbn13(isbn) || isbn;
    var openBdQuery = (isbn13 !== isbn) ? (isbn13 + "," + isbn) : isbn13;

    var openBdPromise = fetch("https://api.openbd.jp/v1/get?isbn=" + encodeURIComponent(openBdQuery))
        .then(function(res) { return res.ok ? res.json() : null; })
        .catch(function() { return null; });

    var googleBooksPromise = fetch("https://www.googleapis.com/books/v1/volumes?q=isbn:" + encodeURIComponent(isbn13) + "&maxResults=5")
        .then(function(res) { return res.ok ? res.json() : null; })
        .catch(function() { return null; });

    return Promise.all([openBdPromise, googleBooksPromise]).then(function(results) {
        var openBdArr = results[0];
        var gData = results[1];

        var title = "";
        var author = "";
        var cover = "";

        if (Array.isArray(openBdArr)) {
            for (var i = 0; i < openBdArr.length; i++) {
                if (openBdArr[i]) {
                    var s = openBdArr[i].summary || {};
                    if (!title && s.title) title = s.title;
                    if (!author && s.author) author = s.author;
                    if (!cover) {
                        cover = extractCoverFromOpenBdEntry(openBdArr[i]);
                    }
                }
            }
        }

        if (gData && Array.isArray(gData.items) && gData.items.length > 0) {
            var vi = gData.items[0].volumeInfo || {};
            if (!title && vi.title) title = vi.title;
            if (!author && Array.isArray(vi.authors)) author = vi.authors.join(", ");
            if (!cover) {
                cover = extractThumbFromGoogleBooksItems(gData.items);
            }
        }

        var fallbackQuery = title + (author ? (" " + author) : "");
        var coverFallbackPromise = (!cover && title)
            ? fetch("https://www.googleapis.com/books/v1/volumes?q=" + encodeURIComponent(fallbackQuery) + "&langRestrict=ja&maxResults=10")
                .then(function(r) { return r.ok ? r.json() : null; })
                .then(function(d) {
                    return (d && d.items) ? extractThumbFromGoogleBooksItems(d.items) : "";
                })
                .catch(function() { return ""; })
            : Promise.resolve(cover);

        return coverFallbackPromise.then(function(finalCover) {
            if (finalCover) {
                cover = finalCover;
                bookCoverCache[isbn] = cover;
                bookCoverCache[isbn13] = cover;
            }
            if (title) {
                return { title: title, author: author, cover: cover };
            }
            return null;
        });
    });
}

function searchBookViaWikipediaAndOpenBd(keyword) {
    var searchUrl = "https://ja.wikipedia.org/w/api.php?action=query&list=search&srsearch=" +
                    encodeURIComponent(keyword) + "&srlimit=5&format=json&origin=*";
    return fetch(searchUrl)
        .then(function(res) { return res.json(); })
        .then(function(sData) {
            var titles = [];
            if (sData && sData.query && Array.isArray(sData.query.search)) {
                sData.query.search.forEach(function(item) {
                    if (item.title && titles.indexOf(item.title) === -1) {
                        titles.push(item.title);
                    }
                });
            }
            if (titles.indexOf(keyword) === -1) {
                titles.unshift(keyword);
            }
            var tParam = titles.slice(0, 5).map(function(t) { return encodeURIComponent(t); }).join("|");
            var revUrl = "https://ja.wikipedia.org/w/api.php?action=query&prop=revisions&rvprop=content&redirects=1&titles=" +
                         tParam + "&format=json&origin=*";
            return fetch(revUrl).then(function(r) { return r.json(); });
        })
        .then(function(revData) {
            var isbns = [];
            var fallbackAuthor = "";
            var fallbackTitle = "";
            if (revData && revData.query && revData.query.pages) {
                var pages = revData.query.pages;
                Object.keys(pages).forEach(function(pid) {
                    var p = pages[pid];
                    if (pid === "-1" || !p.revisions || !p.revisions[0]) return;
                    var rev = p.revisions[0];
                    var wt = rev["*"] || (rev.slots && rev.slots.main && rev.slots.main["*"]) || "";
                    if (!wt) return;
                    if (p.title !== keyword && wt.indexOf(keyword) === -1) return;

                    if (!fallbackTitle) {
                        fallbackTitle = (p.title === keyword) ? p.title : keyword;
                    }

                    var authMatch = wt.match(/\|\s*(?:著者|作者|author)\s*=\s*([^\n|]+)/);
                    if (authMatch && !fallbackAuthor) {
                        fallbackAuthor = cleanWikitextMarkup(authMatch[1]);
                    } else if (!fallbackAuthor && p.title !== keyword) {
                        var isWriterPage = /小説家|作家|文学者|著作家|随筆家/.test(wt.slice(0, 800));
                        if (isWriterPage) {
                            fallbackAuthor = p.title;
                        }
                    }

                    var searchPos = 0;
                    while (searchPos < wt.length && isbns.length < 4) {
                        var kwIdx = wt.indexOf(keyword, searchPos);
                        if (kwIdx === -1) break;
                        var lineWindow = wt.slice(Math.max(0, kwIdx - 80), kwIdx + 600);
                        var found = extractIsbnsFromText(lineWindow);
                        found.forEach(function(code) {
                            if (isbns.indexOf(code) === -1 && isbns.length < 4) {
                                isbns.push(code);
                            }
                        });
                        searchPos = kwIdx + keyword.length;
                    }

                    if (isbns.length === 0 && p.title === keyword) {
                        var pageIsbns = extractIsbnsFromText(wt);
                        pageIsbns.forEach(function(code) {
                            if (isbns.indexOf(code) === -1 && isbns.length < 4) {
                                isbns.push(code);
                            }
                        });
                    }
                });
            }

            if (isbns.length === 0) {
                if (fallbackTitle) {
                    return [{
                        isbn: "",
                        title: fallbackTitle,
                        author: fallbackAuthor,
                        cover: ""
                    }];
                }
                return [];
            }

            var openBdUrl = "https://api.openbd.jp/v1/get?isbn=" + isbns.join(",");
            return fetch(openBdUrl)
                .then(function(r) { return r.json(); })
                .then(function(bdArr) {
                    var out = [];
                    if (Array.isArray(bdArr)) {
                        bdArr.forEach(function(entry, idx) {
                            var code = isbns[idx];
                            if (entry && entry.summary && entry.summary.title) {
                                var s = entry.summary;
                                var cover = extractCoverFromOpenBdEntry(entry);
                                if (cover && (s.isbn || code)) {
                                    bookCoverCache[s.isbn || code] = cover;
                                }
                                out.push({
                                    isbn: s.isbn || code,
                                    title: s.title,
                                    author: s.author || fallbackAuthor,
                                    cover: cover
                                });
                            }
                        });
                    }
                    if (out.length === 0 && isbns[0]) {
                        out.push({
                            isbn: isbns[0],
                            title: fallbackTitle || keyword,
                            author: fallbackAuthor,
                            cover: ""
                        });
                    }
                    return out;
                });
        })
        .catch(function() { return []; });
}

function searchBooksByTitleKeyword(keyword) {
    var kw = (keyword || "").trim();
    if (!kw) return Promise.resolve([]);

    var gbUrl = "https://www.googleapis.com/books/v1/volumes?q=" + encodeURIComponent(kw) + "&langRestrict=ja&maxResults=6";
    var gbPromise = fetch(gbUrl)
        .then(function(res) { return res.ok ? res.json() : null; })
        .then(function(data) {
            var list = [];
            if (data && Array.isArray(data.items)) {
                data.items.forEach(function(item) {
                    var vi = item.volumeInfo || {};
                    if (!vi.title) return;
                    var title = vi.title + (vi.subtitle ? (" " + vi.subtitle) : "");
                    var author = Array.isArray(vi.authors) ? vi.authors.join(", ") : "";
                    var foundIsbn = "";
                    if (Array.isArray(vi.industryIdentifiers)) {
                        vi.industryIdentifiers.forEach(function(idObj) {
                            if (idObj.type === "ISBN_13") {
                                foundIsbn = idObj.identifier;
                            } else if (idObj.type === "ISBN_10" && !foundIsbn) {
                                foundIsbn = idObj.identifier;
                            }
                        });
                    }
                    var thumb = "";
                    if (vi.imageLinks) {
                        thumb = sanitizeCoverUrl(vi.imageLinks.thumbnail || vi.imageLinks.smallThumbnail || "");
                    }
                    if (thumb && foundIsbn) {
                        bookCoverCache[foundIsbn] = thumb;
                    }
                    list.push({
                        isbn: foundIsbn,
                        title: title,
                        author: author,
                        cover: thumb
                    });
                });
            }
            return list;
        })
        .catch(function() { return []; });

    var wpBookPromise = searchBookViaWikipediaAndOpenBd(kw);

    return Promise.all([wpBookPromise, gbPromise]).then(function(results) {
        var wpList = results[0] || [];
        var gbList = results[1] || [];
        var merged = [];
        var seenKey = {};

        function addBookCand(c) {
            if (!c || !c.title) return;
            var normIsbn = c.isbn ? toIsbn13(c.isbn) : "";
            var k = normIsbn ? ("isbn:" + normIsbn) : ("title:" + c.title.replace(/\s+/g, ""));
            if (seenKey[k]) {
                var existing = seenKey[k];
                if (!existing.cover && c.cover) existing.cover = c.cover;
                if (!existing.author && c.author) existing.author = c.author;
                if (!existing.isbn && c.isbn) existing.isbn = c.isbn;
                return;
            }
            if (!c.cover && c.isbn) {
                c.cover = bookCoverCache[c.isbn] || bookCoverCache[normIsbn] || "";
            }
            seenKey[k] = c;
            merged.push(c);
        }

        wpList.forEach(function(wpItem) {
            if (!wpItem.cover) {
                for (var i = 0; i < gbList.length; i++) {
                    var gbItem = gbList[i];
                    if (gbItem.cover && (gbItem.title.indexOf(wpItem.title) !== -1 || wpItem.title.indexOf(gbItem.title) !== -1)) {
                        wpItem.cover = gbItem.cover;
                        break;
                    }
                }
            }
        });

        wpList.forEach(addBookCand);
        gbList.forEach(addBookCand);
        return merged.slice(0, 6);
    });
}

function fetchCoverUrlForBook(book) {
    if (!book) return Promise.resolve("");
    var isbn = (book.isbn || "").trim();
    var isbn13 = isbn ? (toIsbn13(isbn) || isbn) : "";
    var title = (book.title || "").trim();
    var author = (book.author || "").trim();

    var openBdQuery = (isbn13 && isbn13 !== isbn) ? (isbn13 + "," + isbn) : isbn13;
    var openBdPromise = openBdQuery
        ? fetch("https://api.openbd.jp/v1/get?isbn=" + encodeURIComponent(openBdQuery))
            .then(function(res) { return res.ok ? res.json() : null; })
            .then(function(arr) {
                if (!Array.isArray(arr)) return "";
                for (var i = 0; i < arr.length; i++) {
                    var cov = extractCoverFromOpenBdEntry(arr[i]);
                    if (cov) return cov;
                }
                return "";
            })
            .catch(function() { return ""; })
        : Promise.resolve("");

    return openBdPromise.then(function(openBdCover) {
        if (openBdCover) return openBdCover;

        var gbQuery = isbn13
            ? ("isbn:" + encodeURIComponent(isbn13) + "&maxResults=5")
            : (encodeURIComponent(title + (author ? (" " + author) : "")) + "&langRestrict=ja&maxResults=10");
        var gbUrl = "https://www.googleapis.com/books/v1/volumes?q=" + gbQuery;
        return fetch(gbUrl)
            .then(function(r) { return r.ok ? r.json() : null; })
            .then(function(d) {
                var t = (d && d.items) ? extractThumbFromGoogleBooksItems(d.items) : "";
                if (t) return t;

                if (isbn13 && title) {
                    var fallbackQuery = title + (author ? (" " + author) : "");
                    var titleGbUrl = "https://www.googleapis.com/books/v1/volumes?q=" + encodeURIComponent(fallbackQuery) + "&langRestrict=ja&maxResults=10";
                    return fetch(titleGbUrl)
                        .then(function(r2) { return r2.ok ? r2.json() : null; })
                        .then(function(d2) {
                            return (d2 && d2.items) ? extractThumbFromGoogleBooksItems(d2.items) : "";
                        });
                }
                return "";
            })
            .catch(function() { return ""; });
    });
}

// ==================== Wiktionary / Wikipedia 意味取得 API ====================

function extractSearchTerms(rawWord) {
    var terms = [];
    var s = (rawWord || "").trim();
    if (!s) return terms;

    var parenMatches = s.match(/[（\x28]([^）\x29]+)[）\x29]/g);
    var withoutParens = s.replace(/[（\x28][^）\x29]+[）\x29]/g, " ").trim();

    var parts = withoutParens.split(/[\s　]+/).filter(Boolean);
    parts.forEach(function(p) {
        if (terms.indexOf(p) === -1) terms.push(p);
    });

    if (parenMatches) {
        parenMatches.forEach(function(pm) {
            var inner = pm.slice(1, -1).trim();
            if (inner && terms.indexOf(inner) === -1) terms.push(inner);
        });
    }

    if (terms.indexOf(s) === -1) {
        terms.push(s);
    }

    return terms;
}

function cleanWikitextMarkup(str) {
    if (!str) return "";
    var s = str;
    s = s.replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, "").replace(/<ref[^>]*\/>/gi, "");
    s = s.replace(/<!--[\s\S]*?-->/g, "");
    s = s.replace(/\{\{ruby\|([^|\x7d]+)\|([^|\x7d]+)[^\x7d]*\}\}/gi, "$1（$2）");
    while (/\{\{[^\x7b\x7d]*\}\}/.test(s)) {
        s = s.replace(/\{\{[^\x7b\x7d]*\}\}/g, "");
    }
    s = s.replace(/\[\[(?:[^|\]]+\|)?([^\]]+)\]\]/g, "$1");
    s = s.replace(/'''+/g, "").replace(/''/g, "");
    s = s.replace(/<[^>]+>/g, "");
    return s.replace(/\s+/g, " ").trim();
}

function parseWiktionaryWikitext(wikitext, targetWord) {
    var results = [];
    var readings = [];
    var lines = wikitext.split("\n");
    var inMeaningSection = false;

    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line) continue;

        if (/^=+.*=+$/.test(line)) {
            inMeaningSection = /意義|意味|名詞|動詞|形容詞|形容動詞|副詞|成句|ことわざ/.test(line);
            continue;
        }

        if (/^\*\s*(音読み|訓読み)\s*[:：]/.test(line)) {
            var rClean = cleanWikitextMarkup(line.replace(/^\*\s*/, ""));
            if (rClean && readings.length < 2) {
                readings.push(rClean);
            }
            continue;
        }

        if (/^#(?![:*#])/.test(line) || (inMeaningSection && /^\*(?![:*])/.test(line))) {
            var body = line.replace(/^[#*]+\s*/, "");
            var cleaned = cleanWikitextMarkup(body);
            if (cleaned && cleaned.length >= 2 && cleaned !== targetWord) {
                if (cleaned.length > 85) {
                    cleaned = cleaned.slice(0, 84) + "…";
                }
                results.push(cleaned);
                if (results.length >= 3) break;
            }
        }
    }

    if (readings.length > 0 && targetWord.length === 1) {
        var readingStr = "【" + readings.join(" / ") + "】";
        if (results.length > 0 && results[0].indexOf("読み") === -1) {
            results[0] = readingStr + " " + results[0];
        } else if (results.length === 0) {
            results.push(readingStr);
        }
    }

    return results;
}

function cleanWikipediaSummary(extractText) {
    if (!extractText) return "";
    var text = extractText.replace(/（[^）]{1,60}）/g, "").replace(/\([^\x29]{1,60}\)/g, "").trim();
    var firstSentence = text.split("。")[0];
    if (!firstSentence) return "";
    var match = firstSentence.match(/^.{1,25}?(?:とは、?|は、)\s*(.*)$/);
    if (match && match[1].trim().length >= 4) {
        firstSentence = match[1].trim();
    }
    var result = firstSentence + "。";
    if (result.length > 85) {
        result = result.slice(0, 84) + "…";
    }
    return result;
}

function fetchWiktionaryDefinitionsByTitles(titlesList, requiredReading) {
    if (!titlesList || titlesList.length === 0) return Promise.resolve([]);
    var titlesParam = titlesList.slice(0, 8).map(function(t) { return encodeURIComponent(t); }).join("|");
    var wiktRevUrl = "https://ja.wiktionary.org/w/api.php?action=query&prop=revisions&rvprop=content&redirects=1&titles=" +
                     titlesParam + "&format=json&origin=*";
    var found = [];
    return fetch(wiktRevUrl)
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (data && data.query && data.query.pages) {
                var pages = data.query.pages;
                Object.keys(pages).forEach(function(pid) {
                    var page = pages[pid];
                    if (pid !== "-1" && page.revisions && page.revisions[0]) {
                        var rev = page.revisions[0];
                        var rawWikitext = rev["*"] || (rev.slots && rev.slots.main && rev.slots.main["*"]) || "";
                        if (rawWikitext) {
                            if (requiredReading && rawWikitext.indexOf(requiredReading) === -1) {
                                return;
                            }
                            var defs = parseWiktionaryWikitext(rawWikitext, page.title || "");
                            defs.forEach(function(d) {
                                if (found.indexOf(d) === -1 && found.length < 4) {
                                    found.push(d);
                                }
                            });
                        }
                    }
                });
            }
            return found;
        })
        .catch(function() { return found; });
}

function fetchWordMeaningCandidates(word) {
    var cleanW = (word || "").trim();
    if (!cleanW) return Promise.resolve([]);
    if (meaningCandidatesCache[cleanW]) {
        return Promise.resolve(meaningCandidatesCache[cleanW]);
    }

    var searchTerms = extractSearchTerms(cleanW);
    var candidates = [];

    function addCandidate(text) {
        if (text && candidates.indexOf(text) === -1 && candidates.length < 4) {
            candidates.push(text);
        }
    }

    return fetchWiktionaryDefinitionsByTitles(searchTerms, "")
        .then(function(defs) {
            defs.forEach(addCandidate);
        })
        .then(function() {
            if (candidates.length >= 2) return;
            var primaryTerm = searchTerms[0] || cleanW;
            if (!/^[ぁ-んー]{2,}$/.test(primaryTerm)) return;
            var wiktSearchUrl = "https://ja.wiktionary.org/w/api.php?action=query&list=search&srsearch=" +
                                encodeURIComponent("\"" + primaryTerm + "\"") + "&srlimit=3&format=json&origin=*";
            return fetch(wiktSearchUrl)
                .then(function(res) { return res.json(); })
                .then(function(sData) {
                    if (sData && sData.query && sData.query.search && sData.query.search.length > 0) {
                        var hitTitles = [];
                        sData.query.search.forEach(function(item) {
                            if (item.title && searchTerms.indexOf(item.title) === -1) {
                                hitTitles.push(item.title);
                            }
                        });
                        if (hitTitles.length > 0) {
                            return fetchWiktionaryDefinitionsByTitles(hitTitles, primaryTerm).then(function(moreDefs) {
                                moreDefs.forEach(addCandidate);
                            });
                        }
                    }
                })
                .catch(function() {});
        })
        .then(function() {
            if (candidates.length >= 3) {
                meaningCandidatesCache[cleanW] = candidates;
                return candidates;
            }
            var wikiChain = Promise.resolve();
            searchTerms.forEach(function(term) {
                wikiChain = wikiChain.then(function() {
                    if (candidates.length >= 3) return;
                    var wikiUrl = "https://ja.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(term);
                    return fetch(wikiUrl)
                        .then(function(res) {
                            if (!res.ok) return null;
                            return res.json();
                        })
                        .then(function(summary) {
                            if (summary && summary.extract && summary.type !== "disambiguation") {
                                var wikiDef = cleanWikipediaSummary(summary.extract);
                                addCandidate(wikiDef);
                            }
                        })
                        .catch(function() {});
                });
            });
            return wikiChain.then(function() {
                meaningCandidatesCache[cleanW] = candidates;
                return candidates;
            });
        });
}
