// 初期サンプルテキスト
const DEFAULT_BULK_TEXT = `大吉 : 最高の運勢。すべて順調に進む兆し。
中吉
小吉
イノベーション : 新しい技術や発想を取り入れた革新のこと。
アイディア`;

let wordList = [];
let bookList = []; // [{ id, isbn, title, author }]
let sheetLines = { uncategorized: [] }; // bookId -> array of raw lines

// 表示中の本タブ:
// index.html では "all_books", "uncategorized", または book.id
// edit.html では "uncategorized" または book.id（1枚の巨大シートではなく本ごとのシートで管理）
let currentBookTab = sessionStorage.getItem("kuji_book_tab") || "all_books";
let currentFilterTab = "all"; // 「すべて/意味あり/意味なし」UIは廃止。常に全件表示
let hasUserSelectedTab = Boolean(sessionStorage.getItem("kuji_filter_tab"));

let isDrawing = false;
let editingWordId = null;

// 重複なしランダム抽選（山札シャッフル方式）用
let drawDeck = [];
let lastDrawnKey = null;
let lastPoolSignature = "";

// 辞書候補キャッシュ (word -> [candidate1, candidate2, ...])
let meaningCandidatesCache = {};
let candidateCycleIndex = {};
let bookCoverCache = {}; // isbn -> coverUrl

// 意味確認モーダル用キュー
let meaningConfirmQueue = [];
let meaningConfirmIndex = 0;
let meaningConfirmOnFinish = null;

// ==================== 保存データの分割（チャンク）管理 ====================
// 全シートの統合テキストを CHUNK_LINES 行ごとのチャンクに分けて localStorage / Firebase に保持する。
// アプリ内部では従来どおり1本の統合テキストとして扱う（loadBulkText / storeBulkText が相互変換）。
const CHUNK_LINES = 100;
const EDIT_PAGE_SIZE = 100;
const LIST_PAGE_SIZE = 100; // 登録単語リストの1ページあたりの件数
let listPageIndex = 0;
let cloudChunkCache = null; // 直近でクラウドから受信したチャンク（差分送信用）。未受信なら null

function normalizeBulkText(text) {
    return (text || "").split("\n").filter(function(l) { return l.trim() !== ""; }).join("\n");
}

function splitTextIntoChunks(text) {
    var lines = normalizeBulkText(text).split("\n").filter(function(l) { return l !== ""; });
    var chunks = [];
    for (var i = 0; i < lines.length; i += CHUNK_LINES) {
        chunks.push(lines.slice(i, i + CHUNK_LINES).join("\n"));
    }
    return chunks;
}

function chunkKey(i) {
    return "c" + String(i).padStart(4, "0");
}

function loadBulkText() {
    var countStr = localStorage.getItem("kuji_chunk_count");
    if (countStr !== null) {
        var n = parseInt(countStr, 10) || 0;
        var parts = [];
        for (var i = 0; i < n; i++) {
            parts.push(localStorage.getItem("kuji_chunk_" + i) || "");
        }
        return parts.join("\n");
    }
    // 旧形式（分割前）からの移行用
    return normalizeBulkText(localStorage.getItem("kuji_bulk_text") || "");
}

function hasChunkStore() {
    return localStorage.getItem("kuji_chunk_count") !== null;
}

function storeBulkText(text) {
    var norm = normalizeBulkText(text);
    var chunks = splitTextIntoChunks(norm);
    var oldCount = parseInt(localStorage.getItem("kuji_chunk_count") || "0", 10) || 0;
    for (var i = 0; i < chunks.length; i++) {
        if (localStorage.getItem("kuji_chunk_" + i) !== chunks[i]) {
            localStorage.setItem("kuji_chunk_" + i, chunks[i]);
        }
    }
    for (var j = chunks.length; j < oldCount; j++) {
        localStorage.removeItem("kuji_chunk_" + j);
    }
    localStorage.setItem("kuji_chunk_count", String(chunks.length));
    // 旧形式の巨大な1本テキストは削除（容量の重複消費を防止）
    localStorage.removeItem("kuji_bulk_text");
    localStorage.removeItem("kuji_items");
    return norm;
}

function assembleCloudText(data) {
    if (!data) return "";
    if (data.chunks && typeof data.chunks === "object") {
        var n = typeof data.chunkCount === "number" ? data.chunkCount : Object.keys(data.chunks).length;
        var parts = [];
        for (var i = 0; i < n; i++) {
            var c = data.chunks[chunkKey(i)];
            if (typeof c === "string") parts.push(c);
        }
        return normalizeBulkText(parts.join("\n"));
    }
    if (typeof data.bulkText === "string") return normalizeBulkText(data.bulkText);
    return "";
}

function isLocalEnvironment() {
    var h = window.location.hostname;
    return h === "localhost" || h === "127.0.0.1" || window.location.protocol === "file:";
}

function shouldConfirmAutoMeaning() {
    var v = localStorage.getItem("kuji_confirm_meaning");
    return v === null ? true : (v === "1");
}

function handleConfirmSettingChange(checked) {
    localStorage.setItem("kuji_confirm_meaning", checked ? "1" : "0");
    syncConfirmToggleUI();
}

function syncConfirmToggleUI() {
    var toggle = document.getElementById("confirm-meaning-toggle");
    if (toggle) {
        toggle.checked = shouldConfirmAutoMeaning();
    }
}

function enterLocalPreviewMode() {
    sessionStorage.setItem("kuji_local_preview", "1");
    setGateVisibility(true, "", false);
    updateSyncStatus("ローカル確認中", false);
    refreshUI();
}

// Firebase 設定・同期用変数
const firebaseConfig = {
    apiKey: "AIzaSyAL_BJS66V2_LK7v_IyG1RlX5QohsfaoOw",
    authDomain: "jinsei-tango-a3d1e.firebaseapp.com",
    databaseURL: "https://jinsei-tango-a3d1e-default-rtdb.firebaseio.com",
    projectId: "jinsei-tango-a3d1e",
    storageBucket: "jinsei-tango-a3d1e.firebasestorage.app",
    messagingSenderId: "481947502597",
    appId: "1:481947502597:web:5ab8bc4f33fe0ae2c7346c",
    measurementId: "G-5N9QWBP59C"
};

let fbAuth = null;
let fbDb = null;
let currentUser = null;
let activeDbRef = null;
let cloudSaveTimer = null;

function isEditPage() {
    return Boolean(document.getElementById("bulk-input"));
}

function getEffectiveBookIdForEdit() {
    if (currentBookTab === "all_books") {
        return "uncategorized";
    }
    var exists = bookList.some(function(b) { return b.id === currentBookTab; });
    return exists ? currentBookTab : "uncategorized";
}

// ① ページ読み込み時の初期化
window.addEventListener("DOMContentLoaded", function() {
    recoverOriginalUserData();
    syncWordList();
    syncConfirmToggleUI();
    if (isLocalEnvironment()) {
        // ローカル環境（localhost / file://）では待ち時間ゼロで即座に画面を表示
        enterLocalPreviewMode();
    }
    initFirebase();
});

// 画面離脱時（ブラウザバック、タブ閉じ、リンク遷移）に編集中の内容を確実に自動保存
window.addEventListener("pagehide", function() {
    if (isEditPage()) {
        collectCurrentSheetLines();
        saveAllSheets(false);
    }
});
window.addEventListener("beforeunload", function() {
    if (isEditPage()) {
        collectCurrentSheetLines();
        saveAllSheets(false);
    }
});

function setGateVisibility(isLoggedIn, messageText, showButton) {
    var gate = document.getElementById("login-gate");
    var main = document.getElementById("app-main");
    var gateMsg = document.getElementById("gate-message");
    var gateBtn = document.getElementById("gate-login-btn");
    var localBtn = document.getElementById("gate-local-btn");

    if (gate && main) {
        gate.style.display = isLoggedIn ? "none" : "flex";
        main.style.display = isLoggedIn ? "flex" : "none";
    }
    if (gateMsg && messageText) {
        gateMsg.textContent = messageText;
    }
    if (gateBtn) {
        gateBtn.style.display = showButton ? "inline-flex" : "none";
    }
    if (localBtn) {
        localBtn.style.display = (!isLoggedIn && isLocalEnvironment()) ? "inline-flex" : "none";
    }
}

function refreshUI() {
    syncConfirmToggleUI();
    renderBookTabs();
    renderActiveBookMeta();

    // 編集画面（edit.html）の場合：選択中の本（または未分類）のシートだけを表示
    var textarea = document.getElementById("bulk-input");
    if (textarea) {
        var editBookId = getEffectiveBookIdForEdit();
        var allLines = sheetLines[editBookId] || [];
        var forceReload = (editPageBookId !== editBookId);
        if (forceReload) {
            editPageIndex = 0;
        }
        editPageIndex = Math.min(Math.max(0, editPageIndex), getEditPageCount(allLines.length) - 1);
        var pageStart = editPageIndex * EDIT_PAGE_SIZE;
        var loadedText = allLines.slice(pageStart, pageStart + editLoadedCount).join("\n");
        var keepTyping = !forceReload && document.activeElement === textarea && textarea.value === loadedText;
        if (!keepTyping) {
            loadEditPageIntoTextarea();
        } else {
            renderEditPager(allLines.length);
        }
        var sheetTitleElem = document.getElementById("editor-sheet-title");
        if (sheetTitleElem) {
            var bTitle = getBookTitleById(editBookId);
            sheetTitleElem.textContent = "「" + bTitle + "」シートの編集（単語 : 意味）";
        }
        var sheetWords = wordList.filter(function(w) { return w.bookId === editBookId; });
        updateWordCountBadge(sheetWords.length);
    }

    // 一覧画面（index.html）の場合
    var wordListContainer = document.getElementById("word-list");
    if (wordListContainer) {
        var searchInput = document.getElementById("search-input");
        var keyword = searchInput ? searchInput.value : "";
        renderWordCards(keyword);
        updateDrawDeckInfo();
    }
}

function getBookTitleById(bookId) {
    if (!bookId || bookId === "uncategorized") return "未分類";
    if (bookId === "all_books") return "すべての本";
    for (var i = 0; i < bookList.length; i++) {
        if (bookList[i].id === bookId) return bookList[i].title;
    }
    return "未分類";
}

// 出典タグ用シート名。「未分類」所属の場合は空文字（タグ非表示）
function getSourceTagText(bookId) {
    if (!bookId || bookId === "uncategorized") return "";
    var book = getBookById(bookId);
    return book ? book.title : "";
}

function getBookById(bookId) {
    for (var i = 0; i < bookList.length; i++) {
        if (bookList[i].id === bookId) return bookList[i];
    }
    return null;
}

// 全シート（未分類＋各書籍シート）を1つの同期テキストにシリアライズ
function serializeFullBulkData() {
    var parts = [];
    var uncat = (sheetLines["uncategorized"] || []).filter(function(l) { return l.trim() !== ""; });
    if (uncat.length > 0) {
        parts.push(uncat.join("\n"));
    }

    bookList.forEach(function(book) {
        var safeTitle = (book.title || "無題").replace(/[\|\[\]\r\n]/g, " ");
        var safeAuthor = (book.author || "").replace(/[\|\[\]\r\n]/g, " ");
        var safeIsbn = (book.isbn || "").replace(/[\|\[\]\r\n]/g, "");
        var safeCover = (book.cover || "").replace(/[\|\[\]\r\n]/g, "");
        var header = "# [BOOK:" + book.id + "|" + safeIsbn + "|" + safeTitle + "|" + safeAuthor + (safeCover ? ("|" + safeCover) : "") + "]";
        var bLines = (sheetLines[book.id] || []).filter(function(l) { return l.trim() !== ""; });
        if (bLines.length > 0) {
            parts.push(header + "\n" + bLines.join("\n"));
        } else {
            parts.push(header);
        }
    });

    return parts.join("\n\n");
}

// ローカル保存＋クラウド同期の一括ヘルパー
function saveAllSheets(debounceCloud) {
    var fullText = serializeFullBulkData();
    saveBulkText(fullText, debounceCloud);
}

function saveBulkText(newText, debounceCloud) {
    var now = Date.now();
    newText = storeBulkText(newText);
    localStorage.setItem("kuji_pending_sync", "1");
    localStorage.setItem("kuji_updated_at", String(now));
    syncWordList();

    if (currentUser && fbDb) {
        updateSyncStatus("同期中...", true);
        if (cloudSaveTimer) clearTimeout(cloudSaveTimer);
        var delay = debounceCloud ? 150 : 0;
        cloudSaveTimer = setTimeout(function() {
            pushLocalToCloud(newText, now);
        }, delay);
    }
}

function pushLocalToCloud(textToSave, clientTime) {
    if (!currentUser || !fbDb) return Promise.resolve();
    var norm = normalizeBulkText(textToSave);
    var chunks = splitTextIntoChunks(norm);
    var updates = {
        bulkText: null, // 旧形式（1本テキスト）は削除
        chunkCount: chunks.length,
        clientUpdatedAt: clientTime || Date.now(),
        updatedAt: firebase.database.ServerValue.TIMESTAMP
    };
    if (cloudChunkCache === null) {
        // クラウドの状態が不明な初回は chunks ノードごと置き換え
        var all = {};
        chunks.forEach(function(c, i) { all[chunkKey(i)] = c; });
        updates.chunks = chunks.length > 0 ? all : null;
    } else {
        // 変更のあったチャンクだけを送信（不要になったものは削除）
        var newKeys = {};
        chunks.forEach(function(c, i) {
            var k = chunkKey(i);
            newKeys[k] = true;
            if (cloudChunkCache[k] !== c) updates["chunks/" + k] = c;
        });
        Object.keys(cloudChunkCache).forEach(function(k) {
            if (!newKeys[k]) updates["chunks/" + k] = null;
        });
    }
    return fbDb.ref("users/" + currentUser.uid).update(updates).then(function() {
        if (loadBulkText() === norm) {
            localStorage.removeItem("kuji_pending_sync");
        }
        updateSyncStatus("同期済み", true);
    }).catch(function(err) {
        console.error("Cloud save error:", err);
        updateSyncStatus("同期エラー", false);
    });
}

// ==================== 編集画面のページ分割（100件ごと） ====================
let editPageIndex = 0;       // 表示中のページ（0始まり）
let editPageBookId = null;   // textarea に読み込み済みのシート
let editLoadedCount = 0;     // textarea に読み込んだ行数（差し戻し時の範囲）

function getEditPageCount(total) {
    return Math.max(1, Math.ceil(total / EDIT_PAGE_SIZE));
}

// textarea の内容を、現在のページに該当する範囲へ書き戻す
function spliceTextareaIntoSheet(editBookId, textareaValue) {
    var pageLines = textareaValue.split("\n").filter(function(l) { return l.trim() !== ""; });
    var lines = sheetLines[editBookId] || [];
    var start = editPageIndex * EDIT_PAGE_SIZE;
    sheetLines[editBookId] = lines.slice(0, start).concat(pageLines, lines.slice(start + editLoadedCount));
    editLoadedCount = pageLines.length;
}

// 現在のページを textarea に読み込む
function loadEditPageIntoTextarea() {
    var textarea = document.getElementById("bulk-input");
    if (!textarea) return;
    var editBookId = getEffectiveBookIdForEdit();
    var all = sheetLines[editBookId] || [];
    editPageBookId = editBookId;
    editPageIndex = Math.min(Math.max(0, editPageIndex), getEditPageCount(all.length) - 1);
    var start = editPageIndex * EDIT_PAGE_SIZE;
    var pageLines = all.slice(start, start + EDIT_PAGE_SIZE);
    textarea.value = pageLines.join("\n");
    editLoadedCount = pageLines.length;
    renderEditPager(all.length);
}

// 「1 2 3 …」形式のページ番号ボタンを描画する共通処理
function renderPageNumbers(pager, total, pageSize, currentIndex, onSelect) {
    var pageCount = Math.max(1, Math.ceil(total / pageSize));
    pager.textContent = "";
    if (pageCount <= 1) {
        pager.style.display = "none";
        return;
    }
    pager.style.display = "flex";
    for (var i = 0; i < pageCount; i++) {
        (function(idx) {
            var btn = document.createElement("button");
            btn.type = "button";
            btn.className = idx === currentIndex ? "edit-page-btn active" : "edit-page-btn";
            btn.textContent = String(idx + 1);
            btn.title = (idx * pageSize + 1) + "〜" + Math.min(total, (idx + 1) * pageSize) + "件目";
            if (idx === currentIndex) btn.setAttribute("aria-current", "page");
            btn.addEventListener("click", function() { onSelect(idx); });
            pager.appendChild(btn);
        })(i);
    }
}

function renderEditPager(total) {
    var pager = document.getElementById("edit-pager");
    if (!pager) return;
    renderPageNumbers(pager, total, EDIT_PAGE_SIZE, editPageIndex, switchEditPage);
}

function switchEditPage(idx) {
    if (idx === editPageIndex) return;
    collectCurrentSheetLines();
    saveAllSheets(true);
    editPageIndex = idx;
    refreshUI();
    var textarea = document.getElementById("bulk-input");
    if (textarea) textarea.scrollTop = 0;
}

// 編集画面の内容（新規追加欄に未追加の文字がある場合も含む）を現在のシートに統合
function collectCurrentSheetLines() {
    var editBookId = getEffectiveBookIdForEdit();
    var textarea = document.getElementById("bulk-input");
    var quickInput = document.getElementById("quick-add-input");

    // textarea がまだ読み込まれていない（初期化前）場合は上書きしない
    if (textarea && editPageBookId === editBookId) {
        spliceTextareaIntoSheet(editBookId, textarea.value);
    }

    if (quickInput && quickInput.value.trim()) {
        var quickLines = quickInput.value.trim().split("\n").filter(function(l) { return l.trim() !== ""; });
        quickInput.value = "";
        sheetLines[editBookId] = (sheetLines[editBookId] || []).concat(quickLines);
        // 追加した単語が見えるよう最終ページへ移動
        editPageIndex = getEditPageCount(sheetLines[editBookId].length) - 1;
        if (textarea) {
            loadEditPageIntoTextarea();
            textarea.scrollTop = textarea.scrollHeight;
        }
        var targetTab = quickLines.some(function(l) { return !/[:：\t]/.test(l); }) ? "none" : "has";
        sessionStorage.setItem("kuji_filter_tab", targetTab);
    }

    return (sheetLines[editBookId] || []).join("\n");
}

// 「保存する」ボタンによる明示的保存
function saveEditorExplicit() {
    collectCurrentSheetLines();
    var hasDup = deduplicateAllSheets();
    if (cloudSaveTimer) {
        clearTimeout(cloudSaveTimer);
        cloudSaveTimer = null;
    }
    saveAllSheets(false);
    refreshUI();
    if (hasDup) {
        showSaveFeedback("保存しました（他シートと重複した単語を自動統合しました）");
    } else {
        showSaveFeedback("保存しました");
    }
}

function showSaveFeedback(msg) {
    var feedback = document.getElementById("save-feedback");
    if (feedback) {
        feedback.textContent = msg;
        feedback.classList.add("visible");
        setTimeout(function() {
            feedback.classList.remove("visible");
        }, 2400);
    }
}

// 編集画面から「一覧に戻る」を押したときに未送信データを確実に保存してから遷移
function returnToIndex(event) {
    collectCurrentSheetLines();
    var finalText = storeBulkText(serializeFullBulkData());
    localStorage.setItem("kuji_pending_sync", "1");
    localStorage.setItem("kuji_updated_at", String(Date.now()));

    if (cloudSaveTimer) {
        clearTimeout(cloudSaveTimer);
        cloudSaveTimer = null;
    }
    if (currentUser && fbDb && localStorage.getItem("kuji_pending_sync") === "1") {
        if (event) event.preventDefault();
        var done = false;
        var go = function() {
            if (done) return;
            done = true;
            window.location.href = "./index.html";
        };
        setTimeout(go, 350);
        pushLocalToCloud(finalText, Date.now()).then(go).catch(go);
    }
}

// 単語行から単語名（左側）を抽出
function extractWordKeyFromLine(line) {
    var trimmed = (line || "").trim();
    if (!trimmed) return "";
    var m = trimmed.match(/^([^:：\t]+)(?:[:：\t]|$)/);
    var rawWord = m ? m[1].trim() : trimmed;
    return rawWord.replace(/\s+/g, " ").trim();
}

// 全シート間で単語の重複を自動排除（意味あり・書籍シート側を優先保持）
function deduplicateAllSheets() {
    var seen = {};
    var duplicateFound = false;

    var bookIds = bookList.map(function(b) { return b.id; });
    var orderedSheetIds = bookIds.concat(["uncategorized"]);

    orderedSheetIds.forEach(function(bId) {
        var lines = sheetLines[bId] || [];
        lines.forEach(function(line) {
            var w = extractWordKeyFromLine(line);
            if (!w) return;
            var norm = w.toLowerCase();
            var hasMeaning = /[:：\t]/.test(line);
            var isBook = (bId !== "uncategorized");

            if (!seen[norm]) {
                seen[norm] = { bookId: bId, line: line, hasMeaning: hasMeaning, isBook: isBook };
            } else {
                duplicateFound = true;
                var curr = seen[norm];
                // 意味がある方を優先
                if (!curr.hasMeaning && hasMeaning) {
                    seen[norm] = { bookId: bId, line: line, hasMeaning: hasMeaning, isBook: isBook };
                }
                // 意味の有無が同じなら、書籍シート側を優先（未分類のダブりを消す）
                else if (curr.hasMeaning === hasMeaning && !curr.isBook && isBook) {
                    seen[norm] = { bookId: bId, line: line, hasMeaning: hasMeaning, isBook: isBook };
                }
            }
        });
    });

    if (!duplicateFound) return false;

    var newSheetLines = {};
    Object.keys(sheetLines).forEach(function(bId) {
        newSheetLines[bId] = [];
    });

    Object.keys(seen).forEach(function(norm) {
        var item = seen[norm];
        if (!newSheetLines[item.bookId]) {
            newSheetLines[item.bookId] = [];
        }
        newSheetLines[item.bookId].push(item.line);
    });

    sheetLines = newSheetLines;
    return true;
}

// アプリ全体（すべてのシート）で単語がすでに登録されているかチェック
function findExistingWordLocation(targetWord) {
    var cleanTarget = (targetWord || "").trim().toLowerCase();
    if (!cleanTarget) return null;

    var allKeys = Object.keys(sheetLines);
    for (var k = 0; k < allKeys.length; k++) {
        var bId = allKeys[k];
        var lines = sheetLines[bId] || [];
        for (var i = 0; i < lines.length; i++) {
            var w = extractWordKeyFromLine(lines[i]);
            if (w.toLowerCase() === cleanTarget) {
                return { bookId: bId, bookTitle: getBookTitleById(bId), line: lines[i] };
            }
        }
    }
    return null;
}

// 新規追加（複数行まとめて最下部へ追加＋重複自動スキップ＋意味省略時は辞書から自動取得）
function addQuickWord() {
    var input = document.getElementById("quick-add-input");
    if (!input) return;
    var raw = input.value.trim();
    if (!raw) return;

    var rawLines = raw.split("\n").map(function(l) { return l.trim(); }).filter(Boolean);
    if (rawLines.length === 0) return;

    var editBookId = getEffectiveBookIdForEdit();
    var textarea = document.getElementById("bulk-input");

    var validLinesToAdd = [];
    var wordsNeedingAutoMeaning = [];
    var skippedWords = [];
    var seenInCurrentInput = {};

    rawLines.forEach(function(line) {
        var w = extractWordKeyFromLine(line);
        if (!w) return;

        // 同じ入力内での重複防止
        if (seenInCurrentInput[w]) {
            return;
        }
        seenInCurrentInput[w] = true;

        // アプリ全体での重複チェック（重複は自動で弾く）
        var existing = findExistingWordLocation(w);
        if (existing) {
            skippedWords.push("「" + w + "」(" + existing.bookTitle + "に登録済)");
            return;
        }

        validLinesToAdd.push(line);
        if (!/[:：\t]/.test(line)) {
            wordsNeedingAutoMeaning.push(w);
        }
    });

    input.value = "";
    // 編集中のページ内容を先にシートへ反映（以降の追加は最下部＝最終ページへ）
    collectCurrentSheetLines();

    // すべて重複していた場合
    if (validLinesToAdd.length === 0) {
        var skipMsg = skippedWords.length === 1
            ? (skippedWords[0] + "は登録済みのためスキップしました")
            : (skippedWords.length + "件の単語はすべて登録済みのためスキップしました");
        showSaveFeedback(skipMsg);
        return;
    }

    // 有効な単語のみを最下部へ追加
    var currentLines = sheetLines[editBookId] || [];
    sheetLines[editBookId] = currentLines.concat(validLinesToAdd);

    var targetTab = wordsNeedingAutoMeaning.length > 0 ? "none" : "has";
    sessionStorage.setItem("kuji_filter_tab", targetTab);

    saveAllSheets(false);

    if (textarea) {
        editPageIndex = getEditPageCount((sheetLines[editBookId] || []).length) - 1;
        loadEditPageIntoTextarea();
        textarea.scrollTop = textarea.scrollHeight;
    }
    refreshUI();

    var feedbackMsg = "";
    if (skippedWords.length > 0) {
        feedbackMsg = validLinesToAdd.length + "件を追加（" + skippedWords.length + "件は登録済みのためスキップ）";
    } else {
        feedbackMsg = validLinesToAdd.length + "件を追加・保存しました";
    }

    if (wordsNeedingAutoMeaning.length > 0) {
        feedbackMsg += "・辞書から意味を検索中...";
        showSaveFeedback(feedbackMsg);
        autoFillMeaningsForSheetWords(editBookId, wordsNeedingAutoMeaning);
    } else {
        showSaveFeedback(feedbackMsg);
    }
}

// 全体編集テキストエリアの最下部へ一発でカーソル＆スクロール移動
function jumpToBulkBottom() {
    var textarea = document.getElementById("bulk-input");
    if (!textarea) return;
    var val = textarea.value;
    if (val && !val.endsWith("\n")) {
        textarea.value = val + "\n";
    }
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    textarea.scrollTop = textarea.scrollHeight;
}

// ==================== ISBN / 本棚（書籍別シート）管理 ====================

function toggleIsbnPanel() {
    var panel = document.getElementById("isbn-panel");
    if (!panel) return;
    var isHidden = (panel.style.display === "none");
    panel.style.display = isHidden ? "flex" : "none";
    if (isHidden) {
        var inp = document.getElementById("isbn-input");
        if (inp) inp.focus();
    }
}

function handleIsbnKey(event) {
    if (event.key === "Enter") {
        event.preventDefault();
        addBookByIsbn();
    }
}

function normalizeIsbnInput(str) {
    if (!str) return "";
    // 全角数字・ハイフンを半角へ変換
    var half = str.replace(/[０-９]/g, function(ch) {
        return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
    }).replace(/[－ー―‐]/g, "-");
    var digitsOnly = half.replace(/[-\s]/g, "").toUpperCase();
    if (/^\d{9}[\dX]$/.test(digitsOnly) || /^\d{13}$/.test(digitsOnly)) {
        return digitsOnly;
    }
    return "";
}

function addBookByIsbn() {
    var input = document.getElementById("isbn-input");
    var status = document.getElementById("isbn-status");
    var resultsBox = document.getElementById("isbn-search-results");
    var btn = document.getElementById("isbn-submit-btn");
    if (!input) return;

    var raw = input.value.trim();
    if (!raw) return;

    if (resultsBox) resultsBox.textContent = "";

    var isbn = normalizeIsbnInput(raw);
    if (!isbn) {
        // 書名・キーワードとしてGoogle Books公開検索を実行し、候補一覧＋「そのままシート名として作成」を表示
        if (btn) btn.disabled = true;
        if (status) status.textContent = "「" + raw + "」で本を検索中...";
        searchBooksByTitleKeyword(raw).then(function(candidates) {
            if (btn) btn.disabled = false;
            renderBookSearchCandidates(raw, candidates);
        });
        return;
    }

    // すでに同じISBNの本が登録されているかチェック
    for (var i = 0; i < bookList.length; i++) {
        if (bookList[i].isbn === isbn) {
            selectBookTab(bookList[i].id);
            input.value = "";
            if (status) status.textContent = "すでに登録されている本を選択しました";
            return;
        }
    }

    if (btn) btn.disabled = true;
    if (status) status.textContent = "ISBN (" + isbn + ") から書籍情報を検索中...";

    lookupBookByIsbnApi(isbn).then(function(info) {
        if (btn) btn.disabled = false;
        if (info && info.title) {
            registerBookObject(isbn, info.title, info.author || "", info.cover || "");
            input.value = "";
            if (status) status.textContent = "追加完了: 『" + info.title + "』";
        } else {
            var manualTitle = prompt("ISBN (" + isbn + ") の書名が自動取得できませんでした。\n本のタイトルを入力してください:", "ISBN:" + isbn);
            if (manualTitle && manualTitle.trim()) {
                registerBookObject(isbn, manualTitle.trim(), "");
                input.value = "";
                if (status) status.textContent = "追加完了: 『" + manualTitle.trim() + "』";
            } else if (status) {
                status.textContent = "書名の取得をキャンセルしました";
            }
        }
    });
}

function searchBooksByTitleKeyword(keyword) {
    var kw = (keyword || "").trim();
    if (!kw) return Promise.resolve([]);

    // 1. Google Books 公開検索（langRestrict=ja で日本語書籍を優先）
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
                        var rawThumb = vi.imageLinks.thumbnail || vi.imageLinks.smallThumbnail || "";
                        if (rawThumb) {
                            thumb = rawThumb.replace(/^http:\/\//i, "https://");
                        }
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

    // 2. Wikipedia 検索から書籍・小説ページのISBN/書誌を抽出してopenBDで裏付け取得
    var wpBookPromise = searchBookViaWikipediaAndOpenBd(kw);

    return Promise.all([wpBookPromise, gbPromise]).then(function(results) {
        var wpList = results[0] || [];
        var gbList = results[1] || [];
        var merged = [];
        var seenKey = {};

        function addBookCand(c) {
            if (!c || !c.title) return;
            var k = c.isbn ? ("isbn:" + c.isbn) : ("title:" + c.title + "|" + (c.author || ""));
            if (seenKey[k]) return;
            seenKey[k] = true;
            merged.push(c);
        }

        // Wikipedia+openBD・Google Books の候補を統合
        wpList.forEach(addBookCand);
        gbList.forEach(addBookCand);
        return merged.slice(0, 6);
    });
}

function extractIsbnsFromText(rawText) {
    var list = [];
    if (!rawText) return list;
    // ISBN2テンプレートやハイフン付き・連続のISBN-13 / ISBN-10を抽出
    var cleaned = rawText.replace(/\x7b\x7bISBN2?\|/gi, "ISBN ");
    var regex = /(?:ISBN(?:-1[03])?[:：\s]*)?(97[89][-\s0-9]{10,16}|[0-9]{9}[0-9Xx]|4-[-\s0-9]{8,12}[0-9Xx])/g;
    var m;
    while ((m = regex.exec(cleaned)) !== null) {
        var norm = normalizeIsbnInput(m[1]);
        if (norm && list.indexOf(norm) === -1) {
            list.push(norm);
        }
        if (list.length >= 4) break;
    }
    return list;
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
                    // 記事内に検索キーワードが含まれているか確認
                    if (p.title !== keyword && wt.indexOf(keyword) === -1) return;

                    if (!fallbackTitle) {
                        fallbackTitle = (p.title === keyword) ? p.title : keyword;
                    }

                    // 著者パラメータ、または「（著者名）の小説」や記事タイトル自体が作家名の場合を抽出
                    var authMatch = wt.match(/\|\s*(?:著者|作者|author)\s*=\s*([^\n|]+)/);
                    if (authMatch && !fallbackAuthor) {
                        fallbackAuthor = cleanWikitextMarkup(authMatch[1]);
                    } else if (!fallbackAuthor && p.title !== keyword) {
                        // 記事が「作家」「小説家」「著作家」に関する記事である場合のみ著者候補とする（無関係な人物ページ等を誤認識しないガード）
                        var isWriterPage = /小説家|作家|文学者|著作家|随筆家/.test(wt.slice(0, 800));
                        if (isWriterPage) {
                            fallbackAuthor = p.title;
                        }
                    }

                    // キーワードが記事内に複数回登場する場合（目次＋作品リストなど）、すべての登場箇所周辺からISBNを探す
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

                    // もし作品単体ページ（p.title === keyword）で周辺にISBNがなかった場合はページ全体から抽出
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
                // ISBNがWikipedia本文になくても、作品記事としてヒットしていれば候補を1件返す
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

            // 抽出したISBNをopenBD APIで一括照会して正確な書名・著者・書影を取得
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
                                var cover = s.cover || "";
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
                    // openBDにデータがなかったISBNでも、キーワード名で候補を作成（表紙なし）
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

function renderBookSearchCandidates(rawQuery, candidates) {
    var status = document.getElementById("isbn-status");
    var resultsBox = document.getElementById("isbn-search-results");
    var input = document.getElementById("isbn-input");
    if (!resultsBox) return;

    resultsBox.textContent = "";

    if (candidates && candidates.length > 0) {
        if (status) {
            status.textContent = "追加する本を選択してください（または下のボタンでそのままシート名として作成）：";
        }
        candidates.forEach(function(cand) {
            var row = document.createElement("button");
            row.type = "button";
            row.className = "book-search-item";

            if (cand.cover) {
                var img = document.createElement("img");
                img.className = "book-search-thumb";
                img.src = cand.cover;
                img.alt = cand.title;
                img.addEventListener("error", function() {
                    img.style.display = "none";
                });
                row.appendChild(img);
            }

            var textWrap = document.createElement("div");
            textWrap.className = "book-search-text";

            var titleSpan = document.createElement("span");
            titleSpan.className = "book-search-title";
            titleSpan.textContent = cand.title;
            textWrap.appendChild(titleSpan);

            var metaParts = [];
            if (cand.author) metaParts.push(cand.author);
            if (cand.isbn) metaParts.push("ISBN: " + cand.isbn);
            if (metaParts.length > 0) {
                var subSpan = document.createElement("span");
                subSpan.className = "book-search-sub";
                subSpan.textContent = metaParts.join(" / ");
                textWrap.appendChild(subSpan);
            }

            row.appendChild(textWrap);

            row.addEventListener("click", function() {
                registerBookObject(cand.isbn || "", cand.title, cand.author || "", cand.cover || "");
                if (input) input.value = "";
                resultsBox.textContent = "";
                if (status) status.textContent = "追加完了: 『" + cand.title + "』";
            });

            resultsBox.appendChild(row);
        });
    } else {
        if (status) {
            status.textContent = "「" + rawQuery + "」に一致する書籍データは見つかりませんでした。そのままシートとして作成できます：";
        }
    }

    // 本ではない自由なシート名としてそのまま作成するボタン
    var directBtn = document.createElement("button");
    directBtn.type = "button";
    directBtn.className = "book-search-direct";
    directBtn.textContent = "＋ 「" + rawQuery + "」という名前のシートとしてそのまま作成";
    directBtn.addEventListener("click", function() {
        registerBookObject("", rawQuery, "");
        if (input) input.value = "";
        resultsBox.textContent = "";
        if (status) status.textContent = "シート「" + rawQuery + "」を作成しました";
    });
    resultsBox.appendChild(directBtn);
}

function lookupBookByIsbnApi(isbn) {
    // すべてAPIキー不要・課金制度なしの公開エンドポイントのみを使用
    // 1. openBD API（日本の書籍メタデータ）
    // 2. Google Books 公開検索（APIキーなし・無料枠超過時もエラー返却のみで課金仕組みなし・書影に強い）
    var openBdPromise = fetch("https://api.openbd.jp/v1/get?isbn=" + encodeURIComponent(isbn))
        .then(function(res) { return res.json(); })
        .catch(function() { return null; });

    var googleBooksPromise = fetch("https://www.googleapis.com/books/v1/volumes?q=isbn:" + encodeURIComponent(isbn))
        .then(function(res) { return res.json(); })
        .catch(function() { return null; });

    return Promise.all([openBdPromise, googleBooksPromise]).then(function(results) {
        var openBdArr = results[0];
        var gData = results[1];

        var title = "";
        var author = "";
        var cover = "";

        if (Array.isArray(openBdArr) && openBdArr[0] && openBdArr[0].summary) {
            var s = openBdArr[0].summary;
            title = s.title || "";
            author = s.author || "";
            cover = s.cover || "";
        }

        if (gData && Array.isArray(gData.items) && gData.items[0] && gData.items[0].volumeInfo) {
            var vi = gData.items[0].volumeInfo;
            if (!title && vi.title) title = vi.title;
            if (!author && Array.isArray(vi.authors)) author = vi.authors.join(", ");
            if (!cover && vi.imageLinks) {
                var rawThumb = vi.imageLinks.thumbnail || vi.imageLinks.smallThumbnail || "";
                if (rawThumb) {
                    cover = rawThumb.replace(/^http:\/\//i, "https://");
                }
            }
        }

        if (cover && isbn) {
            bookCoverCache[isbn] = cover;
        }

        if (title) {
            return { title: title, author: author, cover: cover };
        }
        return null;
    });
}

function registerBookObject(isbn, title, author, coverUrl) {
    if (isEditPage()) {
        collectCurrentSheetLines();
    }
    var newId = "book_" + (isbn || Date.now());
    var finalCover = coverUrl || (isbn ? bookCoverCache[isbn] : "") || "";
    var existingBook = null;
    for (var i = 0; i < bookList.length; i++) {
        if (bookList[i].id === newId) {
            existingBook = bookList[i];
            break;
        }
    }
    if (!existingBook) {
        bookList.push({
            id: newId,
            isbn: isbn || "",
            title: title,
            author: author || "",
            cover: finalCover
        });
        if (!sheetLines[newId]) {
            sheetLines[newId] = [];
        }
    } else if (finalCover && !existingBook.cover) {
        existingBook.cover = finalCover;
    }
    if (finalCover) {
        bookCoverCache[newId] = finalCover;
        if (isbn) bookCoverCache[isbn] = finalCover;
    }
    currentBookTab = newId;
    sessionStorage.setItem("kuji_book_tab", newId);
    saveAllSheets(false);
    refreshUI();
}

function selectBookTab(bookId) {
    if (isEditPage()) {
        // 切り替え前に現在のシートの編集内容を保存
        collectCurrentSheetLines();
        saveAllSheets(true);
    }
    if (currentBookTab !== bookId) {
        currentBookTab = bookId;
        listPageIndex = 0;
        sessionStorage.setItem("kuji_book_tab", bookId);
        // タブ切り替え時は前のシートの山札をクリアして新しいプールで再構築
        drawDeck = [];
        lastPoolSignature = "";
    }
    refreshUI();
}

function deleteCurrentBook() {
    var targetId = isEditPage() ? getEffectiveBookIdForEdit() : currentBookTab;
    var book = getBookById(targetId);
    if (!book) return;

    var count = (sheetLines[targetId] || []).length;
    var msg = count > 0
        ? "『" + book.title + "』を本棚から削除しますか？\n（この本に登録されている " + count + " 件の単語は「未分類」へ移動して保護されます）"
        : "『" + book.title + "』を本棚から削除しますか？";
    if (!confirm(msg)) return;

    if (count > 0) {
        sheetLines["uncategorized"] = (sheetLines["uncategorized"] || []).concat(sheetLines[targetId]);
    }
    delete sheetLines[targetId];
    bookList = bookList.filter(function(b) { return b.id !== targetId; });

    currentBookTab = isEditPage() ? "uncategorized" : "all_books";
    sessionStorage.setItem("kuji_book_tab", currentBookTab);
    saveAllSheets(false);
    refreshUI();
}

var draggedBookTabId = null;
var isBookReorderMode = false;

function toggleBookReorderMode() {
    if (bookList.length <= 1) {
        isBookReorderMode = false;
    } else {
        isBookReorderMode = !isBookReorderMode;
    }
    if (isBookReorderMode && bookList.length > 0) {
        var activeId = isEditPage() ? getEffectiveBookIdForEdit() : currentBookTab;
        if (activeId === "all_books" || activeId === "uncategorized") {
            selectBookTab(bookList[0].id);
            return;
        }
    }
    renderBookTabs();
    renderActiveBookMeta();
}

function moveBookOrder(bookId, direction) {
    var idx = -1;
    for (var i = 0; i < bookList.length; i++) {
        if (bookList[i].id === bookId) {
            idx = i;
            break;
        }
    }
    if (idx === -1) return;
    var targetIdx = idx + direction;
    if (targetIdx < 0 || targetIdx >= bookList.length) return;

    if (isEditPage()) {
        collectCurrentSheetLines();
    }

    var temp = bookList[idx];
    bookList[idx] = bookList[targetIdx];
    bookList[targetIdx] = temp;

    editingWordId = null;
    saveAllSheets(false);
    refreshUI();
}

function reorderBookTab(sourceId, targetId, insertAfter) {
    if (!sourceId || !targetId || sourceId === targetId) return;
    var srcIdx = -1;
    var tgtIdx = -1;
    for (var i = 0; i < bookList.length; i++) {
        if (bookList[i].id === sourceId) srcIdx = i;
        if (bookList[i].id === targetId) tgtIdx = i;
    }
    if (srcIdx === -1 || tgtIdx === -1) return;

    if (isEditPage()) {
        collectCurrentSheetLines();
    }

    var movedBook = bookList.splice(srcIdx, 1)[0];
    var newTgtIdx = -1;
    for (var j = 0; j < bookList.length; j++) {
        if (bookList[j].id === targetId) {
            newTgtIdx = j;
            break;
        }
    }
    if (newTgtIdx === -1) {
        bookList.splice(srcIdx, 0, movedBook);
        return;
    }
    var insertIdx = insertAfter ? (newTgtIdx + 1) : newTgtIdx;
    if (insertIdx === srcIdx) {
        bookList.splice(srcIdx, 0, movedBook);
        return;
    }
    bookList.splice(insertIdx, 0, movedBook);

    editingWordId = null;
    saveAllSheets(false);
    refreshUI();
}

function renderBookTabs() {
    var container = document.getElementById("book-tabs");
    if (!container) return;

    if (bookList.length <= 1 && isBookReorderMode) {
        isBookReorderMode = false;
    }

    var reorderBtn = document.getElementById("book-reorder-btn");
    if (reorderBtn) {
        if (bookList.length > 1) {
            reorderBtn.style.display = "inline-flex";
            reorderBtn.textContent = isBookReorderMode ? "✓ 並び替え完了" : "並び替え";
            reorderBtn.classList.toggle("active", isBookReorderMode);
        } else {
            reorderBtn.style.display = "none";
            reorderBtn.classList.remove("active");
        }
    }

    container.classList.toggle("is-reordering", isBookReorderMode);
    container.textContent = "";
    var fragment = document.createDocumentFragment();
    var editMode = isEditPage();
    var activeTabId = editMode ? getEffectiveBookIdForEdit() : currentBookTab;

    function createTabButton(id, titleText, count, isDraggableBook) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = (activeTabId === id) ? "book-tab active" : "book-tab";
        btn.title = titleText + " (" + count + "件)";

        var titleSpan = document.createElement("span");
        titleSpan.className = "book-tab-title";
        titleSpan.textContent = titleText;
        btn.appendChild(titleSpan);

        var countSpan = document.createElement("span");
        countSpan.className = "book-tab-count";
        countSpan.textContent = count;
        btn.appendChild(countSpan);

        btn.addEventListener("click", function() {
            selectBookTab(id);
        });

        if (isDraggableBook && isBookReorderMode) {
            btn.draggable = true;
            btn.setAttribute("data-book-id", id);

            btn.addEventListener("dragstart", function(e) {
                draggedBookTabId = id;
                btn.classList.add("is-dragging");
                if (e.dataTransfer) {
                    e.dataTransfer.effectAllowed = "move";
                    try {
                        e.dataTransfer.setData("text/plain", id);
                    } catch (err) {}
                }
            });

            btn.addEventListener("dragover", function(e) {
                if (!draggedBookTabId || draggedBookTabId === id) return;
                e.preventDefault();
                if (e.dataTransfer) {
                    e.dataTransfer.dropEffect = "move";
                }
                var rect = btn.getBoundingClientRect();
                var isRightHalf = (e.clientX - rect.left) > (rect.width / 2);
                btn.classList.toggle("drag-over-left", !isRightHalf);
                btn.classList.toggle("drag-over-right", isRightHalf);
            });

            btn.addEventListener("dragleave", function() {
                btn.classList.remove("drag-over-left", "drag-over-right");
            });

            btn.addEventListener("drop", function(e) {
                e.preventDefault();
                var isRightHalf = btn.classList.contains("drag-over-right");
                btn.classList.remove("drag-over-left", "drag-over-right");
                var sourceId = draggedBookTabId;
                draggedBookTabId = null;
                if (!sourceId || sourceId === id) return;
                reorderBookTab(sourceId, id, isRightHalf);
            });

            btn.addEventListener("dragend", function() {
                draggedBookTabId = null;
                var allTabs = container.querySelectorAll(".book-tab");
                for (var i = 0; i < allTabs.length; i++) {
                    allTabs[i].classList.remove("is-dragging", "drag-over-left", "drag-over-right");
                }
            });
        }

        return btn;
    }

    // index.html では「すべての本」タブを先頭に固定表示
    if (!editMode) {
        fragment.appendChild(createTabButton("all_books", "すべて", wordList.length, false));
    }

    // 「未分類」タブを先頭（すべての次）に固定表示
    var uncatCount = wordList.filter(function(w) { return w.bookId === "uncategorized"; }).length;
    fragment.appendChild(createTabButton("uncategorized", "未分類", uncatCount, false));

    // 各書籍タブ
    bookList.forEach(function(book) {
        var bCount = wordList.filter(function(w) { return w.bookId === book.id; }).length;
        fragment.appendChild(createTabButton(book.id, book.title, bCount, true));
    });

    container.appendChild(fragment);
    setupBookTabsCollapse(container);
}

// 本棚タグ一覧の折りたたみ（index.html のみ）
var bookTabsExpanded = false;
var bookTabsObserver = null;

function setupBookTabsCollapse(container) {
    var toggle = document.getElementById("book-tabs-toggle");
    if (!toggle || isEditPage()) return;
    if (!bookTabsObserver && typeof ResizeObserver !== "undefined") {
        bookTabsObserver = new ResizeObserver(function() { updateBookTabsToggle(); });
        bookTabsObserver.observe(container);
    }
    updateBookTabsToggle();
}

function updateBookTabsToggle() {
    var container = document.getElementById("book-tabs");
    var toggle = document.getElementById("book-tabs-toggle");
    if (!container || !toggle) return;
    if (isBookReorderMode) {
        container.classList.remove("is-collapsed");
        toggle.style.display = "none";
        return;
    }
    var wasCollapsed = container.classList.contains("is-collapsed");
    container.classList.add("is-collapsed");
    var overflowing = container.scrollHeight > container.clientHeight + 1;
    container.classList.toggle("is-collapsed", !bookTabsExpanded);
    if (!overflowing && !bookTabsExpanded) {
        toggle.style.display = "none";
        return;
    }
    toggle.style.display = "";
    toggle.textContent = bookTabsExpanded ? "折りたたむ" : "すべて表示";
    toggle.setAttribute("aria-expanded", bookTabsExpanded ? "true" : "false");
}

function toggleBookTabsExpanded() {
    bookTabsExpanded = !bookTabsExpanded;
    updateBookTabsToggle();
}

// ISBNおよび書名から表紙画像URLのみを取得（openBD → Google Books の順。画像ファイル自体は保存しない）
function fetchCoverUrlForBook(book) {
    if (!book) return Promise.resolve("");
    var isbn = (book.isbn || "").trim();
    var title = (book.title || "").trim();

    var openBdPromise = isbn
        ? fetch("https://api.openbd.jp/v1/get?isbn=" + encodeURIComponent(isbn))
            .then(function(res) { return res.json(); })
            .then(function(arr) {
                return (Array.isArray(arr) && arr[0] && arr[0].summary && arr[0].summary.cover) || "";
            })
            .catch(function() { return ""; })
        : Promise.resolve("");

    return openBdPromise.then(function(openBdCover) {
        if (openBdCover) return openBdCover;

        var gbQuery = isbn ? ("isbn:" + encodeURIComponent(isbn)) : encodeURIComponent(title);
        var gbUrl = "https://www.googleapis.com/books/v1/volumes?q=" + gbQuery + "&langRestrict=ja&maxResults=1";
        return fetch(gbUrl)
            .then(function(r) { return r.json(); })
            .then(function(d) {
                var il = d && d.items && d.items[0] && d.items[0].volumeInfo && d.items[0].volumeInfo.imageLinks;
                var t = il && (il.thumbnail || il.smallThumbnail);
                if (t) return t.replace(/^http:\/\//i, "https://");

                if (isbn && title) {
                    var titleGbUrl = "https://www.googleapis.com/books/v1/volumes?q=" + encodeURIComponent(title) + "&langRestrict=ja&maxResults=1";
                    return fetch(titleGbUrl)
                        .then(function(r2) { return r2.json(); })
                        .then(function(d2) {
                            var il2 = d2 && d2.items && d2.items[0] && d2.items[0].volumeInfo && d2.items[0].volumeInfo.imageLinks;
                            var t2 = il2 && (il2.thumbnail || il2.smallThumbnail);
                            return t2 ? t2.replace(/^http:\/\//i, "https://") : "";
                        });
                }
                return "";
            })
            .catch(function() { return ""; });
    });
}

function fetchCoverUrlByIsbn(isbn) {
    return fetchCoverUrlForBook({ isbn: isbn, title: "" });
}

function renderActiveBookMeta() {
    var metaBox = document.getElementById("active-book-meta");
    if (!metaBox) return;

    var activeId = isEditPage() ? getEffectiveBookIdForEdit() : currentBookTab;

    // 「未分類」はシートではなく常に1つの共通枠のため、付随情報は表示しない
    if (activeId === "uncategorized") {
        metaBox.style.display = "none";
        metaBox.textContent = "";
        return;
    }

    var book = getBookById(activeId);
    if (!book) {
        metaBox.style.display = "none";
        metaBox.textContent = "";
        return;
    }

    metaBox.style.display = "flex";
    metaBox.textContent = "";

    var leftGroup = document.createElement("div");
    leftGroup.className = "book-meta-left";

    function createCoverPlaceholder() {
        var ph = document.createElement("div");
        ph.className = "book-cover-thumb book-cover-placeholder";
        ph.setAttribute("aria-label", "表紙なし");
        ph.textContent = "📖";
        return ph;
    }

    var cachedCover = book.cover || bookCoverCache[book.id] || (book.isbn ? bookCoverCache[book.isbn] : "");
    if (cachedCover) {
        var coverImg = document.createElement("img");
        coverImg.className = "book-cover-thumb";
        coverImg.alt = book.title;
        coverImg.src = cachedCover;
        coverImg.addEventListener("error", function() {
            var ph = createCoverPlaceholder();
            if (coverImg.parentNode) {
                coverImg.parentNode.replaceChild(ph, coverImg);
            }
        });
        leftGroup.appendChild(coverImg);
    } else {
        var placeholder = createCoverPlaceholder();
        leftGroup.appendChild(placeholder);

        if (!bookCoverCache["tried_" + book.id]) {
            // 表紙URL未取得の本：openBD → Google Books（ISBN・書名フォールバック）で取得
            bookCoverCache["tried_" + book.id] = "1";
            fetchCoverUrlForBook(book).then(function(url) {
                if (url) {
                    book.cover = url;
                    bookCoverCache[book.id] = url;
                    if (book.isbn) bookCoverCache[book.isbn] = url;
                    saveAllSheets(true);
                    renderActiveBookMeta();
                }
            });
        }
    }

    var infoSpan = document.createElement("span");
    infoSpan.className = "book-meta-text";
    var details = book.title;
    if (book.author) details += " / " + book.author;
    if (book.isbn) details += " (ISBN: " + book.isbn + ")";
    infoSpan.textContent = details;
    leftGroup.appendChild(infoSpan);

    metaBox.appendChild(leftGroup);

    var rightGroup = document.createElement("div");
    rightGroup.className = "book-meta-actions";

    var bookIdx = -1;
    for (var i = 0; i < bookList.length; i++) {
        if (bookList[i].id === book.id) {
            bookIdx = i;
            break;
        }
    }

    if (isBookReorderMode && bookIdx !== -1) {
        var moveLeftBtn = document.createElement("button");
        moveLeftBtn.type = "button";
        moveLeftBtn.className = "btn-book-move";
        moveLeftBtn.textContent = "← 左へ移動";
        moveLeftBtn.title = "このシートの並び順を1つ左へ移動";
        moveLeftBtn.disabled = (bookIdx <= 0);
        moveLeftBtn.addEventListener("click", function() {
            moveBookOrder(book.id, -1);
        });
        rightGroup.appendChild(moveLeftBtn);

        var moveRightBtn = document.createElement("button");
        moveRightBtn.type = "button";
        moveRightBtn.className = "btn-book-move";
        moveRightBtn.textContent = "右へ移動 →";
        moveRightBtn.title = "このシートの並び順を1つ右へ移動";
        moveRightBtn.disabled = (bookIdx >= bookList.length - 1);
        moveRightBtn.addEventListener("click", function() {
            moveBookOrder(book.id, 1);
        });
        rightGroup.appendChild(moveRightBtn);
    }

    var delBookBtn = document.createElement("button");
    delBookBtn.type = "button";
    delBookBtn.className = "btn-book-remove";
    delBookBtn.textContent = "シートを削除";
    delBookBtn.addEventListener("click", function() {
        deleteCurrentBook();
    });
    rightGroup.appendChild(delBookBtn);

    metaBox.appendChild(rightGroup);
}

// ==================== Wiktionary / Wikipedia 意味の自動取得 ====================

// 「踵　かかと」「踵（かかと）」のように漢字＋読み仮名で入力された場合も分解して検索対象にする
function extractSearchTerms(rawWord) {
    var terms = [];
    var s = (rawWord || "").trim();
    if (!s) return terms;

    // 括弧内の読みや別表記を抽出（例: 踵（かかと） -> 踵, かかと）
    var parenMatches = s.match(/[（\x28]([^）\x29]+)[）\x29]/g);
    var withoutParens = s.replace(/[（\x28][^）\x29]+[）\x29]/g, " ").trim();

    // 全角・半角スペースで分割（例: 踵　かかと -> 踵, かかと）
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
                            // 全文検索経由の場合、記事内に検索した読み（例：「ほおづえ」）が実際に含まれているか検証し、無関係な記事を除外する
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

    // 1. Wiktionary（タイトル完全一致・リダイレクト追跡のみ）
    return fetchWiktionaryDefinitionsByTitles(searchTerms, "")
        .then(function(defs) {
            defs.forEach(addCandidate);
        })
        .then(function() {
            if (candidates.length >= 2) return;
            // 2. ひらがなのみで入力された場合（例：「ほおづえ」）に限り、その読みを持つ漢字見出し語（例：「頬杖」）をWiktionaryから厳密検索
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
            // 3. Wikipedia（見出し語完全一致・公式リダイレクトのみ。無関係な記事が混ざる曖昧な全文検索は行わない）
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

function cleanWikitextMarkup(str) {
    if (!str) return "";
    var s = str;
    // <ref>タグやHTMLコメントを除去
    s = s.replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, "").replace(/<ref[^>]*\/>/gi, "");
    s = s.replace(/<!--[\s\S]*?-->/g, "");
    // rubyテンプレートを漢字（かな）に変換
    s = s.replace(/\{\{ruby\|([^|\x7d]+)\|([^|\x7d]+)[^\x7d]*\}\}/gi, "$1（$2）");
    // その他のテンプレートを除去
    while (/\{\{[^\x7b\x7d]*\}\}/.test(s)) {
        s = s.replace(/\{\{[^\x7b\x7d]*\}\}/g, "");
    }
    // [[リンク先|表示名]] -> 表示名、[[リンク名]] -> リンク名
    s = s.replace(/\[\[(?:[^|\]]+\|)?([^\]]+)\]\]/g, "$1");
    // 太字・斜体マークアップ除去
    s = s.replace(/'''+/g, "").replace(/''/g, "");
    // HTMLタグ除去
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

        // 音読み・訓読みの行があれば読み仮名として控えに取得
        if (/^\*\s*(音読み|訓読み)\s*[:：]/.test(line)) {
            var rClean = cleanWikitextMarkup(line.replace(/^\*\s*/, ""));
            if (rClean && readings.length < 2) {
                readings.push(rClean);
            }
            continue;
        }

        // Wiktionaryの定義行は「#」で始まる（「#:」「#*」「##」は例文・引用なので除外、#直後の空白有無は問わない）
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

    // 漢字単体で登録されていて訓読み・音読みがある場合、最初の意味の先頭に読みを補うか候補に追加
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
    // 冒頭の括弧内の読み仮名・英語表記などをスッキリ整理
    var text = extractText.replace(/（[^）]{1,60}）/g, "").replace(/\([^\x29]{1,60}\)/g, "").trim();
    // 最初の1文を取り出す
    var firstSentence = text.split("。")[0];
    if (!firstSentence) return "";
    // 「〜とは、」「〜は、」の前の主語を省略して簡潔にする
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

function autoFillMeaningsForSheetWords(bookId, wordsToFetch) {
    var uniqueWords = [];
    wordsToFetch.forEach(function(w) {
        if (uniqueWords.indexOf(w) === -1) uniqueWords.push(w);
    });

    var foundItems = [];
    var chain = Promise.resolve();

    uniqueWords.forEach(function(targetWord) {
        chain = chain.then(function() {
            return fetchWordMeaningCandidates(targetWord).then(function(candidates) {
                if (candidates && candidates.length > 0) {
                    foundItems.push({
                        bookId: bookId,
                        word: targetWord,
                        candidates: candidates
                    });
                }
            });
        });
    });

    chain.then(function() {
        if (foundItems.length === 0) {
            showSaveFeedback("追加・保存しました（辞書一致なし）");
            return;
        }

        // 「意味を確認する」設定がONなら確認モーダルを順番に表示
        if (shouldConfirmAutoMeaning()) {
            openMeaningConfirmQueue(foundItems, function(confirmedCount) {
                saveAllSheets(false);
                if (confirmedCount > 0) {
                    sessionStorage.setItem("kuji_filter_tab", "has");
                }
                refreshUI();
                showSaveFeedback(confirmedCount + " 件の意味を確認・保存しました");
            });
        } else {
            // OFFなら確認なしで第1候補を「[自動]」ラベル付きで自動登録（カード上で後から確認・別候補変更・確定が可能）
            var filledCount = 0;
            foundItems.forEach(function(entry) {
                var ok = applyConfirmedMeaningToWord(entry.bookId, entry.word, "[自動] " + entry.candidates[0]);
                if (ok) filledCount++;
            });
            saveAllSheets(false);
            if (filledCount > 0) {
                sessionStorage.setItem("kuji_filter_tab", "has");
            }
            refreshUI();
            showSaveFeedback("辞書から " + filledCount + " 件の意味を自動登録しました");
        }
    });
}

function applyConfirmedMeaningToWord(bookId, targetWord, meaningStr) {
    var lines = sheetLines[bookId] || [];
    for (var i = 0; i < lines.length; i++) {
        var trimmed = lines[i].trim();
        var w = trimmed;
        var m = trimmed.match(/^([^:：\t]+)[:：\t]/);
        if (m) w = m[1].trim();
        if (w === targetWord) {
            lines[i] = targetWord + " : " + meaningStr;
            return true;
        }
    }
    return false;
}

function openMeaningConfirmQueue(items, onFinish) {
    meaningConfirmQueue = items || [];
    meaningConfirmIndex = 0;
    meaningConfirmOnFinish = onFinish || null;
    meaningConfirmQueue._confirmedCount = 0;
    renderCurrentMeaningConfirmModal();
}

function renderCurrentMeaningConfirmModal() {
    var modal = document.getElementById("meaning-confirm-modal");
    if (!modal) return;

    if (meaningConfirmIndex >= meaningConfirmQueue.length) {
        modal.style.display = "none";
        var count = meaningConfirmQueue._confirmedCount || 0;
        var cb = meaningConfirmOnFinish;
        meaningConfirmQueue = [];
        meaningConfirmOnFinish = null;
        if (cb) cb(count);
        return;
    }

    var current = meaningConfirmQueue[meaningConfirmIndex];
    var badge = document.getElementById("modal-step-badge");
    var title = document.getElementById("modal-word-title");
    var list = document.getElementById("modal-candidates-list");
    var input = document.getElementById("modal-meaning-input");
    var skipBtn = document.getElementById("modal-skip-btn");

    if (badge) {
        badge.textContent = "意味の確認 (" + (meaningConfirmIndex + 1) + " / " + meaningConfirmQueue.length + ")";
    }
    if (skipBtn) {
        skipBtn.textContent = (meaningConfirmQueue.length > 1) ? "スキップ（登録しない）" : "キャンセル";
    }
    if (title) {
        title.textContent = current.word;
    }
    if (input) {
        input.value = current.candidates[0] || "";
    }
    if (list) {
        list.textContent = "";
        current.candidates.forEach(function(cand, idx) {
            var btn = document.createElement("button");
            btn.type = "button";
            btn.className = (idx === 0) ? "candidate-chip active" : "candidate-chip";
            btn.textContent = "候補" + (idx + 1) + ": " + cand;
            btn.addEventListener("click", function() {
                if (input) input.value = cand;
                var allChips = list.querySelectorAll(".candidate-chip");
                for (var k = 0; k < allChips.length; k++) {
                    allChips[k].classList.remove("active");
                }
                btn.classList.add("active");
            });
            list.appendChild(btn);
        });
    }

    modal.style.display = "flex";
    if (input) input.focus();
}

function resolveMeaningModal(action) {
    if (meaningConfirmIndex >= meaningConfirmQueue.length) return;
    var current = meaningConfirmQueue[meaningConfirmIndex];
    var input = document.getElementById("modal-meaning-input");
    var val = input ? input.value.trim() : (current.candidates[0] || "");

    if (action === "save" && val) {
        applyConfirmedMeaningToWord(current.bookId, current.word, val);
        meaningConfirmQueue._confirmedCount = (meaningConfirmQueue._confirmedCount || 0) + 1;
    } else if (action === "known") {
        applyConfirmedMeaningToWord(current.bookId, current.word, "✓");
        meaningConfirmQueue._confirmedCount = (meaningConfirmQueue._confirmedCount || 0) + 1;
    }

    meaningConfirmIndex++;
    renderCurrentMeaningConfirmModal();
}

// 編集画面で「辞書から意味を一括補完」ボタンを押したとき
function batchFetchMissingMeanings() {
    collectCurrentSheetLines();
    var editBookId = getEffectiveBookIdForEdit();
    var lines = sheetLines[editBookId] || [];
    var missingWords = [];

    lines.forEach(function(line) {
        var trimmed = line.trim();
        if (trimmed && !/[:：\t]/.test(trimmed)) {
            missingWords.push(trimmed);
        }
    });

    if (missingWords.length === 0) {
        showSaveFeedback("意味が未登録の単語はありません");
        return;
    }

    var btn = document.getElementById("batch-dict-btn");
    if (btn) btn.disabled = true;
    showSaveFeedback(missingWords.length + " 件の意味を辞書から検索中...");

    autoFillMeaningsForSheetWords(editBookId, missingWords);
    setTimeout(function() {
        if (btn) btn.disabled = false;
    }, 1500);
}

// カード上で「✓ 確定」（自動取得された意味を確定し、[自動] ラベルを外す）
function confirmAutoMeaning(item) {
    updateSingleWordLine(item.bookId, item.word, item.word + " : " + item.meaning);
}

// カード上で「別候補」（辞書・Wikipediaの2番目・3番目の意味候補に切り替える）
function cycleAutoMeaningCandidate(item) {
    fetchWordMeaningCandidates(item.word).then(function(candidates) {
        if (!candidates || candidates.length === 0) {
            alert("「" + item.word + "」の辞書候補が見つかりませんでした。手動で編集してください。");
            return;
        }
        if (candidates.length === 1) {
            alert("辞書に登録されている候補はこの1件のみです。\n違う場合は「編集」または「意味を消す」を押してください。");
            return;
        }
        var currentIdx = candidateCycleIndex[item.word] || 0;
        var nextIdx = (currentIdx + 1) % candidates.length;
        candidateCycleIndex[item.word] = nextIdx;
        updateSingleWordLine(item.bookId, item.word, item.word + " : [自動] " + candidates[nextIdx]);
    });
}

// カード上で「意味を消す」（間違った自動意味をワンタップで消去して「意味なし」に戻す）
function clearWordMeaning(item) {
    updateSingleWordLine(item.bookId, item.word, item.word);
}

// ==================== Firebase 初期化とログイン監視（ログイン必須ゲート連動） ====================

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

        fbAuth.getRedirectResult().catch(function(err) {
            console.error("Redirect auth error:", err);
        });

        fbAuth.onAuthStateChanged(function(user) {
            currentUser = user;
            updateAuthUI(user);
            if (user) {
                setGateVisibility(true, "", false);
                refreshUI();
                startCloudSync(user);
            } else if (isLocalEnvironment() && sessionStorage.getItem("kuji_local_preview") === "1") {
                setGateVisibility(true, "", false);
                updateSyncStatus("ローカル確認中", false);
                refreshUI();
            } else {
                if (activeDbRef) {
                    activeDbRef.off();
                    activeDbRef = null;
                }
                setGateVisibility(
                    false,
                    "単語帳・本棚データはGoogleアカウントでクラウド同期・保護されています。ログインして利用を開始してください。",
                    true
                );
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
            fbAuth.signOut();
        }
    } else {
        var provider = new firebase.auth.GoogleAuthProvider();
        fbAuth.signInWithPopup(provider).catch(function(err) {
            if (err && (err.code === "auth/popup-blocked" || err.code === "auth/operation-not-supported-in-this-environment")) {
                fbAuth.signInWithRedirect(provider);
            } else if (err && err.code !== "auth/popup-closed-by-user") {
                alert("ログインエラー: " + err.message);
            }
        });
    }
}

function startCloudSync(user) {
    if (!fbDb) return;
    if (activeDbRef) activeDbRef.off();

    activeDbRef = fbDb.ref("users/" + user.uid);
    activeDbRef.on("value", function(snapshot) {
        var localText = loadBulkText();
        var hasPendingLocal = (localStorage.getItem("kuji_pending_sync") === "1");
        var localUpdatedAt = Number(localStorage.getItem("kuji_updated_at") || 0);

        if (snapshot.exists()) {
            var data = snapshot.val();
            var cloudText = assembleCloudText(data);
            cloudChunkCache = (data && data.chunks && typeof data.chunks === "object") ? Object.assign({}, data.chunks) : {};
            var cloudUpdatedAt = (data && typeof data.clientUpdatedAt === "number") ? data.clientUpdatedAt : 0;

            // ① ローカルに未送信の変更がある、またはローカルの更新日時のほうが新しい場合は、ローカルを最優先保護
            if (hasPendingLocal || localUpdatedAt > cloudUpdatedAt) {
                if (localText.trim()) {
                    pushLocalToCloud(localText, localUpdatedAt || Date.now());
                }
                return;
            }

            // ② クラウドが空でローカルにデータがある場合もローカルを保護してクラウドへ送信
            if (!cloudText.trim() && localText.trim()) {
                pushLocalToCloud(localText, Date.now());
                return;
            }

            // ③ クラウドのほうが確実に新しい（cloudUpdatedAt > localUpdatedAt）場合のみローカルを更新
            if (cloudText !== localText) {
                if (cloudUpdatedAt >= localUpdatedAt) {
                    storeBulkText(cloudText);
                    localStorage.setItem("kuji_updated_at", String(cloudUpdatedAt));
                    localStorage.removeItem("kuji_pending_sync");
                    syncWordList();
                    refreshUI();
                }
            } else {
                localStorage.removeItem("kuji_pending_sync");
            }
            updateSyncStatus("同期済み", true);
        } else {
            cloudChunkCache = {};
            if (localText.trim()) {
                pushLocalToCloud(localText, Date.now());
            }
        }
    }, function(err) {
        console.error("Snapshot error:", err);
        updateSyncStatus("設定確認", false);
    });
}

// ② ユーザーが保存していた元データ（kuji_items）を最優先で復旧する
function recoverOriginalUserData() {
    var currentBulk = hasChunkStore() ? loadBulkText() : localStorage.getItem("kuji_bulk_text");
    var originalItems = localStorage.getItem("kuji_items");
    var oldWordsV2 = localStorage.getItem("kuji_words_v2");

    var targetText = "";

    if (currentBulk !== null && currentBulk.trim() !== "") {
        targetText = currentBulk;
    } else if (originalItems && originalItems.trim() !== "") {
        targetText = originalItems;
    } else if (oldWordsV2) {
        try {
            var parsed = JSON.parse(oldWordsV2);
            if (Array.isArray(parsed) && parsed.length > 0) {
                targetText = parsed.map(function(item) {
                    var cleanM = cleanMeaning(item.meaning);
                    return cleanM ? item.word + " : " + cleanM : item.word;
                }).join("\n");
            }
        } catch (e) {}
    }

    var cleaned = targetText
        .replace(/[:：\t]\s*（意味は未登録です[^）]*）/g, "")
        .replace(/[:：\t]\s*（意味未設定）/g, "")
        .replace(/[:：\t]\s*\(意味未設定\)/g, "");

    storeBulkText(cleaned);
}

function cleanMeaning(str) {
    if (!str) return "";
    var s = str.trim();
    if (s.indexOf("意味は未登録です") !== -1 || 
        s === "（意味未設定）" || 
        s === "(意味未設定)" || 
        s === "（意味は未登録です。必要に応じて再登録してください）") {
        return "";
    }
    return s;
}

function isKnownMarker(str) {
    if (!str) return false;
    var s = str.trim();
    return s === "✓" || s === "✔" || s === "済" || s === "（意味不要）";
}

// ③ テキストを解析して本棚（bookList / sheetLines）と単語リスト（wordList）を同期
function syncWordList() {
    var text = loadBulkText();
    parseFullBulkData(text);
    // すでに存在する全シート間の重複を自動クリーンアップ（意味あり・書籍側を優先保持）
    if (deduplicateAllSheets()) {
        var cleanText = serializeFullBulkData();
        storeBulkText(cleanText);
        parseFullBulkData(cleanText);
        if (currentUser && fbDb) {
            pushLocalToCloud(cleanText, Date.now());
        }
    }
}

function parseFullBulkData(text) {
    var lines = text.split("\n");
    var newBooks = [];
    var newSheets = { uncategorized: [] };
    var parsedWords = [];
    var currentBookId = "uncategorized";

    lines.forEach(function(line, index) {
        var trimmed = line.trim();
        if (!trimmed) return;

        // 書籍セクションヘッダー判定: # [BOOK:id|isbn|title|author|cover]
        var bookMatch = trimmed.match(/^#\s*\[BOOK:([^\]]+)\]\s*$/);
        if (bookMatch) {
            var parts = bookMatch[1].split("|");
            var bId = (parts[0] || "").trim() || ("book_" + index);
            var bIsbn = (parts[1] || "").trim();
            var bTitle = (parts[2] || "").trim() || "無題の書籍";
            var bAuthor = (parts[3] || "").trim();
            var bCover = (parts[4] || "").trim();
            // 過去に保存されたApple由来の表紙URL（規約上使用しない）は破棄
            if (/mzstatic\.com|apple\.com/i.test(bCover)) bCover = "";

            if (!newSheets[bId]) {
                newSheets[bId] = [];
                if (bCover) {
                    bookCoverCache[bId] = bCover;
                }
                newBooks.push({
                    id: bId,
                    isbn: bIsbn,
                    title: bTitle,
                    author: bAuthor,
                    cover: bCover
                });
            }
            currentBookId = bId;
            return;
        }

        newSheets[currentBookId].push(trimmed);

        var word = trimmed;
        var meaning = "";
        var noMeaningNeeded = false;
        var isAutoMeaning = false;

        var match = trimmed.match(/^([^:：\t]+)[:：\t](.*)$/);
        if (match) {
            word = match[1].trim();
            var rawRight = match[2].trim();
            if (isKnownMarker(rawRight)) {
                meaning = "";
                noMeaningNeeded = true;
            } else if (rawRight.indexOf("[自動]") === 0) {
                isAutoMeaning = true;
                meaning = cleanMeaning(rawRight.replace(/^\[自動\]\s*/, ""));
            } else {
                meaning = cleanMeaning(rawRight);
            }
        }

        parsedWords.push({
            id: "word-" + index,
            bookId: currentBookId,
            word: word,
            meaning: meaning,
            noMeaningNeeded: noMeaningNeeded,
            isAutoMeaning: isAutoMeaning
        });
    });

    bookList = newBooks;
    sheetLines = newSheets;
    wordList = parsedWords;

    // 選択中の本タブが存在しない場合の補正
    if (currentBookTab !== "all_books" && currentBookTab !== "uncategorized") {
        var stillExists = bookList.some(function(b) { return b.id === currentBookTab; });
        if (!stillExists) {
            currentBookTab = isEditPage() ? "uncategorized" : "all_books";
        }
    }
}

// ⑤ 編集画面での入力イベントハンドラ（現在の本シートだけを更新）
function handleBulkInput() {
    var textarea = document.getElementById("bulk-input");
    if (!textarea) return;

    var editBookId = getEffectiveBookIdForEdit();
    if (editPageBookId === editBookId) {
        spliceTextareaIntoSheet(editBookId, textarea.value);
    }
    saveAllSheets(true);

    var sheetWords = wordList.filter(function(w) { return w.bookId === editBookId; });
    updateWordCountBadge(sheetWords.length);
    renderBookTabs();
    renderEditPager((sheetLines[editBookId] || []).length);
}

function updateWordCountBadge(count) {
    var wordCountElem = document.getElementById("word-count");
    if (wordCountElem) {
        wordCountElem.innerText = count + " 件";
    }
}

// タブ切り替え（「意味あり」「意味なし」「すべて」）
function setFilterTab(tab) {
    currentFilterTab = tab;
    hasUserSelectedTab = true;
    sessionStorage.setItem("kuji_filter_tab", tab);
    var searchInput = document.getElementById("search-input");
    var keyword = searchInput ? searchInput.value : "";
    renderWordCards(keyword);
}

function createWordCardElement(item) {
    var isEditing = (editingWordId === item.id);
    var hasMeaning = Boolean(item.meaning && item.meaning.trim() !== "");
    var isCompleted = hasMeaning || Boolean(item.noMeaningNeeded);

    var card = document.createElement("div");
    card.className = isEditing ? "word-card is-editing" : "word-card";
    card.id = "card-" + item.id;

    var top = document.createElement("div");
    top.className = "word-card-top";

    var termWrap = document.createElement("div");
    termWrap.className = "word-term-wrap";

    var term = document.createElement("span");
    term.className = "word-term word-term-editable";
    term.title = "タップして単語・意味を編集";
    term.textContent = item.word;
    term.addEventListener("click", function() {
        startInlineEdit(item.id, true);
    });
    termWrap.appendChild(term);

    top.appendChild(termWrap);

    var actions = document.createElement("div");
    actions.className = "card-actions";

    if (!isEditing) {
        if (!isCompleted) {
            // 「意味なし」カード：辞書から自動取得ボタン
            var autoBtn = document.createElement("button");
            autoBtn.type = "button";
            autoBtn.className = "btn-card-action btn-card-auto";
            autoBtn.title = "辞書（Wiktionary / Wikipedia）から意味を自動取得";
            autoBtn.textContent = "辞書";
            autoBtn.addEventListener("click", function() {
                autoBtn.textContent = "取得中...";
                autoBtn.disabled = true;
                fetchWordMeaningCandidates(item.word).then(function(candidates) {
                    if (candidates && candidates.length > 0) {
                        if (shouldConfirmAutoMeaning()) {
                            autoBtn.textContent = "辞書";
                            autoBtn.disabled = false;
                            openMeaningConfirmQueue([{
                                bookId: item.bookId,
                                word: item.word,
                                candidates: candidates
                            }], function() {
                                saveAllSheets(false);
                                refreshUI();
                            });
                        } else {
                            updateSingleWordLine(item.bookId, item.word, item.word + " : [自動] " + candidates[0]);
                        }
                    } else {
                        autoBtn.textContent = "該当なし";
                        setTimeout(function() {
                            startInlineEdit(item.id);
                        }, 600);
                    }
                });
            });
            actions.appendChild(autoBtn);
        }

        var editBtn = document.createElement("button");
        editBtn.type = "button";
        editBtn.className = isCompleted ? "btn-card-action" : "btn-card-action btn-card-add";
        editBtn.title = "単語や意味を編集";
        editBtn.textContent = isCompleted ? "編集" : "編集 / ＋意味";
        editBtn.addEventListener("click", function() {
            startInlineEdit(item.id, false);
        });
        actions.appendChild(editBtn);

        if (!isCompleted) {
            var knownBtn = document.createElement("button");
            knownBtn.type = "button";
            knownBtn.className = "btn-card-action btn-card-known";
            knownBtn.title = "意味不要（分かる単語）として完了へ移動";
            knownBtn.textContent = "✓";
            knownBtn.addEventListener("click", function() {
                markWordAsKnown(item.bookId, item.word);
            });
            actions.appendChild(knownBtn);
        }
    }

    top.appendChild(actions);
    card.appendChild(top);

    var sourceText = getSourceTagText(item.bookId);
    if (sourceText) {
        var sourceTag = document.createElement("div");
        sourceTag.className = "word-source";
        sourceTag.textContent = sourceText;
        card.appendChild(sourceTag);
    }

    if (isEditing) {
        var editBox = document.createElement("div");
        editBox.className = "inline-edit-box";

        var wordRow = document.createElement("div");
        wordRow.className = "inline-edit-row";
        var wordLabel = document.createElement("span");
        wordLabel.className = "inline-edit-label";
        wordLabel.textContent = "単語";
        wordRow.appendChild(wordLabel);

        var wordInput = document.createElement("input");
        wordInput.type = "text";
        wordInput.id = "inline-word-input-" + item.id;
        wordInput.className = "inline-edit-input inline-word-input";
        wordInput.placeholder = "単語を入力...";
        wordInput.value = item.word;
        wordInput.addEventListener("keydown", function(event) {
            handleInlineKey(event, item.id, item.bookId, item.word, item.noMeaningNeeded);
        });
        wordRow.appendChild(wordInput);
        editBox.appendChild(wordRow);

        var meaningRow = document.createElement("div");
        meaningRow.className = "inline-edit-row";
        var meaningLabel = document.createElement("span");
        meaningLabel.className = "inline-edit-label";
        meaningLabel.textContent = "意味";
        meaningRow.appendChild(meaningLabel);

        var input = document.createElement("input");
        input.type = "text";
        input.id = "inline-input-" + item.id;
        input.className = "inline-edit-input";
        input.placeholder = "意味・メモを入力（空欄で意味なし）...";
        input.value = item.meaning;
        input.addEventListener("keydown", function(event) {
            handleInlineKey(event, item.id, item.bookId, item.word, item.noMeaningNeeded);
        });
        meaningRow.appendChild(input);
        editBox.appendChild(meaningRow);

        if (bookList.length > 0) {
            var bookRow = document.createElement("div");
            bookRow.className = "inline-edit-row";
            var bookLabel = document.createElement("span");
            bookLabel.className = "inline-edit-label";
            bookLabel.textContent = "移動";
            bookRow.appendChild(bookLabel);

            var bookSelect = document.createElement("select");
            bookSelect.id = "inline-book-select-" + item.id;
            bookSelect.className = "inline-edit-input inline-book-select";

            var uncatOpt = document.createElement("option");
            uncatOpt.value = "uncategorized";
            uncatOpt.textContent = "未分類（共通）";
            if (item.bookId === "uncategorized") uncatOpt.selected = true;
            bookSelect.appendChild(uncatOpt);

            bookList.forEach(function(b) {
                var opt = document.createElement("option");
                opt.value = b.id;
                opt.textContent = b.title;
                if (item.bookId === b.id) opt.selected = true;
                bookSelect.appendChild(opt);
            });

            bookRow.appendChild(bookSelect);
            editBox.appendChild(bookRow);
        }

        var candidateBox = document.createElement("div");
        candidateBox.className = "inline-candidates";
        candidateBox.id = "inline-candidates-" + item.id;
        editBox.appendChild(candidateBox);

        var btns = document.createElement("div");
        btns.className = "inline-edit-btns";

        var dictBtn = document.createElement("button");
        dictBtn.type = "button";
        dictBtn.className = "btn-inline-dict";
        dictBtn.textContent = "辞書候補を見る";
        dictBtn.addEventListener("click", function() {
            var currentWordVal = wordInput.value.trim() || item.word;
            showInlineDictionaryCandidates(item.id, currentWordVal);
        });
        btns.appendChild(dictBtn);

        var delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "btn-inline-delete";
        delBtn.textContent = "削除";
        delBtn.addEventListener("click", function() {
            deleteWordFromSheet(item.bookId, item.word);
        });
        btns.appendChild(delBtn);

        var cancelBtn = document.createElement("button");
        cancelBtn.type = "button";
        cancelBtn.className = "btn-inline-cancel";
        cancelBtn.textContent = "キャンセル";
        cancelBtn.addEventListener("click", function() {
            cancelInlineEdit();
        });
        btns.appendChild(cancelBtn);

        var saveBtn = document.createElement("button");
        saveBtn.type = "button";
        saveBtn.className = "btn-inline-save";
        saveBtn.textContent = "保存";
        saveBtn.addEventListener("click", function() {
            saveInlineMeaning(item.id, item.bookId, item.word, item.noMeaningNeeded);
        });
        btns.appendChild(saveBtn);

        editBox.appendChild(btns);
        card.appendChild(editBox);
    } else if (hasMeaning) {
        var desc = document.createElement("p");
        desc.className = "word-desc";
        if (item.isAutoMeaning) {
            var badge = document.createElement("span");
            badge.className = "auto-meaning-badge";
            badge.textContent = "自動";
            desc.appendChild(badge);
        }
        desc.appendChild(document.createTextNode(item.meaning));
        card.appendChild(desc);

        // 自動取得された意味の場合は、ワンタップで「✓確定」「別候補」「意味を消す」ができるバーを表示
        if (item.isAutoMeaning) {
            var verifyBar = document.createElement("div");
            verifyBar.className = "auto-verify-bar";

            var okBtn = document.createElement("button");
            okBtn.type = "button";
            okBtn.className = "btn-auto-verify ok";
            okBtn.textContent = "✓ この意味で確定";
            okBtn.addEventListener("click", function() {
                confirmAutoMeaning(item);
            });
            verifyBar.appendChild(okBtn);

            var nextBtn = document.createElement("button");
            nextBtn.type = "button";
            nextBtn.className = "btn-auto-verify";
            nextBtn.textContent = "別の候補";
            nextBtn.addEventListener("click", function() {
                cycleAutoMeaningCandidate(item);
            });
            verifyBar.appendChild(nextBtn);

            var clearBtn = document.createElement("button");
            clearBtn.type = "button";
            clearBtn.className = "btn-auto-verify danger";
            clearBtn.textContent = "意味だけ消す";
            clearBtn.addEventListener("click", function() {
                clearWordMeaning(item);
            });
            verifyBar.appendChild(clearBtn);

            card.appendChild(verifyBar);
        }
    }

    return card;
}

function showInlineDictionaryCandidates(id, word) {
    var box = document.getElementById("inline-candidates-" + id);
    var input = document.getElementById("inline-input-" + id);
    if (!box || !input) return;

    box.textContent = "辞書を検索中...";
    fetchWordMeaningCandidates(word).then(function(candidates) {
        box.textContent = "";
        if (!candidates || candidates.length === 0) {
            box.textContent = "辞書候補が見つかりませんでした";
            return;
        }
        candidates.forEach(function(cand, idx) {
            var chip = document.createElement("button");
            chip.type = "button";
            chip.className = "candidate-chip";
            chip.textContent = "候補" + (idx + 1) + ": " + cand;
            chip.addEventListener("click", function() {
                input.value = cand;
                input.focus();
            });
            box.appendChild(chip);
        });
    });
}

// ⑥ 単語カード一覧の描画（本棚フィルター＋意味あり・意味なし分離）
function renderWordCards(filterKeyword) {
    var container = document.getElementById("word-list");
    var filteredCountElem = document.getElementById("filtered-count");
    if (!container) return;

    // 1. 選択中の本タブで絞り込み
    var bookScopedList = wordList;
    if (currentBookTab !== "all_books") {
        bookScopedList = wordList.filter(function(item) {
            return item.bookId === currentBookTab;
        });
    }

    // 2. 検索キーワードで絞り込み
    var searchedList = bookScopedList;
    if (filterKeyword && filterKeyword.trim() !== "") {
        var keyword = filterKeyword.trim().toLowerCase();
        searchedList = bookScopedList.filter(function(item) {
            return item.word.toLowerCase().includes(keyword) || 
                   item.meaning.toLowerCase().includes(keyword);
        });
    }

    // 意味の有無によるグループ分けは行わず、登録順のフラットな1リストで表示
    var displayList = searchedList;

    if (filteredCountElem) {
        filteredCountElem.innerText = displayList.length + " 件";
    }

    container.textContent = "";

    if (displayList.length === 0) {
        var emptyPager = document.getElementById("list-pager");
        if (emptyPager) emptyPager.style.display = "none";
        var emptyDiv = document.createElement("div");
        emptyDiv.className = "empty-state";
        if (filterKeyword && filterKeyword.trim() !== "") {
            emptyDiv.textContent = "「" + filterKeyword + "」に一致する単語は見つかりませんでした";
        } else {
            emptyDiv.appendChild(document.createTextNode("このシートにはまだ単語が登録されていません。"));
            emptyDiv.appendChild(document.createElement("br"));
            var addLink = document.createElement("a");
            addLink.href = "./edit.html";
            addLink.className = "link-add-empty";
            addLink.textContent = "単語を登録・編集";
            emptyDiv.appendChild(addLink);
        }
        container.appendChild(emptyDiv);
        return;
    }

    // 1ページ100件。ページ番号は一覧上部に表示
    var listPageCount = Math.max(1, Math.ceil(displayList.length / LIST_PAGE_SIZE));
    listPageIndex = Math.min(Math.max(0, listPageIndex), listPageCount - 1);
    var pageStart = listPageIndex * LIST_PAGE_SIZE;
    var visibleList = displayList.slice(pageStart, pageStart + LIST_PAGE_SIZE);

    var listPager = document.getElementById("list-pager");
    if (listPager) {
        renderPageNumbers(listPager, displayList.length, LIST_PAGE_SIZE, listPageIndex, function(idx) {
            listPageIndex = idx;
            editingWordId = null;
            var si = document.getElementById("search-input");
            renderWordCards(si ? si.value : "");
            container.scrollTop = 0;
        });
    }

    var fragment = document.createDocumentFragment();
    visibleList.forEach(function(item) {
        fragment.appendChild(createWordCardElement(item));
    });

    container.appendChild(fragment);

    if (editingWordId) {
        var targetInputId = editingFocusWord ? ("inline-word-input-" + editingWordId) : ("inline-input-" + editingWordId);
        var editInput = document.getElementById(targetInputId) || document.getElementById("inline-input-" + editingWordId);
        if (editInput) {
            editInput.focus();
            editInput.select();
        }
    }
}

// 特定のシート内の1単語行を更新して保存・再描画する共通ヘルパー
function updateSingleWordLine(bookId, targetWord, replacementLine) {
    var targetBook = bookId || "uncategorized";
    var lines = sheetLines[targetBook] || [];
    var updated = false;

    for (var i = 0; i < lines.length; i++) {
        var trimmed = lines[i].trim();
        if (!trimmed) continue;

        var word = trimmed;
        var match = trimmed.match(/^([^:：\t]+)[:：\t]/);
        if (match) {
            word = match[1].trim();
        }

        if (word === targetWord) {
            lines[i] = replacementLine;
            updated = true;
            break;
        }
    }

    if (updated) {
        saveAllSheets(false);
        refreshUI();
    }
}

function markWordAsKnown(bookId, targetWord) {
    updateSingleWordLine(bookId, targetWord, targetWord + " : ✓");
}

// ⑦ インライン編集（一覧カード上で単語・意味を編集）
var editingFocusWord = false;

function startInlineEdit(id, focusWord) {
    editingWordId = id;
    editingFocusWord = Boolean(focusWord);
    var searchInput = document.getElementById("search-input");
    var keyword = searchInput ? searchInput.value : "";
    renderWordCards(keyword);
}

function cancelInlineEdit() {
    editingWordId = null;
    editingFocusWord = false;
    var searchInput = document.getElementById("search-input");
    var keyword = searchInput ? searchInput.value : "";
    renderWordCards(keyword);
}

function handleInlineKey(event, id, bookId, targetWord, wasNoMeaningNeeded) {
    if (event.key === "Enter") {
        saveInlineMeaning(id, bookId, targetWord, wasNoMeaningNeeded);
    } else if (event.key === "Escape") {
        cancelInlineEdit();
    }
}

function saveInlineMeaning(id, bookId, targetWord, wasNoMeaningNeeded) {
    var wordInput = document.getElementById("inline-word-input-" + id);
    var editInput = document.getElementById("inline-input-" + id);
    var bookSelect = document.getElementById("inline-book-select-" + id);
    if (!editInput) return;

    var newWord = wordInput ? wordInput.value.trim() : targetWord;
    if (!newWord) {
        alert("単語を入力してください");
        if (wordInput) wordInput.focus();
        return;
    }

    var newMeaning = cleanMeaning(editInput.value.trim());
    var newLine = newWord;
    if (newMeaning) {
        newLine = newWord + " : " + newMeaning;
    } else if (wasNoMeaningNeeded) {
        newLine = newWord + " : ✓";
    }

    var destBookId = bookSelect ? bookSelect.value : (bookId || "uncategorized");
    var sourceBookId = bookId || "uncategorized";

    editingWordId = null;
    editingFocusWord = false;

    if (destBookId !== sourceBookId) {
        // 別の本（シート）へ単語を移動する
        var srcLines = sheetLines[sourceBookId] || [];
        var removed = false;
        sheetLines[sourceBookId] = srcLines.filter(function(line) {
            if (removed) return true;
            var trimmed = line.trim();
            if (!trimmed) return false;
            var w = trimmed;
            var m = trimmed.match(/^([^:：\t]+)[:：\t]/);
            if (m) w = m[1].trim();
            if (w === targetWord) {
                removed = true;
                return false;
            }
            return true;
        });
        if (!sheetLines[destBookId]) {
            sheetLines[destBookId] = [];
        }
        sheetLines[destBookId].push(newLine);
        saveAllSheets(false);
        refreshUI();
    } else {
        updateSingleWordLine(sourceBookId, targetWord, newLine);
    }
}

// ⑧ 単語の削除（重複登録されている場合もすべてのシートから一括削除して復活を防止）
function deleteWordFromSheet(bookId, targetWord) {
    if (!confirm("「" + targetWord + "」を削除しますか？")) return;

    Object.keys(sheetLines).forEach(function(bId) {
        var lines = sheetLines[bId] || [];
        sheetLines[bId] = lines.filter(function(line) {
            var word = extractWordKeyFromLine(line);
            return word !== targetWord;
        });
    });

    saveAllSheets(false);
    refreshUI();
}

// ⑨ 検索入力
function handleSearch() {
    listPageIndex = 0;
    var searchInput = document.getElementById("search-input");
    var keyword = searchInput ? searchInput.value : "";
    renderWordCards(keyword);
}

// ⑪ 現在の本シートをクリア
function clearAllWords() {
    var editBookId = getEffectiveBookIdForEdit();
    var title = getBookTitleById(editBookId);
    if (confirm("「" + title + "」シートに登録されている単語をすべて消去しますか？")) {
        sheetLines[editBookId] = [];
        saveAllSheets(false);
        refreshUI();
    }
}

// ==================== ⑫ 重複なしランダムピックアップ（山札シャッフル方式） ====================

function getActiveDrawPool() {
    // 選択中のシートに関わらず、常に全登録単語から抽選
    return wordList;
}

function buildShuffledDeck(pool) {
    var keys = pool.map(function(item) {
        return item.bookId + "::" + item.word;
    });
    // Fisher-Yates シャッフル
    for (var i = keys.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var tmp = keys[i];
        keys[i] = keys[j];
        keys[j] = tmp;
    }
    // 山札リセット直後の1枚目が直前に引いた単語と被らないように調整
    if (keys.length > 1 && lastDrawnKey && keys[keys.length - 1] === lastDrawnKey) {
        var swapIdx = Math.floor(Math.random() * (keys.length - 1));
        var t = keys[keys.length - 1];
        keys[keys.length - 1] = keys[swapIdx];
        keys[swapIdx] = t;
    }
    return keys;
}

function syncDrawDeckWithPool(pool) {
    var sig = pool.map(function(w) { return w.bookId + ":" + w.word; }).join(",");
    var validSet = {};
    pool.forEach(function(w) {
        validSet[w.bookId + "::" + w.word] = w;
    });

    // タブ（対象シート）やプールが切り替わった場合は、山札を新しいプールの全単語で再構築
    if (sig !== lastPoolSignature) {
        lastPoolSignature = sig;
        drawDeck = buildShuffledDeck(pool);
        return;
    }

    // 同じタブ内で単語が削除・編集された場合は無効なキーを除去
    drawDeck = drawDeck.filter(function(k) { return Boolean(validSet[k]); });

    // 山札が尽きたら新しい山札をシャッフル生成（一巡完了）
    if (drawDeck.length === 0 && pool.length > 0) {
        drawDeck = buildShuffledDeck(pool);
    }
}

function updateDrawDeckInfo() {
    // 残り回数の表示は廃止。山札（一巡するまで重複しない）の同期のみ行う
    var pool = getActiveDrawPool();
    if (pool.length === 0) return;
    syncDrawDeckWithPool(pool);
}

function drawWord() {
    if (isDrawing) return;

    syncWordList();
    var pool = getActiveDrawPool();
    if (pool.length === 0) {
        alert("単語が登録されていません。「単語を登録・編集」から単語を入力してください！");
        return;
    }

    var resultBox = document.getElementById("draw-result");
    var resultWord = document.getElementById("result-word");
    var resultMeaning = document.getElementById("result-meaning");
    var drawBtn = document.getElementById("draw-btn");

    resultBox.style.display = "block";

    if (pool.length === 1) {
        setDrawResult(pool[0]);
        resultBox.classList.remove("popping");
        void resultBox.offsetWidth;
        resultBox.classList.add("popping");
        updateDrawDeckInfo();
        return;
    }

    syncDrawDeckWithPool(pool);
    var chosenKey = drawDeck.pop();
    lastDrawnKey = chosenKey;

    var chosenItem = pool[0];
    for (var i = 0; i < pool.length; i++) {
        if ((pool[i].bookId + "::" + pool[i].word) === chosenKey) {
            chosenItem = pool[i];
            break;
        }
    }

    // ルーレット演出
    isDrawing = true;
    drawBtn.disabled = true;
    resultBox.classList.remove("popping");

    var shuffleCount = 0;
    var maxShuffles = 8;
    var intervalSpeed = 45;

    var timer = setInterval(function() {
        var tempIndex = Math.floor(Math.random() * pool.length);
        resultWord.innerText = pool[tempIndex].word;
        resultMeaning.innerText = "";
        var srcElem = document.getElementById("result-source");
        if (srcElem) srcElem.style.display = "none";
        shuffleCount++;

        if (shuffleCount >= maxShuffles) {
            clearInterval(timer);

            setDrawResult(chosenItem);
            updateDrawDeckInfo();

            void resultBox.offsetWidth;
            resultBox.classList.add("popping");

            isDrawing = false;
            drawBtn.disabled = false;
        }
    }, intervalSpeed);
}

function setDrawResult(selected) {
    var resultWord = document.getElementById("result-word");
    var resultMeaning = document.getElementById("result-meaning");

    resultWord.innerText = selected.word;
    if (selected.meaning && selected.meaning.trim() !== "") {
        resultMeaning.innerText = selected.meaning;
        resultMeaning.style.display = "inline-block";
    } else {
        resultMeaning.innerText = "";
        resultMeaning.style.display = "none";
    }
    var resultSource = document.getElementById("result-source");
    if (resultSource) {
        var srcText = getSourceTagText(selected.bookId);
        resultSource.textContent = srcText;
        resultSource.style.display = srcText ? "" : "none";
    }
}
