// DOM（HTML要素）の読み込みが完了したら実行されるイベントリスナー
document.addEventListener('DOMContentLoaded', () => {
    // --- 設定 ---
    // 利用可能な単語リストとそのファイルパスを定義する設定配列
    // ここで定義されたものがプルダウンに表示される
    const WORDLIST_CONFIG = [
        { name: 'Level 1(A1 only)', file: 'wordlists/level1.json' },
        { name: 'Level 2(A1-A2)', file: 'wordlists/level2.json' },
        { name: 'Level 3(A1-B1)', file: 'wordlists/level3.json' },
        { name: 'Level 4(A1-B2)', file: 'wordlists/level4.json' },
    ];
    // 入力後、チェック処理を開始するまでの待機時間（ミリ秒）
    const DEBOUNCE_DELAY = 750;

    // --- DOM要素の取得 ---
    // HTMLから操作対象の要素を取得して変数に格納
    const editor = document.getElementById('editor');                     // テキスト入力エリア (<textarea>)
    const highlightArea = document.getElementById('highlight-area');     // ハイライト表示エリア (<div>)
    const wordlistSelect = document.getElementById('wordlist-select');   // 単語リスト選択プルダウン (<select>)
    const wordCountDisplay = document.getElementById('word-count');      // 単語数表示エリア (<div>)
    const loadingIndicator = document.getElementById('loading-indicator'); // 読み込み中表示 (<span>)

    // --- 状態変数 ---
    // ロードされた単語リストデータを保持するオブジェクト (例: { "go": ["verb"], "study": ["noun", "verb"] })
    let currentWordList = {};
    // デバウンス処理のためのタイマーIDを保持する変数
    let debounceTimer = null;

    // --- 品詞マッピング定義 ---
    // ユーザー定義の品詞ラベル（単語リストJSON内で使うラベル）を
    // compromise.js が出力するタグにマッピングするための定義オブジェクト
    // キー: ユーザー定義ラベル, 値: 対応するcompromiseタグの配列 (先頭に'#'が必要)
    const posMapping = {
        'adverb': ['#Adverb'],
        'verb': ['#Verb'],
        'adjective': ['#Adjective'],
        'noun': ['#Noun'],
        'preposition': ['#Preposition'],
        'conjunction': ['#Conjunction'],
        'determiner': ['#Determiner'],
        'pronoun': ['#Pronoun'],
        'be-verb': ['#Copula'],
        'modal auxi': ['#Modal'], // 'modal auxiliary' と仮定
        'interjection': ['#Interjection'],
        'do-verb': ['#Verb', '#Auxiliary'],
        'number': ['#Value', '#NumericValue', '#Cardinal', '#Ordinal'],
        'have-verb': ['#Verb', '#Auxiliary'],
        'infinitive-to': ['#Infinitive'] // 不定詞の 'to' は #Infinitive タグが付くことが多い
    };

    // --- 関数定義 ---

    /**
     * 単語リスト選択プルダウンの中身を生成する関数
     * WORDLIST_CONFIG の内容に基づいて <option> 要素を追加する
     */
    function populateWordlistSelector() {
        // 既存のオプションをクリア（初期化時に念のため）
        wordlistSelect.innerHTML = '';
        // 設定配列をループしてオプションを生成
        WORDLIST_CONFIG.forEach((listInfo) => {
            const option = document.createElement('option');
            option.value = listInfo.file; // value属性にファイルパスを設定
            option.textContent = listInfo.name; // 表示テキストにリスト名を設定
            wordlistSelect.appendChild(option); // select要素に追加
        });
    }

    /**
     * 指定されたファイルパスから単語リスト(JSON)を非同期で読み込む関数
     * @param {string} filePath - 読み込むJSONファイルのパス
     */
    async function loadWordList(filePath) {
        loadingIndicator.style.display = 'inline'; // 「読み込み中...」を表示
        wordlistSelect.disabled = true;             // 読み込み中はプルダウンを無効化
        editor.disabled = true;                     // 読み込み中はテキストエリアを無効化

        try {
            // fetch API を使ってファイルを非同期で取得
            const response = await fetch(filePath);
            // HTTPステータスコードがエラー(4xx, 5xx)でないかチェック
            if (!response.ok) {
                throw new Error(`HTTPエラー！ ステータス: ${response.status}`);
            }
            // JSON形式のレスポンスボディをJavaScriptオブジェクトに変換
            // *** 重要: JSON形式は { "lemma": ["userPos1", "userPos2"], ... } を想定 ***
            currentWordList = await response.json();
            console.log(`単語リスト読み込み完了: ${filePath}`);
            // 新しいリストが読み込まれたので、現在の入力内容を再チェック
            checkContent();
        } catch (error) {
            console.error("単語リストの読み込みに失敗しました:", error);
            alert(`単語リストの読み込みエラー: ${filePath}\nファイルが存在するか、JSON形式が正しいか確認してください。`);
            currentWordList = {}; // エラー時はリストを空にする
        } finally {
            // 処理が成功しても失敗しても、最後に実行されるブロック
            loadingIndicator.style.display = 'none'; // 「読み込み中...」を非表示
            wordlistSelect.disabled = false;          // プルダウンを再度有効化
            editor.disabled = false;                  // テキストエリアを再度有効化
        }
    }

    /**
     * compromise.js が単語に付けたタグが、許可されたユーザー定義品詞ラベルに対応するか判定する関数
     * @param {string[]} compromiseTags - compromise.js が単語に付けたタグの配列 (例: ['Noun', 'Singular'])
     * @param {string[]} allowedUserPosLabels - 単語リストでその単語（レンマ）に許可されているユーザー定義品詞ラベルの配列 (例: ['noun', 'verb'])
     * @returns {boolean} - 許可されていれば true、そうでなければ false
     */
    function isPosAllowed(compromiseTags, allowedUserPosLabels) {
        // 許可されているユーザー定義ラベルを一つずつチェック
        for (const userLabel of allowedUserPosLabels) {
            // マッピングテーブルから、そのユーザー定義ラベルに対応するcompromiseタグを取得
            const targetCompromiseTags = posMapping[userLabel];
            // マッピング定義が存在する場合
            if (targetCompromiseTags) {
                // 実際の単語についているcompromiseタグの中に、
                // マッピングで定義されたターゲットタグのいずれかが含まれているかチェック
                // Array.some() は、配列のいずれかの要素が条件を満たせば true を返す
                if (compromiseTags.some(tag => targetCompromiseTags.includes('#' + tag))) {
                    return true; // 一致するものが見つかったので true を返す
                }
            }
        }
        // ループが終了しても一致するものが見つからなければ false を返す
        return false;
    }

    /**
     * テキストエリアの内容をチェックし、ハイライト表示エリアと単語数を更新する関数
     */
    function checkContent() {
        // テキストエリアから現在の入力テキストを取得
        const text = editor.value;

        // テキストが空（または空白のみ）の場合は、表示をリセットして処理を終了
        if (!text.trim()) {
            highlightArea.innerHTML = ''; // ハイライト表示をクリア
            wordCountDisplay.textContent = '単語数: 0'; // 単語数を0に
            return;
        }

        // compromise ライブラリを使ってテキストを解析
        const doc = compromise(text);
        // 解析結果から、各単語（term）の詳細情報をJSON形式で取得
        const terms = doc.terms().json();

        let wordCount = 0;      // 単語数をカウントする変数
        let htmlOutput = '';    // ハイライト表示エリア用のHTML文字列を構築する変数

        // 解析された各単語（term）についてループ処理
        terms.forEach(termData => {
            const wordText = termData.text;           // 単語の元のテキスト
            const tags = Object.keys(termData.tags); // compromiseが付与したタグの配列 (例: ['Noun', 'Singular'])

            // --- 単語数のカウント ---
            // 簡単な単語カウント: 'Word'タグを持ち、'Punctuation'や'Whitespace'タグを持たないものをカウント
            // （より厳密なカウントが必要な場合は調整）
            if (tags.includes('Word') && !tags.includes('Punctuation') && !tags.includes('Whitespace')) {
                wordCount++;
            }

            // --- 単語の妥当性チェック ---
            let isValid = false; // 単語がリストの基準を満たすかどうかのフラグ

            // 'Word'タグがあり、句読点や空白でない場合のみチェックを実行
            if (tags.includes('Word') && !tags.includes('Punctuation') && !tags.includes('Whitespace')) {
                // 1. レンマ（見出し語・原形）を取得
                // compromiseのnormalize機能を使う。小文字化も行う。
                // （より複雑な正規化が必要な場合は調整）
                const lemma = compromise(wordText).normalize({ lemma: true }).text() || wordText.toLowerCase();

                // 2. 現在読み込まれている単語リスト(currentWordList)にレンマが存在するか確認
                // 存在すれば、許可されているユーザー品詞ラベルの配列が取得できる
                const allowedUserPosLabels = currentWordList[lemma];

                // 3. レンマがリストに存在する場合
                if (allowedUserPosLabels) {
                    // 4. 特別ルール: 単語 "to" の場合のチェック
                    if (wordText.toLowerCase() === 'to') {
                        // compromiseが 'to' に付けたタグをチェック
                        const isInfTo = tags.includes('Infinitive'); // 不定詞マーカーの 'to' か？
                        const isPrep = tags.includes('Preposition'); // 前置詞の 'to' か？

                        // 不定詞マーカーと判定され、リストで 'infinitive-to' が許可されている場合 -> OK
                        if (isInfTo && allowedUserPosLabels.includes('infinitive-to')) {
                            isValid = true;
                        // 前置詞と判定され、リストで 'preposition' が許可されている場合 -> OK
                        } else if (isPrep && allowedUserPosLabels.includes('preposition')) {
                            isValid = true;
                        }
                        // それ以外（リストにはあるが、compromiseの判定とリストの許可が合わない） -> NG (isValidはfalseのまま)
                    } else {
                        // 5. "to" 以外の単語の品詞チェック
                        // isPosAllowed関数を使って、compromiseのタグとリストの許可品詞が一致するか確認
                        isValid = isPosAllowed(tags, allowedUserPosLabels);
                    }
                } else {
                    // 6. レンマが単語リストに存在しない場合 -> NG
                    isValid = false;
                }

                // オプション: リストに無くても固有名詞(#ProperNoun)や数値(#Value)は許可する？
                // if (tags.includes('ProperNoun') || tags.includes('Value')) { isValid = true; }

            } else {
                // 句読点や空白などは、チェック対象外とし、常に「有効」扱いとする（赤字にしない）
                isValid = true;
            }

            // --- HTML出力の構築 ---
            // 単語が有効（リストの基準を満たす、または句読点など）の場合
            if (isValid) {
                htmlOutput += escapeHtml(wordText); // そのままのテキストを追加 (HTMLエスケープ推奨)
            } else {
                // 単語が無効（リストの基準外）の場合、<span class="invalid-word">で囲む
                htmlOutput += `<span class="invalid-word">${escapeHtml(wordText)}</span>`;
            }
        });

        // --- 表示の更新 ---
        // 単語数表示を更新
        wordCountDisplay.textContent = `単語数: ${wordCount}`;
        // ハイライト表示エリアの内容を、構築したHTML文字列で置き換え
        highlightArea.innerHTML = htmlOutput;
    }

    /**
     * HTML特殊文字をエスケープするヘルパー関数
     * @param {string} text - エスケープするテキスト
     * @returns {string} - エスケープ後のテキスト
     */
     function escapeHtml(text) {
        const map = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        };
        return text.replace(/[&<>"']/g, function(m) { return map[m]; });
    }


    /**
     * 関数の実行を遅延させる（デバウンス）関数
     * @param {Function} func - 遅延実行させたい関数
     * @param {number} delay - 遅延時間（ミリ秒）
     * @returns {Function} - デバウンス化された関数
     */
    function debounce(func, delay) {
        // 内部でタイマーIDを保持
        return function(...args) {
            // 既存のタイマーがあればクリア
            clearTimeout(debounceTimer);
            // 新しいタイマーを設定し、指定時間後に関数を実行
            debounceTimer = setTimeout(() => {
                // funcを元のコンテキスト(this)と引数で実行
                func.apply(this, args);
            }, delay);
        };
    }

    // --- イベントリスナーの設定 ---

    // テキストエリアの入力イベント('input')に対して、デバウンス処理を施したcheckContent関数を登録
    // 入力が止まってから DEBOUNCE_DELAY ミリ秒後に checkContent が実行される
    editor.addEventListener('input', debounce(checkContent, DEBOUNCE_DELAY));

    // 単語リスト選択プルダウンの変更イベント('change')に対して、リスト読み込み関数を登録
    wordlistSelect.addEventListener('change', (event) => {
        // 選択されたオプションのvalue（ファイルパス）を取得してリストを読み込む
        loadWordList(event.target.value);
    });

    // --- 初期化処理 ---
    // ページ読み込み時にプルダウンの選択肢を生成
    // populateWordlistSelector(); // HTMLにあらかじめ記述したので不要

    // ページ読み込み時に、デフォルト（最初）の単語リストを読み込む
    if (WORDLIST_CONFIG.length > 0) {
        loadWordList(wordlistSelect.value); // 現在選択されている値（デフォルトで最初のリストのパス）を使う
    } else {
        console.warn("単語リストが設定されていません。");
        alert("単語リストが設定されていません。script.jsを確認してください。");
    }
});
