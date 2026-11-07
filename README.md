# 📚 人生新出単語

日常や読書の中で新しく出会った単語を記録し、書籍（ISBN）ごとの整理・辞書からの意味自動補完・重複なしランダムピックアップができるマイ単語帳＆用語集Webアプリケーションです。  
Googleアカウントでのクラウドリアルタイム同期に対応しており、PC・スマートフォンの双方からシームレスに利用できます。

---

## 🚀 アプリを開く（Web版）

### 👉 **[「人生新出単語」を開く](https://subaru-1364.github.io/jinsei-tango/)**

- 📝 **[単語の登録・シート編集ページを直接開く](https://subaru-1364.github.io/jinsei-tango/edit.html)**
- URL: `https://subaru-1364.github.io/jinsei-tango/`

---

## ✨ 主な機能

### 1. 📖 本棚・書籍別シート管理
- **ISBN・タイトルから書籍情報を自動取得**: ISBNコード（13桁/10桁）または書籍名・著者名で検索するだけで、書名・著者・表紙（書影）を自動取得してシートを作成。外部データベースに書影がない書籍や任意作成シートでも、タイトル先頭6文字を配したミニ本風アイコンを自動表示。
- **自由なシート作成**: 本に限らず、プロジェクト名やジャンル名など任意のシート名を作成して単語を分類。
- **シートの並び替え機能**: 「並び替え」モードをONにすることで、手動でシートの順番を入れ替え可能（「← 左へ移動」「右へ移動 →」ボタンおよびドラッグ＆ドロップ対応。「すべて」「未分類」は常に先頭に固定）。

### 2. 🔍 辞書からの意味自動補完（Wiktionary / Wikipedia 連携）
- **意味の自動取得**: 単語のみを入力した場合でも、国語辞典（日本語版Wiktionary）や百科事典（Wikipedia）から意味を自動検索・付与。
- **意味の確認モーダル**: 自動取得時に複数の意味候補から選んだり、その場で編集・調整が可能。
- **「✓ 意味不要（分かる）」マーク**: 意味の登録が不要な既知の単語もワンタップで整理。
- **辞書一括補完**: シート編集画面の「辞書補完」ボタンで、意味が空欄の単語をまとめて自動検索。

### 3. 🎲 重複なしランダムピックアップ（山札シャッフル方式）
- Fisher-Yatesアルゴリズムによる山札シャッフル方式を採用。
- 登録したすべての単語が一巡するまで、一度引いた単語が重複して出ない仕組み。

### 4. 📝 柔軟な単語登録・編集
- **改行区切りで複数一括追加**: メモやテキストからのコピペで複数単語をまとめて登録。
- **インライン編集**: 一覧カード上で単語・意味の修正や、別シートへの移動が即座に可能。
- **重複の自動防止**: アプリ全体で同一単語の重複登録を自動検知してスキップ。
- **100件ごとの高速ページネーション**: 単語数が数千件規模に増えても快適に動作。

### 5. ☁️ Googleクラウド同期 & 安全設計
- **リアルタイム同期**: Firebase Authentication（Googleログイン）および Realtime Database により、PC・スマホ間で瞬時にデータを同期。
- **完全無料・安全設計**: 課金が発生するAPIキーは一切不使用。Firebase Sparkプラン（無料枠）で運用。

---

## 🛠 技術スタック

- **フロントエンド**: HTML5, CSS3, Vanilla JavaScript (ES6+ / no framework)
- **認証・データベース**: Firebase Authentication, Firebase Realtime Database
- **外部公開API（完全無料・APIキー不要）**:
  - 書籍情報・書影：[openBD API](https://openbd.jp/), [Google Books API](https://developers.google.com/books) (公開エンドポイント)
  - 辞書・意味データ：日本語版 [Wiktionary API](https://ja.wiktionary.org/), 日本語版 [Wikipedia REST API](https://ja.wikipedia.org/)
- **ホスティング**: GitHub Pages

---

## 📄 クレジット・ライセンス

- **単語の意味**: [Wiktionary](https://ja.wiktionary.org/) / [Wikipedia](https://ja.wikipedia.org/) ([CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/deed.ja))
- **書誌情報・書影**: [openBD](https://openbd.jp/) / [Google Books](https://books.google.com/)（書影の著作権は各出版社・著作者に帰属します）


