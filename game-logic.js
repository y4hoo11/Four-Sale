// game-logic.js

class FourSaleGame {
    constructor() {
        this.isGameStarted = false;
        this.players = [];
        this.turnIndex = 0;
        this.logMessages = [];

        // フォーセールのコアデータ
        this.phase = "BID"; // "BID" (フェーズ1: 物件の競り) または "SELL" (フェーズ2: 小切手売却)
        this.deck = [];     // 現在のフェーズの山札（物件カード or 小切手カード）
        this.market = [];   // 場にオープンされたカード（競りや売却の対象）
        this.highestBid = 0; // フェーズ1の現在最高入札額

        // 💡 ホスト変更可能な初期コイン設定（初期値18）
        this.initialCoins = 18;
        // 💡 ホスト変更可能な1フェーズあたりの設定ターン数（デフォルトは5ターン）
        this.customTurns = 5;

        // UI設定との互換用
        this.cardSettings = {};
        this.defaultCardSettings = {};
        this.drawSettings = { firstTurnCount: 0, everyTurnCount: 0 };
        this.isGameEndedStatus = false;
    }

    log(msg) {
        this.logMessages.push(msg);
        if (this.logMessages.length > 50) this.logMessages.shift();

        // サーバー・クライアント共通でログボックスへ即座に反映
        const logBox = document.getElementById("log-box");
        if (logBox) {
            logBox.innerHTML = "";
            this.logMessages.forEach(m => {
                const p = document.createElement("p");
                p.style.margin = "3px 0";
                p.innerHTML = m;
                logBox.appendChild(p);
            });
            logBox.scrollTop = logBox.scrollHeight;
        }
    }

    // ホストがゲームを開始/次のラウンドへ進むときの初期化
    initRound(rawPlayerList) {
        const activePlayers = rawPlayerList.filter(p => !p.disconnected);
        const pCount = activePlayers.length;

        // 💡 プレイ人数が 3〜6人 の範囲外の場合は弾く
        if (pCount < 3 || pCount > 6) {
            alert("フォーセールを遊ぶには3人〜6人のプレイヤー（接続中）が必要です。");
            return false;
        }

        this.isGameStarted = true;
        this.isGameEndedStatus = false; // フラグリセット
        this.phase = "BID";
        this.highestBid = 0;
        this.turnIndex = 0;

        // 1. プレイヤーの初期化（ホストが設定した initialCoins を適用）
        this.players = activePlayers.map(p => ({
            id: p.id,
            name: p.name,
            coins: this.initialCoins,   // 💡 カスタマイズされた初期コイン
            bid: 0,                     // このラウンドの現在入札額
            hasPassed: false,           // 競りから抜けたか
            hand: [],                   // 獲得した物件カード（フェーズ2の手札になる）
            checks: [],                 // 獲得した小切手カード（最終スコア用）
            alive: true,                // ui-manager.jsとの互換用
            spectator: false,           // 同上
            protected: false,           // 同上
            history: []                 // 同上（獲得物件の一覧表示に流用）
        }));

        // 2. 物件カードデッキの作成
        const turns = this.customTurns || 5; 
        const targetCardCount = pCount * turns; // 💡 必要な総枚数（人数 × ターン数）

        let propertyDeck = [];
        // 💡 制限解除：必要な枚数に達するまで、1〜30のカードを繰り返しループして追加
        while (propertyDeck.length < targetCardCount) {
            for (let i = 1; i <= 30; i++) {
                propertyDeck.push(i);
                if (propertyDeck.length === targetCardCount) break;
            }
        }
        
        // 正確にシャッフル
        this.shuffle(propertyDeck);
        this.deck = propertyDeck;

        this.log("🏢 <b>【フェーズ1: 物件の競り】が始まりました！</b>");
        this.log(`全員に初期資金として通貨チップ 🪙<b>${this.initialCoins}枚</b> が配られました。`);
        this.log(`（現在のプレイ人数: ${pCount}人 / 各フェーズ: ${turns}ターン / 山札の初期枚数: ${this.deck.length}枚）`);
        
        this.startLayout();
        return true;
    }

    // 新しい場（カードのオープン）を作る
    startLayout() {
        this.highestBid = 0;
        this.players.forEach(p => {
            p.bid = 0;
            p.hasPassed = false;
        });

        // 💡 プレイ人数と同じ枚数（3人なら3枚、4人なら4枚...）を山札からオープン
        const count = this.players.length;
        this.market = [];
        for (let i = 0; i < count; i++) {
            if (this.deck.length > 0) {
                this.market.push(this.deck.pop());
            }
        }

        // 昇順（小さい順）にソート
        this.market.sort((a, b) => a - b);

        if (this.phase === "BID") {
            this.log(`アンベール！場に物件が並びました：[ ${this.market.join(", ")} ]`);
        } else {
            this.log(`アンベール！場に小切手が並びました：[ ${this.market.map(v => `$${v},000`).join(", ")} ]`);
            // 売却フェーズでは全員の行動フラグをリセット
            this.players.forEach(p => p.hasPassed = false);
        }
    }

    // プレイヤーの行動処理 (ui-manager.js から ACTION が飛んできた時に発火)
    playCard(playerId, actionValue, target) {
        // 🚀 ここにデバッグログを挿入
        console.log("=== 【ロジック到達デバッグ】 ===");
        console.log("1. 届いたplayerId:", playerId);
        console.log("2. 届いたactionValue:", actionValue, "型:", typeof actionValue);
        console.log("3. 現在のゲーム全体の最高入札額(highestBid):", this.highestBid);

        const p = this.players.find(pl => pl.id === playerId);
        if (!p) {
            console.log("❌ プレイヤーが見つかりませんでした。ID:", playerId);
            return;
        } else {
            console.log("4. 見つかったプレイヤーオブジェクト:", JSON.parse(JSON.stringify(p)));
        }

        if (this.phase === "BID") {
            // ----------------------------------------------------
            // 【フェーズ1: 競り】での処理
            // ----------------------------------------------------
            if (actionValue === -1) {
                this.processPass(p);
            } else {
                // 💡 確実に整数（Number）に変換
                const bidAmount = parseInt(actionValue, 10); 
                
                if (bidAmount <= Number(this.highestBid)) {
                    this.log(`⚠️ 警告: ${p.name} の入札額(${bidAmount}枚)が最高入札額以下です。`);
                    return;
                }
                if (bidAmount > p.coins) {
                    this.log(`⚠️ 警告: ${p.name} の所持コインが足りません。`);
                    return;
                }
                
                // 個人の入札値を更新
                p.bid = bidAmount;

                // 💡 重要：通信パケット（連想配列）になっても数値として絶対同期されるよう、
                // プロパティ自体に全員の入札額のリアルタイム最大値をダイレクトに叩き込む
                this.highestBid = Math.max(...this.players.map(pl => Number(pl.bid || 0)));
                
                this.log(`💰 ${p.name} が 🪙<b>${bidAmount}枚</b> を入札しました。`);
                
                // 次のプレイヤーへ手番を回す
                this.advanceTurn();
            }
        } else {
            // ----------------------------------------------------
            // 【フェーズ2: 売却】での処理
            // ----------------------------------------------------
            if (!p.hand.includes(actionValue)) return;
            
            p.bid = actionValue; // 出した物件を一時的にbid変数に格納して判定に使う
            p.hasPassed = true;  // 出し終わったフラグ
            
            // 手札から消費
            p.hand = p.hand.filter(v => v !== actionValue);
            this.log(`🏠 ${p.name} が物件 <b>No.${actionValue}</b> を提示しました（裏向き）。`);

            // 全員が出し終えたかチェック
            const allSubmitted = this.players.every(pl => pl.hasPassed);
            if (allSubmitted) {
                this.resolveSellPhase();
            } else {
                this.advanceTurn();
            }
        }
    }

    // 競りでのパス処理
    processPass(p) {
        p.hasPassed = true;
        // 現在残っている最も数値が小さい物件を獲得
        const rewardedProperty = this.market.shift();
        p.hand.push(rewardedProperty);
        p.history.push(rewardedProperty); // 履歴欄にも表示させる

        // 🪙 奇数対応：入札額の「半分」を計算する際、端数を切り上げて支払額（ロス）にする
        // 例: 5枚入札してパス ➡️ 5 / 2 = 2.5 ➡️ 切り上げて 3枚支払い
        const payAmount = Math.ceil(p.bid / 2);
        p.coins -= payAmount;

        // 残りのコイン（p.bid - payAmount）は、最初から p.coins から引いていないため自動的に手元に残ります
        this.log(`🏳️ ${p.name} がパス。🪙${payAmount}枚 を支払い、物件 <b>No.${rewardedProperty}</b> を獲得。`);

        // 競りに残っている人数を数える
        const activePlayers = this.players.filter(pl => !pl.hasPassed);

        if (activePlayers.length === 1) {
            // 最後に残った1人が自動的に最高額の物件を買い取る（全額支払い）
            const lastPlayer = activePlayers[0];
            const topProperty = this.market.shift();
            lastPlayer.hand.push(topProperty);
            lastPlayer.history.push(topProperty);
            lastPlayer.coins -= lastPlayer.bid;

            this.log(`👑 ${lastPlayer.name} が競りに勝ち、🪙${lastPlayer.bid}枚 で物件 <b>No.${topProperty}</b> を獲得。`);

            // 次の場を作るか、フェーズ2へ移行するか
            // 💡 最後の1人は全額支払って競りが終了するため、全員のbidをリセットする前に移行判定へ
            this.checkPhaseTransition();
        } else if (activePlayers.length === 0) {
            this.checkPhaseTransition();
        } else {
            // 💡 パスが発生した際も、残ったプレイヤーの中で最高入札額を確実に再集計する
            // ここでNumber型変換を保証してバグを完全に抑制
            this.highestBid = Math.max(...this.players.map(pl => Number(pl.bid || 0)));
            this.advanceTurn();
        }
    }

    // 売却フェーズの解決（全員が出した物件の大きさに応じて小切手を配る）
    resolveSellPhase() {
        // 出した物件が大きいプレイヤー順に並び替え
        const submitList = [...this.players].sort((a, b) => b.bid - a.bid);
        
        // 小切手（場）も高い順にソートして、高い物件を出した人に高い小切手を配る
        this.market.sort((a, b) => b - a);

        submitList.forEach((p, idx) => {
            const checkVal = this.market[idx];
            p.checks.push(checkVal);
            // リアルタイムでの集計スコア同期用（小切手総額）
            p.score = p.checks.reduce((sum, v) => sum + v, 0);
            this.log(`💵 ${p.name} (物件:${p.bid}) ➡️ 小切手 <b>$${checkVal},000</b> を獲得！`);
        });

        this.checkPhaseTransition();
    }

    // ターンの進行とスキップ処理
    advanceTurn() {
        const total = this.players.length;
        for (let i = 0; i < total; i++) {
            this.turnIndex = (this.turnIndex + 1) % total;
            if (!this.players[this.turnIndex].hasPassed) {
                return; // 次のパスしていないプレイヤーがいれば確定
            }
        }
    }

    // フェーズ切り替えおよびゲーム終了チェック
    checkPhaseTransition() {
        if (this.deck.length > 0) {
            // まだ現在のフェーズの山札があれば次へ
            this.startLayout();
            // 次のミニラウンド（場）が始まる際、手番インデックスをはじめのプレイヤー（0）に初期化して停滞を防ぐ
            this.turnIndex = 0; 
        } else if (this.phase === "BID") {
            // 物件山札が切れたら 【フェーズ2: 小切手の売却】 へ
            this.phase = "SELL";
            this.log("💵 <b>【フェーズ2: 小切手の売却】に突入しました！</b>");
            this.log("手札の物件を1枚選んで一斉に出し、高い小切手を奪い合いましょう。");

            // 1. 公式準拠の基本30枚セット($0〜$15,000)
            const baseCheckValues = [
                0, 0, 2, 2, 3, 3, 4, 4, 5, 5, 
                6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 
                11, 11, 12, 12, 13, 13, 14, 14, 15, 15
            ];

            // 2. 重複なしの全15種類（均等追加用のプール）
            const uniqueChecks = [0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

            const pCount = this.players.length;
            const turns = this.customTurns || 5;
            const targetCardCount = pCount * turns; // 必要となる小切手の総枚数

            let checkValues = [...baseCheckValues]; // まず基本の30枚を入れる

            // 💡 30枚で足りない場合の「均等追加ロジック」
            if (targetCardCount > baseCheckValues.length) {
                const neededCount = targetCardCount - baseCheckValues.length; // 不足枚数

                let addedCount = 0;
                while (addedCount < neededCount) {
                    // 今回のループで追加する枚数 (最大15枚)
                    const currentLoopCount = Math.min(neededCount - addedCount, uniqueChecks.length);

                    if (currentLoopCount === uniqueChecks.length) {
                        // 15枚丸ごと必要な場合はそのまま全員追加
                        checkValues.push(...uniqueChecks);
                    } else {
                        // 小さい数と大きい数を等間隔にバラけさせてピックアップ
                        for (let i = 1; i <= currentLoopCount; i++) {
                            const ratio = i / (currentLoopCount + 1);
                            const targetIdx = Math.floor(ratio * uniqueChecks.length);
                            checkValues.push(uniqueChecks[targetIdx]);
                        }
                    }
                    addedCount += currentLoopCount;
                }
            } else if (targetCardCount < baseCheckValues.length) {
                // 設定された総枚数が30枚より少ない場合は、30枚から削る
                checkValues = checkValues.slice(0, targetCardCount);
            }

            // 最終的に出来上がった拡張デッキをシャッフル
            this.shuffle(checkValues);
            this.deck = checkValues;

            // 表示履歴クリア
            this.players.forEach(p => p.history = []);

            this.startLayout();
            this.turnIndex = 0;
        } else {
            // 全て終了！最終スコア集計
            this.endRound();
        }
    }

    // 最終決算
    endRound() {
        this.log("🏁 <b>ゲームが終了しました！最終決算を行います。</b>");
        
        let winner = null;
        let maxTotal = -1;

        this.players.forEach(p => {
            const checkTotal = p.checks.reduce((sum, v) => sum + v, 0); // 小切手の合計
            const coinBonus = p.coins;                                  // 残ったコイン枚数
            
            // 最終スコア ＝ 小切手合計 ＋ 残ったコインの枚数分
            const finalScore = checkTotal + coinBonus;
            p.score = finalScore; // UIバッジに最終スコアを表示

            this.log(`📊 ${p.name}: 小切手 <b>$${checkTotal},000</b> + 残りコイン <b>🪙${coinBonus}枚</b> ➡️ 最終スコア: <b>${finalScore}</b>`);

            if (finalScore > maxTotal) {
                maxTotal = finalScore;
                winner = p.name;
            }
        });

        this.log(`🎉 🏆 勝者は <b>${winner}</b> です！おめでとうございます！`);
        this.isGameEndedStatus = true;
    }

    isGameEnded() {
        return this.isGameEndedStatus || false;
    }

    // Fisher-Yates シャッフルアルゴリズムの正常化
    shuffle(array) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
    }
}

export const game = new FourSaleGame();
window.game = game;