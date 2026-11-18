// ==================== 単語一覧・追加モーダル・意味確認モーダル・インライン編集 (ui-words.js) ====================

let saveFeedbackTimer = null;
let quickAddStatusTimer = null;

// 意味確認モーダル用キュー
let meaningConfirmQueue = [];
let meaningConfirmIndex = 0;
let meaningConfirmOnFinish = null;

// ==================== フィードバック表示・ページャー ====================

function showSaveFeedback(msg, keepVisible) {
    var feedback = document.getElementById("save-feedback");
    if (!feedback) return;
    if (saveFeedbackTimer) {
        clearTimeout(saveFeedbackTimer);
        saveFeedbackTimer = null;
    }
    feedback.classList.remove("unsaved");
    feedback.textContent = msg;
    feedback.classList.add("visible");
    if (!keepVisible) {
        saveFeedbackTimer = setTimeout(function() {
            saveFeedbackTimer = null;
            feedback.classList.remove("visible");
        }, 3200);
    }
}

function showQuickAddStatus(msg, state, autoHide) {
    var statusElem = document.getElementById("quick-add-status");
    if (!statusElem) return;
    if (quickAddStatusTimer) {
        clearTimeout(quickAddStatusTimer);
        quickAddStatusTimer = null;
    }
    if (!msg) {
        statusElem.style.display = "none";
        statusElem.textContent = "";
        statusElem.className = "quick-add-status";
        return;
    }
    statusElem.style.display = "block";
    statusElem.textContent = msg;
    statusElem.className = "quick-add-status" + (state ? (" is-" + state) : "");

    if (autoHide) {
        quickAddStatusTimer = setTimeout(function() {
            quickAddStatusTimer = null;
            if (statusElem) {
                statusElem.style.display = "none";
                statusElem.textContent = "";
                statusElem.className = "quick-add-status";
            }
        }, typeof autoHide === "number" ? autoHide : 3500);
    }
}

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

function getWordItemById(wordId) {
    for (var i = 0; i < wordList.length; i++) {
        if (wordList[i].id === wordId) return wordList[i];
    }
    return null;
}

// 入力1行を単語・意味・状態フラグへ分解
function parseWordInputLine(line) {
    var trimmed = String(line || "").trim();
    if (!trimmed) return null;

    var match = trimmed.match(/^([^:：\t]+)[:：\t](.*)$/);
    if (!match) {
        return {
            word: trimmed,
            meaning: "",
            noMeaningNeeded: false,
            isAutoMeaning: false,
            needsAutoMeaning: true
        };
    }

    var word = match[1].trim();
    if (!word) return null;

    var rawRight = match[2].trim();
    if (rawRight === "✓" || rawRight === "✔" || rawRight === "済" || rawRight === "（意味不要）") {
        return {
            word: word,
            meaning: "",
            noMeaningNeeded: true,
            isAutoMeaning: false,
            needsAutoMeaning: false
        };
    }

    var isAuto = false;
    if (rawRight.indexOf("[自動]") === 0) {
        isAuto = true;
        rawRight = rawRight.replace(/^\[自動\]\s*/, "");
    }
    var cleaned = cleanMeaning(rawRight);
    return {
        word: word,
        meaning: cleaned,
        noMeaningNeeded: false,
        isAutoMeaning: Boolean(isAuto && cleaned),
        needsAutoMeaning: !cleaned
    };
}

// ==================== 単語追加モーダル ====================

function openWordAddModal(defaultBookId) {
    var modal = document.getElementById("word-add-modal");
    if (!modal) return;

    var select = document.getElementById("word-add-book-select");
    if (select) {
        select.textContent = "";
        var uncatOpt = document.createElement("option");
        uncatOpt.value = "uncategorized";
        uncatOpt.textContent = "未分類";
        select.appendChild(uncatOpt);

        bookList.forEach(function(b) {
            var opt = document.createElement("option");
            opt.value = b.id;
            opt.textContent = "『" + b.title + "』";
            select.appendChild(opt);
        });

        var chosenId = defaultBookId;
        if (!chosenId) {
            if (currentBookTab && currentBookTab !== "all_books") {
                chosenId = currentBookTab;
            } else if (bookList.length > 0) {
                chosenId = bookList[0].id;
            } else {
                chosenId = "uncategorized";
            }
        }
        select.value = chosenId;
    }

    var input = document.getElementById("quick-add-input");
    if (input) {
        input.value = "";
    }
    showQuickAddStatus("", "");
    syncConfirmToggleUI();

    modal.style.display = "flex";
    if (input) {
        setTimeout(function() { input.focus(); }, 80);
    }
}

function closeWordAddModal() {
    var modal = document.getElementById("word-add-modal");
    if (modal) modal.style.display = "none";
}

function addQuickWordFromModal() {
    var select = document.getElementById("word-add-book-select");
    var targetBookId = select ? select.value : "uncategorized";
    addQuickWord(targetBookId);
}

function addQuickWord(explicitBookId) {
    var input = document.getElementById("quick-add-input");
    if (!input) return;
    var raw = input.value.trim();
    if (!raw) return;

    var rawLines = raw.split("\n").map(function(l) { return l.trim(); }).filter(Boolean);
    if (rawLines.length === 0) return;

    var targetBookId = explicitBookId || (currentBookTab !== "all_books" ? currentBookTab : "uncategorized");
    if (targetBookId !== "uncategorized" && !getBookById(targetBookId)) {
        targetBookId = "uncategorized";
    }

    var addedItems = [];
    var itemsNeedingAutoMeaning = [];
    var skippedWords = [];
    var seenInCurrentInput = {};
    var nextOrd = getNextWordOrder();
    var now = Date.now();

    rawLines.forEach(function(line) {
        var parsed = parseWordInputLine(line);
        if (!parsed || !parsed.word) return;
        var wNorm = normalizeWordKey(parsed.word);
        if (!wNorm) return;

        if (seenInCurrentInput[wNorm]) return;
        seenInCurrentInput[wNorm] = true;

        var existing = findExistingWordLocation(parsed.word);
        if (existing) {
            skippedWords.push("「" + parsed.word + "」(" + existing.bookTitle + "に登録済)");
            return;
        }

        var newItem = {
            id: generateNewWordId(),
            word: parsed.word,
            meaning: parsed.meaning,
            bookId: targetBookId,
            isAutoMeaning: parsed.isAutoMeaning,
            noMeaningNeeded: parsed.noMeaningNeeded,
            order: nextOrd,
            createdAt: now
        };
        nextOrd += 10;

        wordList.push(newItem);
        addedItems.push(newItem);
        if (parsed.needsAutoMeaning) {
            itemsNeedingAutoMeaning.push(newItem);
        }
    });

    input.value = "";

    if (addedItems.length === 0) {
        refreshUI();
        var skipMsg = skippedWords.length === 1
            ? (skippedWords[0] + "は登録済みのためスキップしました")
            : (skippedWords.length + "件の単語はすべて登録済みのためスキップしました");
        showSaveFeedback(skipMsg);
        showQuickAddStatus(skipMsg, "error", 4000);
        return;
    }

    saveAllData(false);
    refreshUI();

    var feedbackMsg = skippedWords.length > 0
        ? (addedItems.length + "件を追加（" + skippedWords.length + "件は登録済みのためスキップ）")
        : (addedItems.length + "件を追加・保存しました");

    if (itemsNeedingAutoMeaning.length > 0) {
        showSaveFeedback(feedbackMsg + "・辞書から意味を検索中...", true);
        showQuickAddStatus("辞書から意味を自動取得しています...", "loading");
        autoFillMeaningsForWords(itemsNeedingAutoMeaning);
    } else {
        showSaveFeedback(feedbackMsg);
        showQuickAddStatus(feedbackMsg, "success", 2500);
    }

    setTimeout(function() {
        closeWordAddModal();
    }, 500);
}

// ==================== 辞書意味の自動補完・確認モーダル ====================

function autoFillMeaningsForWords(targetItems) {
    if (!targetItems || targetItems.length === 0) return;

    var foundQueue = [];
    var chain = Promise.resolve();

    targetItems.forEach(function(item) {
        chain = chain.then(function() {
            return fetchWordMeaningCandidates(item.word).then(function(candidates) {
                if (candidates && candidates.length > 0) {
                    foundQueue.push({
                        wordId: item.id,
                        bookId: item.bookId,
                        word: item.word,
                        candidates: candidates
                    });
                }
            });
        });
    });

    chain.then(function() {
        if (foundQueue.length === 0) {
            showSaveFeedback("辞書に一致する意味が見つかりませんでした");
            showQuickAddStatus("辞書に一致する意味が見つかりませんでした", "error", 3500);
            return;
        }

        if (shouldConfirmAutoMeaning()) {
            openMeaningConfirmQueue(foundQueue, function(confirmedCount) {
                saveAllData(false);
                refreshUI();
                var msg = confirmedCount + " 件の意味を確認・保存しました";
                showSaveFeedback(msg);
                showQuickAddStatus(msg, "success", 3500);
            });
        } else {
            var filledCount = 0;
            foundQueue.forEach(function(entry) {
                var target = getWordItemById(entry.wordId);
                if (target) {
                    target.meaning = cleanMeaning(entry.candidates[0]);
                    target.isAutoMeaning = Boolean(target.meaning);
                    target.noMeaningNeeded = false;
                    if (target.meaning) filledCount++;
                }
            });
            saveAllData(false);
            refreshUI();
            var autoMsg = "辞書から " + filledCount + " 件の意味を自動登録しました";
            showSaveFeedback(autoMsg);
            showQuickAddStatus(autoMsg, "success", 3500);
        }
    });
}

function openMeaningConfirmQueue(items, onFinish) {
    meaningConfirmQueue = items || [];
    meaningConfirmIndex = 0;
    meaningConfirmOnFinish = onFinish || null;
    meaningConfirmQueue._confirmedCount = 0;
    renderCurrentMeaningConfirmModal();
}

function handleModalMeaningInput() {
    var saveBtn = document.getElementById("modal-save-btn");
    var input = document.getElementById("modal-meaning-input");
    if (!saveBtn || !input) return;
    var hasVal = input.value.trim() !== "";
    saveBtn.textContent = hasVal ? "この意味で登録する" : "意味なしで登録する";
}

function handleModalMeaningKeydown(event) {
    if (event.key === "Enter") {
        event.preventDefault();
        resolveMeaningModal("save");
    } else if (event.key === "Escape") {
        event.preventDefault();
        resolveMeaningModal("skip");
    }
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
    var saveBtn = document.getElementById("modal-save-btn");
    var knownBtn = document.getElementById("modal-known-btn");
    var guideText = document.getElementById("modal-guide-text");

    if (badge) {
        badge.textContent = "意味の確認 (" + (meaningConfirmIndex + 1) + " / " + meaningConfirmQueue.length + ")";
    }
    if (skipBtn) {
        skipBtn.textContent = (meaningConfirmQueue.length > 1) ? "あとで（スキップ）" : "あとで";
    }
    if (title) {
        title.textContent = current.word;
    }
    if (input) {
        input.value = current.candidates[0] || "";
    }
    if (saveBtn) {
        saveBtn.textContent = (input && input.value.trim()) ? "この意味で登録する" : "意味なしで登録する";
    }
    if (knownBtn) {
        knownBtn.title = "この単語の意味は知っているので、辞書意味を付けずに既知単語として登録します";
    }
    if (list) {
        list.textContent = "";
        current.candidates.forEach(function(cand, idx) {
            var btn = document.createElement("button");
            btn.type = "button";
            btn.className = (idx === 0) ? "candidate-chip active" : "candidate-chip";
            btn.textContent = "候補" + (idx + 1) + ": " + cand;
            btn.addEventListener("click", function() {
                if (input) {
                    input.value = cand;
                    handleModalMeaningInput();
                }
                var allChips = list.querySelectorAll(".candidate-chip");
                for (var k = 0; k < allChips.length; k++) {
                    allChips[k].classList.remove("active");
                }
                btn.classList.add("active");
            });
            list.appendChild(btn);
        });
    }
    if (guideText) {
        guideText.textContent = (current.candidates.length > 0)
            ? "辞書から以下の意味が見つかりました。この意味で登録しますか？（直接書き換えも可能です）"
            : "辞書候補が見つかりませんでした。意味を直接入力するか、そのまま登録できます：";
    }

    modal.style.display = "flex";
    if (input) {
        input.focus();
        input.select();
    }
}

function resolveMeaningModal(action) {
    if (meaningConfirmIndex >= meaningConfirmQueue.length) return;
    var current = meaningConfirmQueue[meaningConfirmIndex];
    var input = document.getElementById("modal-meaning-input");
    var val = input ? cleanMeaning(input.value) : cleanMeaning(current.candidates[0] || "");
    var target = getWordItemById(current.wordId);

    if (target) {
        if (action === "save") {
            target.meaning = val;
            target.isAutoMeaning = false;
            target.noMeaningNeeded = false;
            meaningConfirmQueue._confirmedCount = (meaningConfirmQueue._confirmedCount || 0) + 1;
        } else if (action === "known") {
            target.meaning = "";
            target.isAutoMeaning = false;
            target.noMeaningNeeded = true;
            meaningConfirmQueue._confirmedCount = (meaningConfirmQueue._confirmedCount || 0) + 1;
        }
    }

    meaningConfirmIndex++;
    renderCurrentMeaningConfirmModal();
}

// 一覧ヘッダーの「辞書補完」ボタン（選択中タブまたは全シートの未設定単語を一括検索）
function batchFetchMissingMeanings() {
    var missingItems = wordList.filter(function(item) {
        if (currentBookTab !== "all_books" && item.bookId !== currentBookTab) {
            return false;
        }
        var hasMeaning = Boolean(item.meaning && item.meaning.trim() !== "");
        return !hasMeaning && !item.noMeaningNeeded;
    });

    if (missingItems.length === 0) {
        var emptyMsg = (currentBookTab === "all_books")
            ? "意味が未登録の単語はありません"
            : "このシートに意味が未登録の単語はありません";
        showSaveFeedback(emptyMsg);
        return;
    }

    var btn = document.getElementById("batch-dict-btn");
    if (btn) btn.disabled = true;
    showSaveFeedback(missingItems.length + " 件の意味を辞書から検索中...", true);

    autoFillMeaningsForWords(missingItems);
    setTimeout(function() {
        if (btn) btn.disabled = false;
    }, 1500);
}

// カード上の自動取得意味操作
function confirmAutoMeaning(item) {
    var target = getWordItemById(item.id);
    if (!target) return;
    target.isAutoMeaning = false;
    saveAllData(false);
    refreshUI();
}

function cycleAutoMeaningCandidate(item) {
    fetchWordMeaningCandidates(item.word).then(function(candidates) {
        if (!candidates || candidates.length === 0) {
            alert("「" + item.word + "」の辞書候補が見つかりませんでした。手動で編集してください。");
            return;
        }
        if (candidates.length === 1) {
            alert("辞書に登録されている候補はこの1件のみです。\n違う場合は「編集」または「意味だけ消す」を押してください。");
            return;
        }
        var currentIdx = candidateCycleIndex[item.word] || 0;
        var nextIdx = (currentIdx + 1) % candidates.length;
        candidateCycleIndex[item.word] = nextIdx;

        var target = getWordItemById(item.id);
        if (target) {
            target.meaning = cleanMeaning(candidates[nextIdx]);
            target.isAutoMeaning = true;
            target.noMeaningNeeded = false;
            saveAllData(false);
            refreshUI();
        }
    });
}

function clearWordMeaning(item) {
    var target = getWordItemById(item.id);
    if (!target) return;
    target.meaning = "";
    target.isAutoMeaning = false;
    target.noMeaningNeeded = false;
    saveAllData(false);
    refreshUI();
}

function markWordAsKnown(item) {
    var target = getWordItemById(item.id);
    if (!target) return;
    target.meaning = "";
    target.isAutoMeaning = false;
    target.noMeaningNeeded = true;
    saveAllData(false);
    refreshUI();
}

// ==================== 単語カード一覧描画・インライン編集 ====================

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
                                wordId: item.id,
                                bookId: item.bookId,
                                word: item.word,
                                candidates: candidates
                            }], function() {
                                saveAllData(false);
                                refreshUI();
                            });
                        } else {
                            var target = getWordItemById(item.id);
                            if (target) {
                                target.meaning = cleanMeaning(candidates[0]);
                                target.isAutoMeaning = true;
                                target.noMeaningNeeded = false;
                                saveAllData(false);
                                refreshUI();
                            }
                        }
                    } else {
                        autoBtn.textContent = "該当なし";
                        setTimeout(function() {
                            startInlineEdit(item.id, false);
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
            knownBtn.title = "意味不要（分かる単語）として完了にする";
            knownBtn.textContent = "✓";
            knownBtn.addEventListener("click", function() {
                markWordAsKnown(item);
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
        var b = getBookById(item.bookId);
        if (b) {
            var sDot = document.createElement("span");
            sDot.className = "word-source-dot";
            var cInfo = getBookCoverInfo(b);
            sDot.style.backgroundColor = (cInfo.type === "color") ? cInfo.value : getDeterministicBookColor(b.title);
            sourceTag.appendChild(sDot);
        }
        var sTextNode = document.createElement("span");
        sTextNode.textContent = sourceText;
        sourceTag.appendChild(sTextNode);
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
            handleInlineKey(event, item.id);
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
            handleInlineKey(event, item.id);
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

            bookList.forEach(function(bObj) {
                var opt = document.createElement("option");
                opt.value = bObj.id;
                opt.textContent = bObj.title;
                if (item.bookId === bObj.id) opt.selected = true;
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
            deleteWordItem(item);
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
            saveInlineMeaning(item.id);
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

function renderWordCards(filterKeyword) {
    var container = document.getElementById("word-list");
    var filteredCountElem = document.getElementById("filtered-count");
    if (!container) return;

    var bookScopedList = wordList;
    if (currentBookTab !== "all_books") {
        bookScopedList = wordList.filter(function(item) {
            return item.bookId === currentBookTab;
        });
    }

    var displayList = bookScopedList;
    if (filterKeyword && filterKeyword.trim() !== "") {
        var keyword = filterKeyword.trim().toLowerCase();
        displayList = bookScopedList.filter(function(item) {
            return item.word.toLowerCase().indexOf(keyword) !== -1 ||
                   item.meaning.toLowerCase().indexOf(keyword) !== -1;
        });
    }

    if (filteredCountElem) {
        filteredCountElem.textContent = displayList.length + " 件";
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
            var addBtn = document.createElement("button");
            addBtn.type = "button";
            addBtn.className = "btn btn-primary link-add-empty";
            addBtn.textContent = "＋ 単語を追加する";
            addBtn.style.marginTop = "10px";
            addBtn.addEventListener("click", function() {
                openWordAddModal();
            });
            emptyDiv.appendChild(addBtn);
        }
        container.appendChild(emptyDiv);
        return;
    }

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

function startInlineEdit(id, focusWord) {
    editingWordId = id;
    editingFocusWord = Boolean(focusWord);
    var searchInput = document.getElementById("search-input");
    renderWordCards(searchInput ? searchInput.value : "");
}

function cancelInlineEdit() {
    editingWordId = null;
    editingFocusWord = false;
    var searchInput = document.getElementById("search-input");
    renderWordCards(searchInput ? searchInput.value : "");
}

function handleInlineKey(event, id) {
    if (event.key === "Enter") {
        saveInlineMeaning(id);
    } else if (event.key === "Escape") {
        cancelInlineEdit();
    }
}

function saveInlineMeaning(id) {
    var target = getWordItemById(id);
    if (!target) {
        cancelInlineEdit();
        return;
    }

    var wordInput = document.getElementById("inline-word-input-" + id);
    var editInput = document.getElementById("inline-input-" + id);
    var bookSelect = document.getElementById("inline-book-select-" + id);
    if (!editInput) return;

    var newWord = wordInput ? wordInput.value.trim() : target.word;
    if (!newWord) {
        alert("単語を入力してください");
        if (wordInput) wordInput.focus();
        return;
    }

    // 別のカードと単語名が重複していないか検証
    var conflict = findExistingWordLocation(newWord, id);
    if (conflict) {
        alert("「" + newWord + "」はすでに『" + conflict.bookTitle + "』に登録されています。");
        if (wordInput) wordInput.focus();
        return;
    }

    var newMeaning = cleanMeaning(editInput.value);
    var destBookId = bookSelect ? bookSelect.value : (target.bookId || "uncategorized");

    target.word = newWord;
    target.meaning = newMeaning;
    target.isAutoMeaning = false;
    if (newMeaning) {
        target.noMeaningNeeded = false;
    }

    if (destBookId !== target.bookId) {
        target.bookId = destBookId;
        target.order = getNextWordOrder();
    }

    editingWordId = null;
    editingFocusWord = false;

    saveAllData(false);
    refreshUI();
}

function deleteWordItem(item) {
    if (!item) return;
    if (!confirm("「" + item.word + "」を削除しますか？")) return;

    var targetNorm = normalizeWordKey(item.word);
    wordList = wordList.filter(function(w) {
        return w.id !== item.id && normalizeWordKey(w.word) !== targetNorm;
    });

    if (editingWordId === item.id) {
        editingWordId = null;
        editingFocusWord = false;
    }

    saveAllData(false);
    refreshUI();
}

function handleSearch() {
    listPageIndex = 0;
    var searchInput = document.getElementById("search-input");
    renderWordCards(searchInput ? searchInput.value : "");
}
