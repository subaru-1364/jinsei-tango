// ==================== アプリケーション初期化・全体制御 (app.js) ====================

function setGateVisibility(isLoggedIn, messageText, showButton) {
    var gate = document.getElementById("login-gate");
    var main = document.getElementById("app-main");
    var gateMsg = document.getElementById("gate-message");
    var gateBtn = document.getElementById("gate-login-btn");
    var localBtn = document.getElementById("gate-local-btn");

    if (document.documentElement) {
        if (isLoggedIn) {
            document.documentElement.classList.add("auth-hint-logged-in");
            document.documentElement.classList.remove("auth-hint-redirecting");
        } else {
            document.documentElement.classList.remove("auth-hint-logged-in");
        }
    }

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

function enterLocalPreviewMode() {
    sessionStorage.setItem("kuji_local_preview", "1");
    setGateVisibility(true, "", false);
    updateSyncStatus("ローカル確認中", false);
    refreshUI();
}

function refreshUI() {
    syncConfirmToggleUI();
    renderBookTabs();
    renderActiveBookMeta();

    var wordListContainer = document.getElementById("word-list");
    if (wordListContainer) {
        var searchInput = document.getElementById("search-input");
        renderWordCards(searchInput ? searchInput.value : "");
        updateDrawDeckInfo();
    }
}

// ページ読み込み時の初期化
window.addEventListener("DOMContentLoaded", function() {
    loadLocalData();
    syncConfirmToggleUI();

    var hasAuthHint = false;
    try {
        hasAuthHint = (localStorage.getItem("kuji_logged_in_hint") === "1");
    } catch (e) {}

    if (isLocalEnvironment()) {
        enterLocalPreviewMode();
    } else if (hasAuthHint) {
        refreshUI();
    }
    initFirebase();

    var coverModal = document.getElementById("book-cover-modal");
    if (coverModal) {
        coverModal.addEventListener("click", function(e) {
            if (e.target === coverModal) {
                closeBookCoverModal();
            }
        });
    }

    var wordAddModal = document.getElementById("word-add-modal");
    if (wordAddModal) {
        wordAddModal.addEventListener("click", function(e) {
            if (e.target === wordAddModal) {
                closeWordAddModal();
            }
        });
    }

    var quickAddInput = document.getElementById("quick-add-input");
    if (quickAddInput) {
        quickAddInput.addEventListener("keydown", function(e) {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                e.preventDefault();
                addQuickWordFromModal();
            }
        });
    }

    window.addEventListener("keydown", function(e) {
        if (e.key === "Escape") {
            var bsm = document.getElementById("book-search-modal");
            if (bsm && bsm.style.display !== "none") {
                closeBookSearchModal();
                return;
            }
            var wam = document.getElementById("word-add-modal");
            if (wam && wam.style.display !== "none") {
                closeWordAddModal();
                return;
            }
            var cm = document.getElementById("book-cover-modal");
            if (cm && cm.style.display !== "none") {
                closeBookCoverModal();
            }
        }
    });
});

// モーダル内に未追加の入力がある状態で誤ってタブを閉じようとした場合のみ警告
window.addEventListener("beforeunload", function(event) {
    var quickInput = document.getElementById("quick-add-input");
    if (!ignoreBeforeUnload && quickInput && quickInput.value.trim() !== "") {
        event.preventDefault();
        event.returnValue = "";
    }
});
