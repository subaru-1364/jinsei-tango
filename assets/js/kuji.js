// ==================== 重複なしランダムピックアップ・山札シャッフル (kuji.js) ====================

let isDrawing = false;
let drawDeck = [];
let lastDrawnKey = null;
let lastPoolSignature = "";

function resetDrawDeck() {
    drawDeck = [];
    lastDrawnKey = null;
    lastPoolSignature = "";
    var resultBox = document.getElementById("draw-result");
    if (resultBox) resultBox.style.display = "none";
    var resultWord = document.getElementById("result-word");
    if (resultWord) resultWord.textContent = "";
    var resultMeaning = document.getElementById("result-meaning");
    if (resultMeaning) {
        resultMeaning.textContent = "";
        resultMeaning.style.display = "none";
    }
    var resultSource = document.getElementById("result-source");
    if (resultSource) {
        resultSource.textContent = "";
        resultSource.style.display = "none";
    }
}

function getActiveDrawPool() {
    // 選択中の本に関わらず、常に全登録単語から抽選
    return wordList;
}

function buildShuffledDeck(pool) {
    var keys = pool.map(function(item) {
        return item.id;
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
    var sig = pool.map(function(w) { return w.id; }).join(",");
    var validSet = {};
    pool.forEach(function(w) {
        validSet[w.id] = w;
    });

    if (sig !== lastPoolSignature) {
        lastPoolSignature = sig;
        drawDeck = buildShuffledDeck(pool);
        return;
    }

    drawDeck = drawDeck.filter(function(k) { return Boolean(validSet[k]); });

    if (drawDeck.length === 0 && pool.length > 0) {
        drawDeck = buildShuffledDeck(pool);
    }
}

function updateDrawDeckInfo() {
    var pool = getActiveDrawPool();
    if (pool.length === 0) {
        resetDrawDeck();
        return;
    }
    syncDrawDeckWithPool(pool);
}

function drawWord() {
    if (isDrawing) return;

    var pool = getActiveDrawPool();
    if (pool.length === 0) {
        alert("単語が登録されていません。右上の「単語を追加」ボタンから単語を入力してください！");
        return;
    }

    var resultBox = document.getElementById("draw-result");
    var resultWord = document.getElementById("result-word");
    var resultMeaning = document.getElementById("result-meaning");
    var drawBtn = document.getElementById("draw-btn");
    if (!resultBox || !resultWord || !resultMeaning || !drawBtn) return;

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
        if (pool[i].id === chosenKey) {
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
        resultWord.textContent = pool[tempIndex].word;
        resultMeaning.textContent = "";
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
    if (!resultWord || !resultMeaning) return;

    resultWord.textContent = selected.word;
    if (selected.meaning && selected.meaning.trim() !== "") {
        resultMeaning.textContent = selected.meaning;
        resultMeaning.style.display = "block";
    } else {
        resultMeaning.textContent = "";
        resultMeaning.style.display = "none";
    }

    var resultSource = document.getElementById("result-source");
    if (resultSource) {
        resultSource.textContent = "";
        var srcText = getSourceTagText(selected.bookId);
        if (srcText) {
            var b = getBookById(selected.bookId);
            if (b) {
                var sDot = document.createElement("span");
                sDot.className = "word-source-dot";
                var cInfo = getBookCoverInfo(b);
                sDot.style.backgroundColor = (cInfo.type === "color") ? cInfo.value : getDeterministicBookColor(b.title);
                resultSource.appendChild(sDot);
            }
            var sTextNode = document.createElement("span");
            sTextNode.textContent = srcText;
            resultSource.appendChild(sTextNode);
            resultSource.style.display = "inline-flex";
        } else {
            resultSource.style.display = "none";
        }
    }
}
