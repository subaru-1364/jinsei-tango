// ==================== 本棚タブ・書籍検索・書影カラー設定モーダル (ui-books.js) ====================

let draggedBookTabId = null;
let isBookReorderMode = false;
let bookTabsWheelBound = false;
let isBookSearchModalOpen = false;

let currentCoverModalBookId = null;
let coverModalDraft = { type: "color", value: "#1e3a5f", isDefault: true };

// ==================== シンプルSVGピンアイコン生成 (Lucide標準ピン) ====================

function createSvgPinIcon(size) {
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "icon-line icon-pin");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    if (size) {
        svg.style.width = size + "px";
        svg.style.height = size + "px";
    }

    // 針部分
    var line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", "12");
    line.setAttribute("y1", "17");
    line.setAttribute("x2", "12");
    line.setAttribute("y2", "22");
    svg.appendChild(line);

    // ピン本体（頭部・首・胴体・底面）
    var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z");
    svg.appendChild(path);

    return svg;
}

// ==================== ISBN / 書名検索パネル ====================

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
        if (btn) btn.disabled = true;
        if (status) status.textContent = "「" + raw + "」で本を検索中...";
        searchBooksByTitleKeyword(raw).then(function(candidates) {
            if (btn) btn.disabled = false;
            renderBookSearchCandidates(raw, candidates);
        });
        return;
    }

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
                registerBookObject(isbn, manualTitle.trim(), "", "");
                input.value = "";
                if (status) status.textContent = "追加完了: 『" + manualTitle.trim() + "』";
            } else if (status) {
                status.textContent = "書名の取得をキャンセルしました";
            }
        }
    });
}

function renderBookSearchCandidates(rawQuery, candidates) {
    var status = document.getElementById("isbn-status");
    var resultsBox = document.getElementById("isbn-search-results");
    var input = document.getElementById("isbn-input");
    if (!resultsBox) return;

    resultsBox.textContent = "";

    if (candidates && candidates.length > 0) {
        if (status) {
            status.textContent = "追加する本を選択してください（または下のボタンでオリジナルの本として作成）：";
        }
        candidates.forEach(function(cand) {
            var row = document.createElement("button");
            row.type = "button";
            row.className = "book-search-item";

            if (cand.cover) {
                var img = document.createElement("img");
                img.className = "book-search-thumb";
                img.referrerPolicy = "no-referrer";
                img.src = cand.cover;
                img.alt = cand.title;
                img.addEventListener("error", function() {
                    var ph = renderCoverSpineElement(cand.title, getDeterministicBookColor(cand.title), "thumb");
                    ph.className = "book-search-thumb book-cover-placeholder";
                    if (img.parentNode) {
                        img.parentNode.replaceChild(ph, img);
                    }
                });
                row.appendChild(img);
            } else {
                var ph = renderCoverSpineElement(cand.title, getDeterministicBookColor(cand.title), "thumb");
                ph.className = "book-search-thumb book-cover-placeholder";
                row.appendChild(ph);
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
    } else if (status) {
        status.textContent = "「" + rawQuery + "」に一致する書籍データは見つかりませんでした。オリジナルの本として作成できます：";
    }

    var directBtn = document.createElement("button");
    directBtn.type = "button";
    directBtn.className = "book-search-direct";
    directBtn.textContent = "＋ 「" + rawQuery + "」というオリジナルの本を作成";
    directBtn.addEventListener("click", function() {
        registerBookObject("", rawQuery, "", "");
        if (input) input.value = "";
        resultsBox.textContent = "";
        if (status) status.textContent = "本「" + rawQuery + "」を作成しました";
    });
    resultsBox.appendChild(directBtn);
}

function registerBookObject(isbn, title, author, coverUrl) {
    var cleanIsbn = (isbn || "").trim();
    var finalCover = sanitizeBookCoverField(coverUrl || (cleanIsbn ? bookCoverCache[cleanIsbn] : "") || "");
    var existingBook = null;

    if (cleanIsbn) {
        for (var i = 0; i < bookList.length; i++) {
            if (bookList[i].isbn === cleanIsbn) {
                existingBook = bookList[i];
                break;
            }
        }
    }

    var targetId;
    if (existingBook) {
        targetId = existingBook.id;
        if (finalCover && !existingBook.cover) {
            existingBook.cover = finalCover;
        }
    } else {
        targetId = generateBookId(cleanIsbn);
        // 万が一同一IDがあればユニーク化
        if (getBookById(targetId)) {
            targetId = generateBookId("");
        }
        bookList.push({
            id: targetId,
            isbn: cleanIsbn,
            title: (title || "").trim() || "無題の書籍",
            author: (author || "").trim(),
            cover: finalCover,
            order: bookList.length * 10,
            createdAt: Date.now()
        });
    }

    if (finalCover) {
        bookCoverCache[targetId] = finalCover;
        if (cleanIsbn) bookCoverCache[cleanIsbn] = finalCover;
    }

    currentBookTab = targetId;
    sessionStorage.setItem("kuji_book_tab", targetId);
    saveAllData(false);
    refreshUI();
}

// ==================== 本棚タブ操作・並び替え・削除 ====================

function toggleBookPin(bookId) {
    var book = getBookById(bookId);
    if (!book) return;
    book.pinned = !book.pinned;

    // order（本来の並び順）は変更せず、タブ表示時のみ先頭へ集約する
    saveAllData(false);
    renderBookTabs();
    renderActiveBookMeta();

    var msg = book.pinned
        ? "『" + book.title + "』をピン留めしました（タブ先頭に固定表示）"
        : "『" + book.title + "』のピン留めを解除しました（元の位置に戻りました）";
    showSaveFeedback(msg);
}

function selectBookTab(bookId) {
    if (currentBookTab !== bookId) {
        currentBookTab = bookId;
        listPageIndex = 0;
        editingWordId = null;
        sessionStorage.setItem("kuji_book_tab", bookId);
        resetDrawDeck();
    }
    refreshUI();
}

function deleteCurrentBook() {
    var targetId = currentBookTab;
    var book = getBookById(targetId);
    if (!book) return;

    var count = 0;
    for (var i = 0; i < wordList.length; i++) {
        if (wordList[i].bookId === targetId) count++;
    }

    var msg = count > 0
        ? "『" + book.title + "』を本棚から削除しますか？\n（この本に登録されている " + count + " 件の単語は「未分類」へ移動して保護されます）"
        : "『" + book.title + "』を本棚から削除しますか？";
    if (!confirm(msg)) return;

    for (var j = 0; j < wordList.length; j++) {
        if (wordList[j].bookId === targetId) {
            wordList[j].bookId = "uncategorized";
        }
    }
    bookList = bookList.filter(function(b) { return b.id !== targetId; });

    editingWordId = null;
    currentBookTab = "all_books";
    sessionStorage.setItem("kuji_book_tab", currentBookTab);
    saveAllData(false);
    refreshUI();
}

function toggleBookReorderMode() {
    if (bookList.length <= 1) {
        isBookReorderMode = false;
    } else {
        isBookReorderMode = !isBookReorderMode;
    }
    if (isBookReorderMode && bookList.length > 0) {
        if (currentBookTab === "all_books" || currentBookTab === "uncategorized") {
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

    var temp = bookList[idx];
    bookList[idx] = bookList[targetIdx];
    bookList[targetIdx] = temp;

    editingWordId = null;
    saveAllData(false);
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
    saveAllData(false);
    refreshUI();
}

function renderBookTabs() {
    var container = document.getElementById("book-tabs");
    if (!container) return;

    if (bookList.length <= 1 && isBookReorderMode) {
        isBookReorderMode = false;
    }

    var searchJumpBtn = document.getElementById("book-search-jump-btn");
    if (searchJumpBtn) {
        searchJumpBtn.style.display = (bookList.length > 0) ? "inline-flex" : "none";
    }

    var reorderBtn = document.getElementById("book-reorder-btn");
    if (reorderBtn) {
        if (bookList.length > 1) {
            reorderBtn.style.display = "inline-flex";
            reorderBtn.classList.toggle("active", isBookReorderMode);
            reorderBtn.title = isBookReorderMode ? "完了" : "並び替え";
            reorderBtn.setAttribute("aria-label", isBookReorderMode ? "完了" : "並び替え");
            reorderBtn.textContent = "";
            var reorderSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            reorderSvg.setAttribute("class", "icon-line");
            reorderSvg.setAttribute("viewBox", "0 0 16 16");
            reorderSvg.setAttribute("aria-hidden", "true");
            var reorderPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
            if (isBookReorderMode) {
                reorderPath.setAttribute("d", "M3 8.5 6.5 12 13 4");
            } else {
                reorderPath.setAttribute("d", "M3 5h10M9 2l4 3-4 3M13 11H3m4-3-4 3 4 3");
            }
            reorderSvg.appendChild(reorderPath);
            reorderBtn.appendChild(reorderSvg);

            var labelSpan = document.createElement("span");
            labelSpan.textContent = isBookReorderMode ? "完了" : "並び替え";
            reorderBtn.appendChild(labelSpan);
        } else {
            reorderBtn.style.display = "none";
            reorderBtn.classList.remove("active");
        }
    }

    // 1回の走査で各bookIdの件数を集計
    var countsByBook = { uncategorized: 0 };
    for (var wIdx = 0; wIdx < wordList.length; wIdx++) {
        var bid = wordList[wIdx].bookId || "uncategorized";
        countsByBook[bid] = (countsByBook[bid] || 0) + 1;
    }

    container.classList.toggle("is-reordering", isBookReorderMode);
    container.textContent = "";
    var fragment = document.createDocumentFragment();

    function createTabButton(id, titleText, count, isDraggableBook) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = (currentBookTab === id) ? "book-tab active" : "book-tab";
        btn.title = titleText + " (" + count + "件)";

        if (isDraggableBook) {
            var bObj = getBookById(id);
            if (bObj) {
                if (bObj.pinned) {
                    btn.classList.add("is-pinned");
                }
                var dot = document.createElement("span");
                dot.className = "book-tab-color-dot";
                var cInfo = getBookCoverInfo(bObj);
                dot.style.backgroundColor = (cInfo.type === "color") ? cInfo.value : getDeterministicBookColor(bObj.title);
                btn.appendChild(dot);
            }
        }

        var titleSpan = document.createElement("span");
        titleSpan.className = "book-tab-title";
        titleSpan.textContent = titleText;
        btn.appendChild(titleSpan);

        if (isDraggableBook) {
            var bObj2 = getBookById(id);
            if (bObj2 && bObj2.pinned) {
                var pinBadge = document.createElement("span");
                pinBadge.className = "book-tab-pin-badge";
                pinBadge.title = "ピン留め中";
                pinBadge.appendChild(createSvgPinIcon(11));
                btn.appendChild(pinBadge);
            }
        }

        var countSpan = document.createElement("span");
        countSpan.className = "book-tab-count";
        countSpan.textContent = String(count);
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

    fragment.appendChild(createTabButton("all_books", "すべて", wordList.length, false));
    fragment.appendChild(createTabButton("uncategorized", "未分類", countsByBook.uncategorized || 0, false));

    if (isBookReorderMode) {
        // 並び替えモード中は本来の順序（order順）で表示して整えやすくする
        bookList.forEach(function(book) {
            fragment.appendChild(createTabButton(book.id, book.title, countsByBook[book.id] || 0, true));
        });
    } else {
        // 通常時はピン留めされた本を先頭（すべて・未分類の直後）に配置
        // ※ pinnedBooks も normalBooks も元の order 順序を保ったまま分割されるため、解除時は元の位置に正確に戻る
        var pinnedBooks = [];
        var normalBooks = [];
        bookList.forEach(function(b) {
            if (b.pinned) {
                pinnedBooks.push(b);
            } else {
                normalBooks.push(b);
            }
        });

        pinnedBooks.forEach(function(book) {
            fragment.appendChild(createTabButton(book.id, book.title, countsByBook[book.id] || 0, true));
        });

        if (pinnedBooks.length > 0 && normalBooks.length > 0) {
            var divider = document.createElement("span");
            divider.className = "book-tab-divider";
            divider.setAttribute("aria-hidden", "true");
            fragment.appendChild(divider);
        }

        normalBooks.forEach(function(book) {
            fragment.appendChild(createTabButton(book.id, book.title, countsByBook[book.id] || 0, true));
        });
    }

    container.appendChild(fragment);

    // アクティブなタブが見える位置に自動スクロール
    var activeTab = container.querySelector(".book-tab.active");
    if (activeTab && typeof activeTab.scrollIntoView === "function") {
        try {
            activeTab.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
        } catch (err) {}
    }

    // PCマウスホイール操作時の横スクロール支援（未登録時のみ）
    if (!bookTabsWheelBound) {
        bookTabsWheelBound = true;
        container.addEventListener("wheel", function(e) {
            if (isBookReorderMode) return;
            if (e.deltaY !== 0 && (container.scrollWidth > container.clientWidth)) {
                container.scrollLeft += e.deltaY;
                e.preventDefault();
            }
        }, { passive: false });
    }
}

// ==================== 本クイック検索モーダル ====================

function openBookSearchModal() {
    var modal = document.getElementById("book-search-modal");
    if (!modal) return;

    var totalBadge = document.getElementById("book-search-total-count");
    if (totalBadge) {
        totalBadge.textContent = "全" + bookList.length + "冊";
    }

    var input = document.getElementById("book-search-filter-input");
    if (input) {
        input.value = "";
        // 初回のみinputリスナーを紐付け
        if (!input.dataset.bound) {
            input.dataset.bound = "1";
            input.addEventListener("input", function() {
                renderBookSearchModalList(this.value);
            });
            input.addEventListener("keydown", function(e) {
                if (e.key === "Enter") {
                    var list = document.getElementById("book-search-modal-list");
                    if (list) {
                        var firstItem = list.querySelector(".book-search-item");
                        if (firstItem && typeof firstItem.click === "function") {
                            e.preventDefault();
                            firstItem.click();
                        }
                    }
                } else if (e.key === "Escape") {
                    closeBookSearchModal();
                }
            });
        }
    }

    renderBookSearchModalList("");
    modal.style.display = "flex";
    isBookSearchModalOpen = true;

    // モーダル背景クリックで閉じる処理
    if (!modal.dataset.bound) {
        modal.dataset.bound = "1";
        modal.addEventListener("click", function(e) {
            if (e.target === modal) {
                closeBookSearchModal();
            }
        });
    }

    if (input) {
        setTimeout(function() { input.focus(); }, 50);
    }
}

function closeBookSearchModal() {
    var modal = document.getElementById("book-search-modal");
    if (modal) {
        modal.style.display = "none";
    }
    isBookSearchModalOpen = false;
}

function renderBookSearchModalList(filterKeyword) {
    var container = document.getElementById("book-search-modal-list");
    if (!container) return;
    container.textContent = "";

    var kw = String(filterKeyword || "").trim().toLowerCase();

    // 各本の登録単語数を集計
    var countsByBook = { uncategorized: 0 };
    for (var wIdx = 0; wIdx < wordList.length; wIdx++) {
        var bid = wordList[wIdx].bookId || "uncategorized";
        countsByBook[bid] = (countsByBook[bid] || 0) + 1;
    }

    var items = [];

    // 「すべて」
    if (!kw || "すべて".indexOf(kw) !== -1 || "all".indexOf(kw) !== -1) {
        items.push({
            id: "all_books",
            title: "すべて",
            author: "登録されている全単語",
            count: wordList.length,
            color: "#6b7280",
            isActive: (currentBookTab === "all_books")
        });
    }

    // 「未分類」
    if (!kw || "未分類".indexOf(kw) !== -1 || "uncategorized".indexOf(kw) !== -1) {
        items.push({
            id: "uncategorized",
            title: "未分類",
            author: "書籍未指定の単語",
            count: countsByBook.uncategorized || 0,
            color: "#9ca3af",
            isActive: (currentBookTab === "uncategorized")
        });
    }

    // 各書籍
    bookList.forEach(function(b) {
        var tMatch = b.title.toLowerCase().indexOf(kw) !== -1;
        var aMatch = (b.author || "").toLowerCase().indexOf(kw) !== -1;
        var iMatch = (b.isbn || "").indexOf(kw) !== -1;
        if (!kw || tMatch || aMatch || iMatch) {
            var cInfo = getBookCoverInfo(b);
            var colorVal = (cInfo.type === "color") ? cInfo.value : getDeterministicBookColor(b.title);
            items.push({
                id: b.id,
                title: b.title,
                author: b.author || (b.isbn ? ("ISBN: " + b.isbn) : ""),
                count: countsByBook[b.id] || 0,
                color: colorVal,
                pinned: Boolean(b.pinned),
                isActive: (currentBookTab === b.id)
            });
        }
    });

    if (items.length === 0) {
        var empty = document.createElement("div");
        empty.className = "book-search-empty";
        empty.textContent = "一致する本が見つかりません";
        container.appendChild(empty);
        return;
    }

    var fragment = document.createDocumentFragment();
    items.forEach(function(item) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = item.isActive ? "book-search-item is-active" : "book-search-item";
        btn.setAttribute("role", "option");
        btn.setAttribute("aria-selected", item.isActive ? "true" : "false");

        var left = document.createElement("div");
        left.className = "book-search-item-left";

        var dot = document.createElement("span");
        dot.className = "book-search-item-dot";
        dot.style.backgroundColor = item.color;
        left.appendChild(dot);

        var info = document.createElement("div");
        info.className = "book-search-item-info";

        var titleSpan = document.createElement("div");
        titleSpan.className = "book-search-item-title";
        titleSpan.textContent = item.title;
        info.appendChild(titleSpan);

        if (item.author) {
            var authorSpan = document.createElement("div");
            authorSpan.className = "book-search-item-author";
            authorSpan.textContent = item.author;
            info.appendChild(authorSpan);
        }
        left.appendChild(info);
        btn.appendChild(left);

        var right = document.createElement("div");
        right.className = "book-search-item-right";

        if (item.pinned) {
            var pinBadge = document.createElement("span");
            pinBadge.className = "book-search-pin-badge";
            pinBadge.title = "ピン留め中";
            pinBadge.appendChild(createSvgPinIcon(12));
            right.appendChild(pinBadge);
        }

        if (item.isActive) {
            var activeBadge = document.createElement("span");
            activeBadge.className = "book-search-active-badge";
            activeBadge.textContent = "選択中";
            right.appendChild(activeBadge);
        }

        var countBadge = document.createElement("span");
        countBadge.className = "book-search-item-count";
        countBadge.textContent = item.count + "件";
        right.appendChild(countBadge);

        btn.appendChild(right);

        btn.addEventListener("click", function() {
            closeBookSearchModal();
            selectBookTab(item.id);
            var msg = "『" + item.title + "』を開きました";
            if (typeof showSaveFeedback === "function") {
                showSaveFeedback(msg);
            }
        });

        fragment.appendChild(btn);
    });

    container.appendChild(fragment);
}

// ==================== 書影要素生成・アクティブ書籍メタ表示 ====================

function renderCoverSpineElement(bookTitle, color, size) {
    var ph = document.createElement("div");
    var textColor = getContrastTextColor(color);
    var isLight = (textColor === "#18181b");
    ph.className = "book-cover-placeholder" + (size ? (" is-" + size) : "") + (isLight ? " is-light-bg" : "");
    var raw = (bookTitle || "").trim();
    ph.setAttribute("aria-label", raw || "表紙");
    ph.style.backgroundColor = color;
    ph.style.color = textColor;

    var titleEl = document.createElement("span");
    titleEl.className = "book-cover-title";
    var maxLen = size === "large" ? 14 : 7;
    var displayTitle = raw.length > maxLen ? raw.slice(0, maxLen) : raw;
    titleEl.textContent = displayTitle || "無題";
    ph.appendChild(titleEl);
    return ph;
}

function createCoverElement(book, size) {
    var coverInfo = getBookCoverInfo(book);
    var wrap = document.createElement("div");
    wrap.className = "book-cover-wrap" + (size ? (" is-" + size) : "");
    wrap.setAttribute("role", "button");
    wrap.setAttribute("tabindex", "0");
    wrap.title = "クリックして書影・表紙カラーを設定";

    if (coverInfo.type === "image") {
        var img = document.createElement("img");
        img.className = "book-cover-thumb" + (size ? (" is-" + size) : "");
        img.referrerPolicy = "no-referrer";
        img.alt = book ? book.title : "表紙";
        img.src = coverInfo.value;
        img.addEventListener("error", function() {
            var fallbackColor = getDeterministicBookColor(book ? (book.title || book.id) : "");
            var ph = renderCoverSpineElement(book ? book.title : "", fallbackColor, size);
            if (img.parentNode) {
                img.parentNode.replaceChild(ph, img);
            }
        });
        wrap.appendChild(img);
    } else {
        var spineEl = renderCoverSpineElement(book ? book.title : "", coverInfo.value, size);
        wrap.appendChild(spineEl);
    }

    var onOpen = function() {
        if (book && book.id) {
            openBookCoverModal(book.id);
        }
    };
    wrap.addEventListener("click", onOpen);
    wrap.addEventListener("keydown", function(e) {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen();
        }
    });

    return wrap;
}

function renderActiveBookMeta() {
    var metaBox = document.getElementById("active-book-meta");
    if (!metaBox) return;

    if (currentBookTab === "uncategorized" || currentBookTab === "all_books") {
        metaBox.style.display = "none";
        metaBox.textContent = "";
        return;
    }

    var book = getBookById(currentBookTab);
    if (!book) {
        metaBox.style.display = "none";
        metaBox.textContent = "";
        return;
    }

    metaBox.style.display = "flex";
    metaBox.textContent = "";

    var leftGroup = document.createElement("div");
    leftGroup.className = "book-meta-left";
    leftGroup.appendChild(createCoverElement(book, "thumb"));

    // 表紙URLやカラーが未設定の書籍は1回だけ自動取得を試みる（429防止）
    if (!book.cover && !bookCoverCache["tried_" + book.id]) {
        bookCoverCache["tried_" + book.id] = "1";
        fetchCoverUrlForBook(book).then(function(url) {
            if (url && !book.cover) {
                book.cover = url;
                bookCoverCache[book.id] = url;
                if (book.isbn) bookCoverCache[book.isbn] = url;
                saveAllData(true);
                renderActiveBookMeta();
            }
        });
    }

    var infoWrap = document.createElement("div");
    infoWrap.className = "book-meta-info";

    var titleDiv = document.createElement("div");
    titleDiv.className = "book-meta-title";
    titleDiv.textContent = book.title;
    infoWrap.appendChild(titleDiv);

    var subParts = [];
    if (book.author) subParts.push(book.author);
    if (book.isbn) subParts.push("ISBN: " + book.isbn);
    if (subParts.length > 0) {
        var subDiv = document.createElement("div");
        subDiv.className = "book-meta-sub";
        subDiv.textContent = subParts.join(" / ");
        infoWrap.appendChild(subDiv);
    }
    leftGroup.appendChild(infoWrap);

    metaBox.appendChild(leftGroup);

    var rightGroup = document.createElement("div");
    rightGroup.className = "book-meta-actions";

    var pinBtn = document.createElement("button");
    pinBtn.type = "button";
    pinBtn.className = book.pinned ? "btn-book-pin is-pinned" : "btn-book-pin";
    pinBtn.title = book.pinned ? "ピン留めを解除（元の位置に戻る）" : "この本をピン留め（タブ先頭に固定）";
    pinBtn.appendChild(createSvgPinIcon(12));
    var pinText = document.createTextNode(book.pinned ? " ピン留め中" : " ピン留め");
    pinBtn.appendChild(pinText);
    pinBtn.addEventListener("click", function() {
        toggleBookPin(book.id);
    });
    rightGroup.appendChild(pinBtn);

    var coverBtn = document.createElement("button");
    coverBtn.type = "button";
    coverBtn.className = "btn-book-cover";
    coverBtn.title = "この本の書影・表紙カラーの設定";
    coverBtn.textContent = "書影・設定";
    coverBtn.addEventListener("click", function() {
        openBookCoverModal(book.id);
    });
    rightGroup.appendChild(coverBtn);

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
        moveLeftBtn.title = "この本の並び順を1つ左へ移動";
        moveLeftBtn.disabled = (bookIdx <= 0);
        moveLeftBtn.addEventListener("click", function() {
            moveBookOrder(book.id, -1);
        });
        rightGroup.appendChild(moveLeftBtn);

        var moveRightBtn = document.createElement("button");
        moveRightBtn.type = "button";
        moveRightBtn.className = "btn-book-move";
        moveRightBtn.textContent = "右へ移動 →";
        moveRightBtn.title = "この本の並び順を1つ右へ移動";
        moveRightBtn.disabled = (bookIdx >= bookList.length - 1);
        moveRightBtn.addEventListener("click", function() {
            moveBookOrder(book.id, 1);
        });
        rightGroup.appendChild(moveRightBtn);

        var delBookBtn = document.createElement("button");
        delBookBtn.type = "button";
        delBookBtn.className = "btn-book-remove";
        delBookBtn.textContent = "この本を削除";
        delBookBtn.addEventListener("click", function() {
            deleteCurrentBook();
        });
        rightGroup.appendChild(delBookBtn);
    }

    metaBox.appendChild(rightGroup);
}

// ==================== 書影・表紙設定モーダル操作 ====================

function openBookCoverModal(bookId) {
    var book = getBookById(bookId);
    if (!book) return;
    currentCoverModalBookId = bookId;

    var modal = document.getElementById("book-cover-modal");
    if (!modal) return;

    var nameEl = document.getElementById("cover-modal-book-name");
    if (nameEl) {
        nameEl.textContent = "『" + (book.title || "無題") + "』";
    }

    var coverInfo = getBookCoverInfo(book);
    coverModalDraft = {
        type: coverInfo.type,
        value: coverInfo.value,
        isDefault: coverInfo.isDefault
    };

    var urlInput = document.getElementById("cover-url-input");
    if (urlInput) {
        urlInput.value = (coverInfo.type === "image") ? coverInfo.value : "";
    }

    var picker = document.getElementById("cover-color-picker");
    var hexSpan = document.getElementById("cover-color-hex");
    var initialColor = (coverInfo.type === "color") ? coverInfo.value : getDeterministicBookColor(book.title || book.id);
    if (picker) picker.value = initialColor;
    if (hexSpan) hexSpan.textContent = initialColor;

    hideCoverStatusMsg();
    renderCoverColorPalette(coverModalDraft.type === "color" ? coverModalDraft.value : null);
    updateCoverModalPreview();

    modal.style.display = "flex";
}

function closeBookCoverModal() {
    var modal = document.getElementById("book-cover-modal");
    if (modal) modal.style.display = "none";
    currentCoverModalBookId = null;
    hideCoverStatusMsg();
}

function deleteCurrentBookFromModal() {
    var targetId = currentCoverModalBookId || currentBookTab;
    closeBookCoverModal();
    if (targetId && targetId !== "all_books" && targetId !== "uncategorized") {
        currentBookTab = targetId;
        deleteCurrentBook();
    }
}

function updateCoverModalPreview() {
    var box = document.getElementById("cover-modal-preview");
    var badge = document.getElementById("cover-modal-type-badge");
    if (!box) return;
    box.textContent = "";

    var book = getBookById(currentCoverModalBookId);
    var title = book ? book.title : "";

    if (coverModalDraft.type === "image") {
        if (badge) {
            badge.textContent = "画像書影";
            badge.className = "cover-type-badge is-image";
        }
        var img = document.createElement("img");
        img.className = "book-cover-thumb is-large";
        img.referrerPolicy = "no-referrer";
        img.alt = title || "表紙";
        img.src = coverModalDraft.value;
        img.addEventListener("error", function() {
            showCoverStatusMsg("画像URLの読み込みに失敗しました。URLをご確認ください。", "info");
            var ph = renderCoverSpineElement(title, getDeterministicBookColor(title), "large");
            if (img.parentNode) {
                img.parentNode.replaceChild(ph, img);
            }
        });
        box.appendChild(img);
    } else {
        if (badge) {
            badge.textContent = coverModalDraft.isDefault ? "単色カラー（自動）" : "単色カラー（指定）";
            badge.className = "cover-type-badge is-color";
        }
        var spine = renderCoverSpineElement(title, coverModalDraft.value, "large");
        box.appendChild(spine);
    }
}

function renderCoverColorPalette(selectedHex) {
    var container = document.getElementById("cover-color-palette");
    if (!container) return;
    container.textContent = "";

    BOOK_COVER_PALETTE.forEach(function(item) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "cover-palette-btn";
        if (selectedHex && selectedHex.toLowerCase() === item.hex.toLowerCase()) {
            btn.classList.add("is-selected");
        }
        btn.style.backgroundColor = item.hex;
        btn.title = item.name + " (" + item.hex + ")";
        btn.setAttribute("aria-label", item.name);
        btn.addEventListener("click", function() {
            selectCoverColor(item.hex);
        });
        container.appendChild(btn);
    });
}

function selectCoverColor(hex) {
    coverModalDraft = { type: "color", value: hex, isDefault: false };
    var picker = document.getElementById("cover-color-picker");
    var hexSpan = document.getElementById("cover-color-hex");
    var urlInput = document.getElementById("cover-url-input");
    if (picker) picker.value = hex;
    if (hexSpan) hexSpan.textContent = hex;
    if (urlInput) urlInput.value = "";
    hideCoverStatusMsg();
    renderCoverColorPalette(hex);
    updateCoverModalPreview();
}

function handleCoverColorPicker(val) {
    if (!val) return;
    coverModalDraft = { type: "color", value: val, isDefault: false };
    var hexSpan = document.getElementById("cover-color-hex");
    var urlInput = document.getElementById("cover-url-input");
    if (hexSpan) hexSpan.textContent = val;
    if (urlInput) urlInput.value = "";
    hideCoverStatusMsg();
    renderCoverColorPalette(val);
    updateCoverModalPreview();
}

function handleCoverUrlInput(val) {
    var trimmed = (val || "").trim();
    if (!trimmed) {
        var book = getBookById(currentCoverModalBookId);
        var defColor = getDeterministicBookColor(book ? (book.title || book.id) : "");
        coverModalDraft = { type: "color", value: defColor, isDefault: true };
        updateCoverModalPreview();
        renderCoverColorPalette(defColor);
        return;
    }
    if (/^https?:\/\//i.test(trimmed)) {
        var safe = sanitizeCoverUrl(trimmed);
        if (safe) {
            coverModalDraft = { type: "image", value: safe, isDefault: false };
            updateCoverModalPreview();
            renderCoverColorPalette(null);
        }
    }
}

function applyCoverUrlFromInput() {
    var urlInput = document.getElementById("cover-url-input");
    var val = urlInput ? urlInput.value.trim() : "";
    if (!val) {
        showCoverStatusMsg("画像URLを入力してください", "info");
        return;
    }
    var safe = sanitizeCoverUrl(val);
    if (!safe) {
        showCoverStatusMsg("有効な https:// 画像URLを入力してください（一部規約外サイトは使用できません）", "info");
        return;
    }
    coverModalDraft = { type: "image", value: safe, isDefault: false };
    hideCoverStatusMsg();
    renderCoverColorPalette(null);
    updateCoverModalPreview();
}

function setFetchButtonState(btn, loading) {
    if (!btn) return;
    btn.textContent = "";
    if (loading) {
        btn.disabled = true;
        btn.textContent = "検索中...";
    } else {
        btn.disabled = false;
        var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("class", "icon-line");
        svg.setAttribute("viewBox", "0 0 16 16");
        svg.setAttribute("aria-hidden", "true");
        svg.style.width = "13px";
        svg.style.height = "13px";
        svg.style.marginRight = "4px";
        svg.style.verticalAlign = "-1px";
        var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", "M11.5 6.5a5 5 0 1 1-10 0 5 5 0 0 1 10 0zm-1.5 4.5 4 4");
        svg.appendChild(path);
        btn.appendChild(svg);
        btn.appendChild(document.createTextNode("openBD / Google Books から自動取得"));
    }
}

function handleFetchCoverFromApi() {
    var book = getBookById(currentCoverModalBookId);
    if (!book) return;
    var btn = document.getElementById("cover-fetch-api-btn");
    setFetchButtonState(btn, true);

    fetchCoverUrlForBook(book).then(function(url) {
        setFetchButtonState(btn, false);
        if (url) {
            coverModalDraft = { type: "image", value: url, isDefault: false };
            var urlInput = document.getElementById("cover-url-input");
            if (urlInput) urlInput.value = url;
            renderCoverColorPalette(null);
            updateCoverModalPreview();
            showCoverStatusMsg("書影が見つかりました！", "success");
        } else {
            showCoverStatusMsg("openBD / Google Books から書影が見つかりませんでした。単色カラーをご活用ください。", "info");
        }
    }).catch(function() {
        setFetchButtonState(btn, false);
        showCoverStatusMsg("取得中にエラーが発生しました", "info");
    });
}

function resetCoverToDefault() {
    var book = getBookById(currentCoverModalBookId);
    var defColor = getDeterministicBookColor(book ? (book.title || book.id) : "");
    coverModalDraft = { type: "color", value: defColor, isDefault: true };
    var urlInput = document.getElementById("cover-url-input");
    var picker = document.getElementById("cover-color-picker");
    var hexSpan = document.getElementById("cover-color-hex");
    if (urlInput) urlInput.value = "";
    if (picker) picker.value = defColor;
    if (hexSpan) hexSpan.textContent = defColor + " (自動)";
    renderCoverColorPalette(defColor);
    updateCoverModalPreview();
    showCoverStatusMsg("デフォルトの自動設定に戻しました（「この設定で保存」を押すと確定します）", "info");
}

function saveBookCoverModal() {
    var book = getBookById(currentCoverModalBookId);
    if (!book) {
        closeBookCoverModal();
        return;
    }

    if (coverModalDraft.isDefault) {
        book.cover = "";
    } else if (coverModalDraft.type === "color") {
        book.cover = coverModalDraft.value;
    } else if (coverModalDraft.type === "image") {
        book.cover = sanitizeCoverUrl(coverModalDraft.value);
    }

    bookCoverCache[book.id] = book.cover;
    if (book.isbn) {
        bookCoverCache[book.isbn] = book.cover;
    }

    saveAllData(false);
    renderBookTabs();
    renderActiveBookMeta();
    var si = document.getElementById("search-input");
    renderWordCards(si ? si.value : "");
    closeBookCoverModal();
    showSaveFeedback("『" + book.title + "』の書影を設定しました");
}

function showCoverStatusMsg(text, type) {
    var msg = document.getElementById("cover-status-msg");
    if (!msg) return;
    msg.textContent = text;
    msg.className = "cover-status-msg is-" + (type || "info");
    msg.style.display = "block";
}

function hideCoverStatusMsg() {
    var msg = document.getElementById("cover-status-msg");
    if (msg) msg.style.display = "none";
}
