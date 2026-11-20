// ==================== データモデル(v2 JSON)・ローカル保存・Firebase同期 (storage.js) ====================

const LOCAL_STORAGE_V2_KEY = "kuji_data_v2";

let fbAuth = null;
let fbDb = null;
let currentUser = null;
let activeDbRef = null;
let cloudSaveTimer = null;
let cloudStateCache = null; // { isV2: boolean, booksJson: {}, wordsJson: {} }

// ==================== ID生成・正規化ヘルパー ====================

function sanitizeEntityId(rawId, fallbackPrefix) {
    var prefix = fallbackPrefix || "item";
    var cleaned = String(rawId || "")
        .trim()
        .replace(/[^A-Za-z0-9_-]/g, "_")
        .replace(/^_+|_+$/g, "");
    if (!cleaned) {
        cleaned = prefix + "_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6);
    }
    return cleaned;
}

function generateBookId(isbn) {
    if (isbn) {
        return sanitizeEntityId("book_" + isbn, "book");
    }
    return "book_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6);
}

// 旧テキストデータ移行時に複数端末間で同一単語が同じIDになる決定論的ID
function generateDeterministicWordId(word) {
    var norm = normalizeWordKey(word);
    var h1 = 0x811c9dc5;
    var h2 = 5381;
    for (var i = 0; i < norm.length; i++) {
        var c = norm.charCodeAt(i);
        h1 ^= c;
        h1 = Math.imul(h1, 0x01000193);
        h2 = ((h2 << 5) + h2) ^ c;
    }
    var hex1 = (h1 >>> 0).toString(16).padStart(8, "0");
    var hex2 = (h2 >>> 0).toString(16).padStart(8, "0");
    return "w_m" + hex1 + hex2;
}

function generateNewWordId() {
    return "w_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
}

function getNextWordOrder() {
    var maxOrder = 0;
    for (var i = 0; i < wordList.length; i++) {
        var ord = typeof wordList[i].order === "number" ? wordList[i].order : 0;
        if (ord > maxOrder) maxOrder = ord;
    }
    return maxOrder + 10;
}

function sanitizeBookCoverField(rawCover) {
    var raw = String(rawCover || "").trim();
    if (!raw) return "";
    if (/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(raw) || /^color:/i.test(raw)) {
        return raw.replace(/^color:/i, "").trim();
    }
    return sanitizeCoverUrl(raw);
}

function normalizeBookRecord(raw, fallbackIdx) {
    if (!raw || typeof raw !== "object") return null;
    var title = String(raw.title || "").trim() || "無題の書籍";
    var isbn = String(raw.isbn || "").trim();
    var id = sanitizeEntityId(raw.id || (isbn ? ("book_" + isbn) : ""), "book");
    var cover = sanitizeBookCoverField(raw.cover);
    if (cover) {
        bookCoverCache[id] = cover;
        if (isbn) bookCoverCache[isbn] = cover;
    }
    return {
        id: id,
        isbn: isbn,
        title: title,
        author: String(raw.author || "").trim(),
        cover: cover,
        pinned: Boolean(raw.pinned),
        order: typeof raw.order === "number" ? raw.order : (fallbackIdx * 10),
        createdAt: typeof raw.createdAt === "number" ? raw.createdAt : 0
    };
}

function normalizeWordRecord(raw, fallbackIdx) {
    if (!raw || typeof raw !== "object") return null;
    var word = String(raw.word || "").trim();
    if (!word) return null;
    var meaning = cleanMeaning(raw.meaning);
    var isAuto = Boolean(raw.isAutoMeaning || raw.isAuto);
    var noMeaning = Boolean(raw.noMeaningNeeded || raw.known);
    if (meaning) {
        noMeaning = false;
    } else {
        isAuto = false;
    }
    return {
        id: sanitizeEntityId(raw.id || generateDeterministicWordId(word), "w"),
        word: word,
        meaning: meaning,
        bookId: raw.bookId ? sanitizeEntityId(raw.bookId, "book") : "uncategorized",
        isAutoMeaning: isAuto,
        noMeaningNeeded: noMeaning,
        order: typeof raw.order === "number" ? raw.order : ((fallbackIdx + 1) * 10),
        createdAt: typeof raw.createdAt === "number" ? raw.createdAt : 0
    };
}

// ==================== 参照・検索・重複排除ヘルパー ====================

function getBookById(bookId) {
    if (!bookId || bookId === "uncategorized" || bookId === "all_books") return null;
    for (var i = 0; i < bookList.length; i++) {
        if (bookList[i].id === bookId) return bookList[i];
    }
    return null;
}

function getBookTitleById(bookId) {
    if (!bookId || bookId === "uncategorized") return "未分類";
    if (bookId === "all_books") return "すべての本";
    var b = getBookById(bookId);
    return b ? b.title : "未分類";
}

function getSourceTagText(bookId) {
    if (!bookId || bookId === "uncategorized") return "";
    var b = getBookById(bookId);
    return b ? b.title : "";
}

function getEffectiveBookIdForEdit() {
    if (currentBookTab === "all_books") return "uncategorized";
    return getBookById(currentBookTab) ? currentBookTab : "uncategorized";
}

// アプリ全体（すべての本）で単語がすでに登録されているかチェック
function findExistingWordLocation(targetWord, excludeWordId) {
    var cleanTarget = normalizeWordKey(targetWord);
    if (!cleanTarget) return null;

    for (var i = 0; i < wordList.length; i++) {
        var item = wordList[i];
        if (excludeWordId && item.id === excludeWordId) continue;
        if (normalizeWordKey(item.word) === cleanTarget) {
            return {
                id: item.id,
                bookId: item.bookId,
                bookTitle: getBookTitleById(item.bookId),
                item: item
            };
        }
    }
    return null;
}

// 本棚の整合性補正＋重複単語のクリーンアップ（意味あり・書籍所属を優先保持）
function deduplicateDataInPlace() {
    var changed = false;

    // 1. 本の重複ID排除と順序整理
    var validBookMap = {};
    var uniqueBooks = [];
    for (var bIdx = 0; bIdx < bookList.length; bIdx++) {
        var b = bookList[bIdx];
        if (!b || !b.id) continue;
        if (validBookMap[b.id]) {
            changed = true;
            continue;
        }
        validBookMap[b.id] = b;
        uniqueBooks.push(b);
    }
    bookList = uniqueBooks;

    // 2. 存在しないbookIdを持つ単語を未分類に保護＋単語重複排除
    var seenByNorm = {};
    var usedWordIds = {};

    for (var i = 0; i < wordList.length; i++) {
        var w = wordList[i];
        if (!w || !w.word) {
            changed = true;
            continue;
        }
        if (w.bookId !== "uncategorized" && !validBookMap[w.bookId]) {
            w.bookId = "uncategorized";
            changed = true;
        }

        var norm = normalizeWordKey(w.word);
        if (!norm) {
            changed = true;
            continue;
        }

        var hasInfo = Boolean((w.meaning && w.meaning.trim() !== "") || w.noMeaningNeeded);
        var inBook = (w.bookId !== "uncategorized");

        if (!seenByNorm[norm]) {
            seenByNorm[norm] = { item: w, hasInfo: hasInfo, inBook: inBook };
        } else {
            changed = true;
            var prev = seenByNorm[norm];
            if (!prev.hasInfo && hasInfo) {
                seenByNorm[norm] = { item: w, hasInfo: hasInfo, inBook: inBook };
            } else if (prev.hasInfo === hasInfo && !prev.inBook && inBook) {
                seenByNorm[norm] = { item: w, hasInfo: hasInfo, inBook: inBook };
            }
        }
    }

    var dedupedWords = [];
    Object.keys(seenByNorm).forEach(function(norm) {
        var item = seenByNorm[norm].item;
        if (usedWordIds[item.id]) {
            item.id = generateNewWordId();
            changed = true;
        }
        usedWordIds[item.id] = true;
        dedupedWords.push(item);
    });

    dedupedWords.sort(function(a, b) {
        return (a.order || 0) - (b.order || 0);
    });

    wordList = dedupedWords;

    // 3. 選択中タブが存在しない場合は "all_books" に戻す
    if (currentBookTab !== "all_books" && currentBookTab !== "uncategorized" && !validBookMap[currentBookTab]) {
        currentBookTab = "all_books";
        sessionStorage.setItem("kuji_book_tab", currentBookTab);
    }

    return changed;
}

// ==================== 旧形式(v1テキスト・チャンク)からのマイグレーション ====================

function isLegacyKnownMarker(str) {
    if (!str) return false;
    var s = str.trim();
    return s === "✓" || s === "✔" || s === "済" || s === "（意味不要）";
}

function loadLegacyLocalText() {
    var countStr = localStorage.getItem("kuji_chunk_count");
    if (countStr !== null) {
        var n = parseInt(countStr, 10) || 0;
        var parts = [];
        for (var i = 0; i < n; i++) {
            parts.push(localStorage.getItem("kuji_chunk_" + i) || "");
        }
        var joined = parts.join("\n").trim();
        if (joined) return joined;
    }

    var bulk = localStorage.getItem("kuji_bulk_text");
    if (bulk && bulk.trim()) return bulk.trim();

    var items = localStorage.getItem("kuji_items");
    if (items && items.trim()) return items.trim();

    var oldV2 = localStorage.getItem("kuji_words_v2");
    if (oldV2) {
        try {
            var parsed = JSON.parse(oldV2);
            if (Array.isArray(parsed) && parsed.length > 0) {
                return parsed.map(function(it) {
                    var cm = cleanMeaning(it.meaning);
                    return cm ? (it.word + " : " + cm) : it.word;
                }).join("\n");
            }
        } catch (e) {}
    }

    return "";
}

function clearLegacyLocalKeys() {
    var oldCount = parseInt(localStorage.getItem("kuji_chunk_count") || "0", 10) || 0;
    for (var i = 0; i < oldCount + 5; i++) {
        localStorage.removeItem("kuji_chunk_" + i);
    }
    localStorage.removeItem("kuji_chunk_count");
    localStorage.removeItem("kuji_bulk_text");
    localStorage.removeItem("kuji_items");
    localStorage.removeItem("kuji_words_v2");
}

function assembleLegacyCloudText(data) {
    if (!data) return "";
    if (data.chunks && typeof data.chunks === "object") {
        var n = typeof data.chunkCount === "number" ? data.chunkCount : Object.keys(data.chunks).length;
        var parts = [];
        for (var i = 0; i < n; i++) {
            var k = "c" + String(i).padStart(4, "0");
            if (typeof data.chunks[k] === "string") {
                parts.push(data.chunks[k]);
            }
        }
        return parts.join("\n");
    }
    if (typeof data.bulkText === "string") {
        return data.bulkText;
    }
    return "";
}

function parseLegacyBulkTextToV2(text) {
    var cleanedText = String(text || "")
        .replace(/[:：\t]\s*（意味は未登録です[^）]*）/g, "")
        .replace(/[:：\t]\s*（意味未設定）/g, "")
        .replace(/[:：\t]\s*\(意味未設定\)/g, "");

    var lines = cleanedText.split("\n");
    var parsedBooks = [];
    var seenBookIds = {};
    var parsedWords = [];
    var activeBookId = "uncategorized";
    var wordSeq = 0;

    for (var idx = 0; idx < lines.length; idx++) {
        var trimmed = lines[idx].trim();
        if (!trimmed) continue;

        // 旧書籍セクションヘッダー: # [BOOK:id|isbn|title|author|cover]
        var bookMatch = trimmed.match(/^#\s*\[BOOK:([^\]]+)\]\s*$/);
        if (bookMatch) {
            var parts = bookMatch[1].split("|");
            var rawId = (parts[0] || "").trim() || ("book_" + idx);
            var bId = sanitizeEntityId(rawId, "book");
            var bIsbn = (parts[1] || "").trim();
            var bTitle = (parts[2] || "").trim() || "無題の書籍";
            var bAuthor = (parts[3] || "").trim();
            var bCover = sanitizeBookCoverField(parts[4] || "");

            if (!seenBookIds[bId]) {
                seenBookIds[bId] = true;
                if (bCover) {
                    bookCoverCache[bId] = bCover;
                    if (bIsbn) bookCoverCache[bIsbn] = bCover;
                }
                parsedBooks.push({
                    id: bId,
                    isbn: bIsbn,
                    title: bTitle,
                    author: bAuthor,
                    cover: bCover,
                    order: parsedBooks.length * 10,
                    createdAt: 0
                });
            }
            activeBookId = bId;
            continue;
        }

        var word = trimmed;
        var meaning = "";
        var noMeaningNeeded = false;
        var isAutoMeaning = false;

        var m = trimmed.match(/^([^:：\t]+)[:：\t](.*)$/);
        if (m) {
            word = m[1].trim();
            var rawRight = m[2].trim();
            if (isLegacyKnownMarker(rawRight)) {
                meaning = "";
                noMeaningNeeded = true;
            } else if (rawRight.indexOf("[自動]") === 0) {
                isAutoMeaning = true;
                meaning = cleanMeaning(rawRight.replace(/^\[自動\]\s*/, ""));
                if (!meaning) isAutoMeaning = false;
            } else {
                meaning = cleanMeaning(rawRight);
            }
        }

        if (!word) continue;
        wordSeq++;
        parsedWords.push({
            id: generateDeterministicWordId(word),
            word: word,
            meaning: meaning,
            bookId: activeBookId,
            isAutoMeaning: isAutoMeaning,
            noMeaningNeeded: noMeaningNeeded,
            order: wordSeq * 10,
            createdAt: 0
        });
    }

    return {
        books: parsedBooks,
        words: parsedWords
    };
}

// ==================== LocalStorage 読み書き (v2 JSON) ====================

function loadLocalData() {
    var rawV2 = localStorage.getItem(LOCAL_STORAGE_V2_KEY);
    if (rawV2) {
        try {
            var parsed = JSON.parse(rawV2);
            if (parsed && parsed.version === DATA_SCHEMA_VERSION) {
                var rawBooks = Array.isArray(parsed.books) ? parsed.books : [];
                var rawWords = Array.isArray(parsed.words) ? parsed.words : [];

                bookList = rawBooks.map(normalizeBookRecord).filter(Boolean);
                bookList.sort(function(a, b) { return (a.order || 0) - (b.order || 0); });

                wordList = rawWords.map(normalizeWordRecord).filter(Boolean);
                wordList.sort(function(a, b) { return (a.order || 0) - (b.order || 0); });

                if (deduplicateDataInPlace()) {
                    var existingTs = Number(localStorage.getItem("kuji_updated_at") || parsed.updatedAt || 0);
                    storeLocalData(existingTs, false);
                }
                return;
            }
        } catch (e) {
            console.error("Failed to parse kuji_data_v2:", e);
        }
    }

    // v2データが存在しない場合：旧テキスト形式からの自動移行を実行
    var legacyText = loadLegacyLocalText();
    if (legacyText) {
        var migrated = parseLegacyBulkTextToV2(legacyText);
        bookList = migrated.books;
        wordList = migrated.words;
        deduplicateDataInPlace();

        // 既存の更新タイムスタンプと未同期フラグをそのまま引き継ぐ（古い端末がクラウドを上書きするのを防止）
        var prevUpdatedAt = Number(localStorage.getItem("kuji_updated_at") || 0);
        var wasPending = (localStorage.getItem("kuji_pending_sync") === "1");
        storeLocalData(prevUpdatedAt, wasPending);
        clearLegacyLocalKeys();
    } else {
        bookList = [];
        wordList = [];
    }
}

function storeLocalData(updatedAt, markPending) {
    // bookList の並び順を order フィールドに同期
    for (var i = 0; i < bookList.length; i++) {
        bookList[i].order = i * 10;
    }

    var ts = typeof updatedAt === "number" ? updatedAt : Date.now();
    var payload = {
        version: DATA_SCHEMA_VERSION,
        updatedAt: ts,
        books: bookList,
        words: wordList
    };

    try {
        localStorage.setItem(LOCAL_STORAGE_V2_KEY, JSON.stringify(payload));
        if (ts > 0) {
            localStorage.setItem("kuji_updated_at", String(ts));
        }
        if (markPending) {
            localStorage.setItem("kuji_pending_sync", "1");
        }
    } catch (e) {
        console.error("LocalStorage write error:", e);
    }
}

// ローカル保存＋クラウド差分同期の一括実行
function saveAllData(debounceCloud) {
    deduplicateDataInPlace();
    var now = Date.now();
    storeLocalData(now, true);

    if (currentUser && fbDb) {
        updateSyncStatus("同期中...", true);
        if (cloudSaveTimer) clearTimeout(cloudSaveTimer);
        var delay = debounceCloud ? 180 : 0;
        cloudSaveTimer = setTimeout(function() {
            pushLocalToCloud(now);
        }, delay);
    }
}

// ==================== Firebase シリアライズ・差分同期 ====================

function toCloudBookRecord(book, idx) {
    return {
        id: book.id,
        isbn: book.isbn || "",
        title: book.title || "無題の書籍",
        author: book.author || "",
        cover: book.cover || "",
        pinned: Boolean(book.pinned),
        order: idx * 10,
        createdAt: book.createdAt || 0
    };
}

function toCloudWordRecord(item) {
    return {
        id: item.id,
        word: item.word,
        meaning: item.meaning || "",
        bookId: item.bookId || "uncategorized",
        isAuto: Boolean(item.isAutoMeaning),
        known: Boolean(item.noMeaningNeeded),
        order: typeof item.order === "number" ? item.order : 0,
        createdAt: item.createdAt || 0
    };
}

function parseCloudSnapshotToV2(data) {
    if (!data || typeof data !== "object") {
        return { isV2: false, books: [], words: [], booksJson: {}, wordsJson: {} };
    }

    if (data.version === DATA_SCHEMA_VERSION) {
        var rawBooksObj = (data.books && typeof data.books === "object") ? data.books : {};
        var rawWordsObj = (data.words && typeof data.words === "object") ? data.words : {};
        var booksJson = {};
        var wordsJson = {};

        var bArr = Object.keys(rawBooksObj).map(function(k, idx) {
            var item = rawBooksObj[k];
            if (item && typeof item === "object") {
                var norm = normalizeBookRecord(Object.assign({ id: k }, item), idx);
                if (norm) {
                    booksJson[norm.id] = JSON.stringify(toCloudBookRecord(norm, 0)).replace(/"order":0/, '"order":' + norm.order);
                }
                return norm;
            }
            return null;
        }).filter(Boolean);

        bArr.sort(function(a, b) { return (a.order || 0) - (b.order || 0); });
        // ソート後の正規化JSONをキャッシュに記録
        booksJson = {};
        bArr.forEach(function(b, idx) {
            b.order = idx * 10;
            booksJson[b.id] = JSON.stringify(toCloudBookRecord(b, idx));
        });

        var wArr = Object.keys(rawWordsObj).map(function(k, idx) {
            var item = rawWordsObj[k];
            if (item && typeof item === "object") {
                var norm = normalizeWordRecord(Object.assign({ id: k }, item), idx);
                if (norm) {
                    wordsJson[norm.id] = JSON.stringify(toCloudWordRecord(norm));
                }
                return norm;
            }
            return null;
        }).filter(Boolean);

        wArr.sort(function(a, b) { return (a.order || 0) - (b.order || 0); });

        return {
            isV2: true,
            books: bArr,
            words: wArr,
            booksJson: booksJson,
            wordsJson: wordsJson
        };
    }

    // クラウド側がまだ旧形式（v1 chunks / bulkText）の場合
    var legacyCloudText = assembleLegacyCloudText(data);
    var migrated = parseLegacyBulkTextToV2(legacyCloudText);
    return {
        isV2: false,
        books: migrated.books,
        words: migrated.words,
        booksJson: {},
        wordsJson: {}
    };
}

function isDataEqual(booksA, wordsA, booksB, wordsB) {
    if (booksA.length !== booksB.length || wordsA.length !== wordsB.length) return false;
    for (var i = 0; i < booksA.length; i++) {
        var ba = booksA[i], bb = booksB[i];
        if (ba.id !== bb.id || ba.title !== bb.title || ba.author !== bb.author || ba.isbn !== bb.isbn || ba.cover !== bb.cover || Boolean(ba.pinned) !== Boolean(bb.pinned)) {
            return false;
        }
    }
    for (var j = 0; j < wordsA.length; j++) {
        var wa = wordsA[j], wb = wordsB[j];
        if (
            wa.id !== wb.id ||
            wa.word !== wb.word ||
            wa.meaning !== wb.meaning ||
            wa.bookId !== wb.bookId ||
            Boolean(wa.isAutoMeaning) !== Boolean(wb.isAutoMeaning) ||
            Boolean(wa.noMeaningNeeded) !== Boolean(wb.noMeaningNeeded)
        ) {
            return false;
        }
    }
    return true;
}

// 変更があった書籍・単語キーのみをピンポイント送信（通信量を最小化）
function pushLocalToCloud(clientTime) {
    if (!currentUser || !fbDb) return Promise.resolve();

    var ts = clientTime || Date.now();
    var currentBooksMap = {};
    var currentBooksJson = {};
    bookList.forEach(function(b, idx) {
        var rec = toCloudBookRecord(b, idx);
        currentBooksMap[b.id] = rec;
        currentBooksJson[b.id] = JSON.stringify(rec);
    });

    var currentWordsMap = {};
    var currentWordsJson = {};
    wordList.forEach(function(w) {
        var rec = toCloudWordRecord(w);
        currentWordsMap[w.id] = rec;
        currentWordsJson[w.id] = JSON.stringify(rec);
    });

    var updates = {
        version: DATA_SCHEMA_VERSION,
        clientUpdatedAt: ts,
        updatedAt: firebase.database.ServerValue.TIMESTAMP
    };

    if (!cloudStateCache || !cloudStateCache.isV2) {
        // 初回または旧v1からv2へのクラウド移行時：全体構造を書き込み、旧フィールドをクリーンアップ
        updates.books = Object.keys(currentBooksMap).length > 0 ? currentBooksMap : null;
        updates.words = Object.keys(currentWordsMap).length > 0 ? currentWordsMap : null;
        updates.chunks = null;
        updates.chunkCount = null;
        updates.bulkText = null;
    } else {
        // v2差分更新：追加・変更されたキーのみ送信し、削除されたキーのみ null 指定
        Object.keys(currentBooksMap).forEach(function(id) {
            if (cloudStateCache.booksJson[id] !== currentBooksJson[id]) {
                updates["books/" + id] = currentBooksMap[id];
            }
        });
        Object.keys(cloudStateCache.booksJson).forEach(function(oldId) {
            if (!currentBooksMap[oldId]) {
                updates["books/" + oldId] = null;
            }
        });

        Object.keys(currentWordsMap).forEach(function(id) {
            if (cloudStateCache.wordsJson[id] !== currentWordsJson[id]) {
                updates["words/" + id] = currentWordsMap[id];
            }
        });
        Object.keys(cloudStateCache.wordsJson).forEach(function(oldId) {
            if (!currentWordsMap[oldId]) {
                updates["words/" + oldId] = null;
            }
        });
    }

    return fbDb.ref("users/" + currentUser.uid).update(updates).then(function() {
        cloudStateCache = {
            isV2: true,
            booksJson: currentBooksJson,
            wordsJson: currentWordsJson
        };
        if (Number(localStorage.getItem("kuji_updated_at") || 0) <= ts) {
            localStorage.removeItem("kuji_pending_sync");
        }
        updateSyncStatus("同期済み", true);
    }).catch(function(err) {
        console.error("Cloud save error:", err);
        updateSyncStatus("同期エラー", false);
    });
}

// ==================== Firebase 認証・リアルタイム同期監視 ====================

function handleUserLoggedIn(user) {
    currentUser = user;
    try {
        localStorage.setItem("kuji_logged_in_hint", "1");
        sessionStorage.removeItem("kuji_redirect_login");
    } catch (e) {}
    if (document.documentElement) {
        document.documentElement.classList.add("auth-hint-logged-in");
        document.documentElement.classList.remove("auth-hint-redirecting");
    }
    updateAuthUI(user);
    setGateVisibility(true, "", false);
    refreshUI();
    startCloudSync(user);
}

function handleUserLoggedOut() {
    currentUser = null;
    try {
        localStorage.removeItem("kuji_logged_in_hint");
        sessionStorage.removeItem("kuji_redirect_login");
    } catch (e) {}
    if (document.documentElement) {
        document.documentElement.classList.remove("auth-hint-logged-in");
        document.documentElement.classList.remove("auth-hint-redirecting");
    }
    updateAuthUI(null);

    if (isLocalEnvironment() && sessionStorage.getItem("kuji_local_preview") === "1") {
        setGateVisibility(true, "", false);
        updateSyncStatus("ローカル確認中", false);
        refreshUI();
        return;
    }

    if (activeDbRef) {
        activeDbRef.off();
        activeDbRef = null;
    }
    cloudStateCache = null;
    setGateVisibility(
        false,
        "単語帳・本棚データはGoogleアカウントでクラウド同期・保護されています。ログインして利用を開始してください。",
        true
    );
}

function initFirebase() {
    if (typeof firebase === "undefined") {
        setGateVisibility(false, "ネットワーク接続を確認してください。", false);
        return;
    }
    try {
        if (!firebase.apps.length) {
            firebase.initializeApp(firebaseConfig);
        }
        fbAuth = firebase.auth();
        fbDb = firebase.database();

        var isRedirecting = false;
        try {
            isRedirecting = (sessionStorage.getItem("kuji_redirect_login") === "1");
        } catch (e) {}

        if (isRedirecting) {
            setGateVisibility(false, "Google認証を確認しています...", false);
        }

        var redirectSettled = false;

        // リダイレクト認証結果の監視
        fbAuth.getRedirectResult().then(function(result) {
            redirectSettled = true;
            try {
                sessionStorage.removeItem("kuji_redirect_login");
            } catch (e) {}
            if (result && result.user) {
                handleUserLoggedIn(result.user);
            } else if (!fbAuth.currentUser && isRedirecting) {
                handleUserLoggedOut();
            }
        }).catch(function(err) {
            redirectSettled = true;
            try {
                sessionStorage.removeItem("kuji_redirect_login");
            } catch (e) {}
            console.error("Redirect auth error:", err);
            handleUserLoggedOut();
        });

        // 認証状態の監視
        fbAuth.onAuthStateChanged(function(user) {
            if (user) {
                handleUserLoggedIn(user);
            } else {
                // リダイレクト復帰中は getRedirectResult の結果確定まで一時的な null 発火を無視
                var redirectingNow = false;
                try {
                    redirectingNow = (sessionStorage.getItem("kuji_redirect_login") === "1");
                } catch (e) {}
                if (redirectingNow && !redirectSettled) {
                    return;
                }
                handleUserLoggedOut();
            }
        });
    } catch (e) {
        console.error("Firebase init error:", e);
        setGateVisibility(false, "認証システムの初期化に失敗しました。", true);
    }
}

function updateAuthUI(user) {
    var statusElem = document.getElementById("sync-status");
    var btnElem = document.getElementById("auth-btn");
    if (!statusElem || !btnElem) return;

    if (user) {
        statusElem.textContent = "同期中";
        statusElem.className = "sync-status synced";
        btnElem.textContent = "ログアウト";
    } else {
        statusElem.textContent = "未ログイン";
        statusElem.className = "sync-status";
        btnElem.textContent = "ログイン";
    }
}

function updateSyncStatus(text, isSynced) {
    var statusElem = document.getElementById("sync-status");
    if (!statusElem) return;
    statusElem.textContent = text;
    statusElem.className = isSynced ? "sync-status synced" : "sync-status";
}

function handleAuthClick() {
    if (!fbAuth) {
        alert("Firebaseの読み込み中です。少し待ってから再度お試しください。");
        return;
    }
    if (currentUser) {
        if (confirm("ログアウトしますか？")) {
            fbAuth.signOut().then(function() {
                handleUserLoggedOut();
            }).catch(function(err) {
                console.error("Sign out error:", err);
                handleUserLoggedOut();
            });
        }
    } else {
        var provider = new firebase.auth.GoogleAuthProvider();
        var gateMsg = document.getElementById("gate-message");
        if (gateMsg) gateMsg.textContent = "Googleアカウントでログイン中...";

        fbAuth.signInWithPopup(provider).then(function(result) {
            if (result && result.user) {
                handleUserLoggedIn(result.user);
            }
        }).catch(function(err) {
            if (err && (err.code === "auth/popup-blocked" || err.code === "auth/operation-not-supported-in-this-environment")) {
                try {
                    sessionStorage.setItem("kuji_redirect_login", "1");
                    if (document.documentElement) {
                        document.documentElement.classList.add("auth-hint-redirecting");
                    }
                } catch (e) {}
                fbAuth.signInWithRedirect(provider);
            } else if (err && err.code !== "auth/popup-closed-by-user") {
                alert("ログインエラー: " + err.message);
                if (gateMsg) {
                    gateMsg.textContent = "単語帳・本棚データはGoogleアカウントでクラウド同期・保護されています。ログインして利用を開始してください。";
                }
            } else {
                if (gateMsg) {
                    gateMsg.textContent = "単語帳・本棚データはGoogleアカウントでクラウド同期・保護されています。ログインして利用を開始してください。";
                }
            }
        });
    }
}

function startCloudSync(user) {
    if (!fbDb) return;
    if (activeDbRef) activeDbRef.off();

    activeDbRef = fbDb.ref("users/" + user.uid);
    activeDbRef.on("value", function(snapshot) {
        var hasPendingLocal = (localStorage.getItem("kuji_pending_sync") === "1");
        var localUpdatedAt = Number(localStorage.getItem("kuji_updated_at") || 0);
        var hasLocalData = (bookList.length > 0 || wordList.length > 0);

        if (snapshot.exists()) {
            var data = snapshot.val();
            var cloudParsed = parseCloudSnapshotToV2(data);
            cloudStateCache = {
                isV2: cloudParsed.isV2,
                booksJson: cloudParsed.booksJson,
                wordsJson: cloudParsed.wordsJson
            };

            var cloudUpdatedAt = (data && typeof data.clientUpdatedAt === "number") ? data.clientUpdatedAt : 0;
            var hasCloudData = (cloudParsed.books.length > 0 || cloudParsed.words.length > 0);

            // ① ローカルに未送信の変更がある、またはローカルのほうが新しい場合はローカルを保護してクラウドへ送信
            if ((hasPendingLocal || localUpdatedAt > cloudUpdatedAt) && hasLocalData) {
                pushLocalToCloud(localUpdatedAt || Date.now());
                return;
            }

            // ② クラウドが空でローカルにデータがある場合もローカルを保護してクラウドへ送信
            if (!hasCloudData && hasLocalData) {
                pushLocalToCloud(Date.now());
                return;
            }

            // ③ クラウド側データをローカルへ反映
            if (cloudUpdatedAt >= localUpdatedAt) {
                var same = isDataEqual(bookList, wordList, cloudParsed.books, cloudParsed.words);
                bookList = cloudParsed.books;
                wordList = cloudParsed.words;
                deduplicateDataInPlace();
                storeLocalData(cloudUpdatedAt, false);
                localStorage.removeItem("kuji_pending_sync");

                if (!same) {
                    refreshUI();
                }

                // クラウドが旧形式(v1)だった場合は自動的にv2 JSON形式へアップグレード保存
                if (!cloudParsed.isV2 && hasCloudData) {
                    pushLocalToCloud(cloudUpdatedAt || Date.now());
                    return;
                }
            }
            updateSyncStatus("同期済み", true);
        } else {
            cloudStateCache = { isV2: true, booksJson: {}, wordsJson: {} };
            if (hasLocalData) {
                pushLocalToCloud(Date.now());
            } else {
                updateSyncStatus("同期済み", true);
            }
        }
    }, function(err) {
        console.error("Snapshot error:", err);
        updateSyncStatus("設定確認", false);
    });
}
