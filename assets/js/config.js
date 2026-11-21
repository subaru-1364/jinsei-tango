// ==================== 設定・定数・共有ステート (config.js) ====================

const DATA_SCHEMA_VERSION = 2;
const LIST_PAGE_SIZE = 100; // 登録単語リストの1ページあたりの件数

// Firebase クライアント識別設定（公開ID。セキュリティは承認済みドメイン制限とDBルールで担保）
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

// 書影（単色背表紙）用の伝統色12色パレット
const BOOK_COVER_PALETTE = [
    { name: "紺青", hex: "#1e3a5f" },
    { name: "深緑", hex: "#1b4d3e" },
    { name: "茜色", hex: "#8b263e" },
    { name: "煉瓦", hex: "#a84328" },
    { name: "山吹", hex: "#b8860b" },
    { name: "墨色", hex: "#2d3748" },
    { name: "紫苑", hex: "#5b3256" },
    { name: "浅葱", hex: "#1f6670" },
    { name: "萌黄", hex: "#4a6741" },
    { name: "栗色", hex: "#5c3a21" },
    { name: "珊瑚", hex: "#b04a5a" },
    { name: "藍鼠", hex: "#2e4057" }
];

// ==================== アプリケーション共有データステート ====================
// bookList: [{ id, isbn, title, author, cover, order, createdAt }]
let bookList = [];
// wordList: [{ id, word, meaning, bookId, isAutoMeaning, noMeaningNeeded, order, createdAt }]
let wordList = [];

// 現在選択中の本棚タブ ("all_books" | "uncategorized" | book.id)
let currentBookTab = sessionStorage.getItem("kuji_book_tab") || "all_books";
let listPageIndex = 0;
let wordSortOrder = (function() {
    try {
        return localStorage.getItem("kuji_word_sort_order") === "desc" ? "desc" : "asc";
    } catch (e) {
        return "asc";
    }
})();

// インライン編集状態
let editingWordId = null;
let editingFocusWord = false;

// API取得結果の一時キャッシュ（メモリ上のみ）
let meaningCandidatesCache = {};
let candidateCycleIndex = {};
let bookCoverCache = {};

// 未保存ガード制御フラグ
let ignoreBeforeUnload = false;

// ==================== 共通ユーティリティ関数 ====================

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

function syncWordSortUI() {
    var ascBtn = document.getElementById("word-sort-asc-btn");
    var descBtn = document.getElementById("word-sort-desc-btn");
    var isDesc = (wordSortOrder === "desc");
    if (ascBtn) {
        ascBtn.classList.toggle("active", !isDesc);
        ascBtn.setAttribute("aria-pressed", !isDesc ? "true" : "false");
    }
    if (descBtn) {
        descBtn.classList.toggle("active", isDesc);
        descBtn.setAttribute("aria-pressed", isDesc ? "true" : "false");
    }
}

// 比較・重複判定用の正規化キー（連続空白を半角スペース1つに統一し小文字化）
function normalizeWordKey(word) {
    return String(word || "").replace(/\s+/g, " ").trim().toLowerCase();
}

// 旧データ移行・入力整形用の意味クレンジング
function cleanMeaning(str) {
    if (!str) return "";
    var s = String(str).trim();
    if (
        s.indexOf("意味は未登録です") !== -1 ||
        s === "（意味未設定）" ||
        s === "(意味未設定)" ||
        s === "（意味は未登録です。必要に応じて再登録してください）"
    ) {
        return "";
    }
    return s;
}

// 書影URLのサニタイズ（httpsスキーム強制・危険スキーム遮断・規約外ドメイン除外）
function sanitizeCoverUrl(url) {
    if (!url || typeof url !== "string") return "";
    var clean = url.trim().replace(/[\r\n\t]/g, "");
    if (!clean) return "";
    // 規約上使用禁止のApple Books / NDLサムネイルURLは破棄
    if (/mzstatic\.com|apple\.com|ndlsearch\.ndl\.go\.jp\/thumbnail/i.test(clean)) {
        return "";
    }
    // http / https または安全な data:image 以外のスキームを遮断
    if (!/^https?:\/\//i.test(clean) && !/^data:image\/(?:png|jpeg|jpg|webp|gif);base64,/i.test(clean)) {
        return "";
    }
    clean = clean.replace(/^http:\/\//i, "https://");
    clean = clean.replace(/&edge=curl/g, "").replace(/\?edge=curl&/g, "?").replace(/\?edge=curl$/g, "");
    return clean;
}

// 書籍名・IDから決定論的に落ち着いた単色カラーを割り当て（デフォルト色）
function getDeterministicBookColor(seed) {
    var str = String(seed || "").trim();
    if (!str) return BOOK_COVER_PALETTE[0].hex;
    var hash = 0;
    for (var i = 0; i < str.length; i++) {
        hash = (hash << 5) - hash + str.charCodeAt(i);
        hash |= 0;
    }
    var idx = Math.abs(hash) % BOOK_COVER_PALETTE.length;
    return BOOK_COVER_PALETTE[idx].hex;
}

// 単色背景上の文字コントラスト（白 / 黒）を自動判定（YIQ比）
function getContrastTextColor(hexColor) {
    if (!hexColor || hexColor.charAt(0) !== "#") return "#ffffff";
    var hex = hexColor.slice(1);
    if (hex.length === 3) {
        hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    }
    var r = parseInt(hex.substring(0, 2), 16) || 0;
    var g = parseInt(hex.substring(2, 4), 16) || 0;
    var b = parseInt(hex.substring(4, 6), 16) || 0;
    var yiq = (r * 299 + g * 587 + b * 114) / 1000;
    return yiq >= 155 ? "#1c1917" : "#ffffff";
}

// 書籍の表紙種別と値（画像URL / 単色カラー / 自動デフォルト単色）を判定
function getBookCoverInfo(book) {
    if (!book) {
        return { type: "color", value: BOOK_COVER_PALETTE[0].hex, isDefault: true };
    }
    var raw = String(book.cover || bookCoverCache[book.id] || (book.isbn ? bookCoverCache[book.isbn] : "") || "").trim();

    if (/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(raw) || /^color:/i.test(raw)) {
        var colorVal = raw.replace(/^color:/i, "").trim();
        return { type: "color", value: colorVal, isDefault: false };
    }

    if (/^https?:\/\//i.test(raw) || /^data:image\//i.test(raw)) {
        var safeUrl = sanitizeCoverUrl(raw);
        if (safeUrl) {
            return { type: "image", value: safeUrl, isDefault: false };
        }
    }

    var defColor = getDeterministicBookColor(book.title || book.id || "無題");
    return { type: "color", value: defColor, isDefault: true };
}
