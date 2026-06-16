// ui-manager.js
import { game } from "./game-logic.js";
import { isHost, rawPlayerList, broadcastState, hostKickPlayer, hostTransferAuthority, hostRemoveDisconnectedPlayer, connToHost } from "./network-manager.js";

// 現在選択されている入札用の追加コイン枚数
let currentSelectedCoins = 0;

// 物件の絵文字をNoごとに決定するヘルパー
function getCardEmoji(val) {
    if (val <= 5) return "🧻"; // トイレ・小屋
    if (val <= 10) return "⛺"; // テント
    if (val <= 15) return "🏠"; // 一般住宅
    if (val <= 20) return "🏢"; // ビル
    if (val <= 25) return "🏰"; // 城
    return "🚀"; // 超豪華宇宙ステーション
}

export function hostStartGame() {
    if (!isHost) return;
    const success = game.initRound(rawPlayerList);
    if (success) {
        document.getElementById("start-game-btn").style.display = "none";
        currentSelectedCoins = 0;
        broadcastState();
        updateUI();
    }
}

export function hostNextRound() {
    if (!isHost) return;
    const currentScores = {};
    game.players.forEach(p => { currentScores[p.id] = p.score; });
    
    rawPlayerList.forEach(p => {
        p.score = currentScores[p.id] || 0;
    });

    const success = game.initRound(rawPlayerList);
    if (success) {
        const nextBtn = document.getElementById("next-round-btn");
        if (nextBtn) nextBtn.style.display = "none";
        currentSelectedCoins = 0;
        broadcastState();
        updateUI();
    }
}

export function updateUI() {
    const setupContainer = document.getElementById("setup-container");
    const lobbyContainer = document.getElementById("lobby-container");
    const gameContainer = document.getElementById("game-container");

    // 1. 画面表示の排他制御
    if (window.myId) { 
        setupContainer.style.display = "none";
        if (game.isGameStarted) {
            lobbyContainer.style.display = "none";
            gameContainer.style.display = "block";
        } else {
            lobbyContainer.style.display = "block";
            gameContainer.style.display = "none";
        }
    } else {
        setupContainer.style.display = "block";
        lobbyContainer.style.display = "none";
        gameContainer.style.display = "none";
    }

    // 2. 山札（残り枚数）の描画
    const deckCountNum = document.getElementById("deck-count-num");
    const deckPileVisual = document.getElementById("deck-pile-visual");
    if (deckCountNum && deckPileVisual) {
        if (game.isGameStarted) {
            deckCountNum.innerText = game.deck.length;
            deckPileVisual.style.background = game.phase === "BID" ? "linear-gradient(135deg, #27ae60, #2ecc71)" : "linear-gradient(135deg, #3498db, #2980b9)";
        } else {
            deckCountNum.innerText = "--";
        }
    }

    // 3. 上部ステータスバーのアクションテキスト
    const roleDisplayEl = document.getElementById("role-display");
    if (roleDisplayEl) {
        if (!game.isGameStarted) {
            roleDisplayEl.innerText = isHost ? "👑 ホスト（待機中）" : "🟢 ゲスト（待機中）";
        } else {
            const currentTurnPlayer = game.players[game.turnIndex];
            if (currentTurnPlayer) {
                if (currentTurnPlayer.id === window.myId) {
                    roleDisplayEl.innerText = "あなたは行動を選んでください";
                    roleDisplayEl.style.color = "#e74c3c";
                } else {
                    roleDisplayEl.innerText = `${currentTurnPlayer.name} の手番を待っています...`;
                    roleDisplayEl.style.color = "#2c3e50";
                }
            }
        }
    }

    // 各種システム系管理ボタン
    const startBtn = document.getElementById("start-game-btn");
    if (startBtn) startBtn.style.display = (isHost && !game.isGameStarted) ? "block" : "none";

    const nextRoundBtn = document.getElementById("next-round-btn");
    if (nextRoundBtn) {
        nextRoundBtn.style.display = (isHost && game.isGameStarted && typeof game.isGameEnded === "function" && game.isGameEnded()) ? "block" : "none";
    }

    // 各種コンポーネントの専用描画
    if (!game.isGameStarted) {
        renderLobbyPlayerList();
    } else {
        renderSidePlayerList();
        renderBidStatusBoard();
        renderMarket();
        renderConsoleAndHand();
    }
    
    renderCustomSettingsUI();

    // データの自動同期不整合検知（既存維持）
    if (!isHost && game.isGameStarted && game.players && game.players.length > 0) {
        const myGameData = game.players.find(p => p.id === window.myId);
        if (myGameData && myGameData.coins === undefined) {
            if (connToHost && connToHost.open) {
                connToHost.send(JSON.stringify({ type: "REQUEST_SYNC", playerId: window.myId, playerName: myGameData.name }));
            }
        }
    }
}

/* ==========================================================================
   📋 待機ロビー専用のリスト描画
   ========================================================================== */
function renderLobbyPlayerList() {
    const listEl = document.getElementById("lobby-player-list");
    if (!listEl) return;
    listEl.innerHTML = "";

    rawPlayerList.forEach(p => {
        const item = document.createElement("div");
        item.className = "lobby-player-item";
        
        const nameSpan = document.createElement("span");
        nameSpan.style.fontWeight = "bold";
        const hostCrown = p.isHost ? "👑 " : "";
        nameSpan.innerHTML = `${hostCrown}${p.name} <span class="score-badge">${p.score || 0}勝</span>`;
        item.appendChild(nameSpan);

        if (isHost && p.id !== window.myId) {
            const btnGroup = document.createElement("div");
            btnGroup.className = "host-action-group";
            
            const transBtn = document.createElement("button");
            transBtn.className = "btn-host-transfer";
            transBtn.innerText = "権限譲渡";
            transBtn.onclick = () => hostTransferAuthority(p.id);

            const kickBtn = document.createElement("button");
            kickBtn.className = "btn-danger";
            kickBtn.innerText = "キック";
            kickBtn.onclick = () => hostKickPlayer(p.id);
            
            btnGroup.appendChild(transBtn);
            btnGroup.appendChild(kickBtn);
            item.appendChild(btnGroup);
        }
        listEl.appendChild(item);
    });
}

/* ==========================================================================
   🎮 ゲーム中専用：右側サイドバーの縦並びプレイヤーリスト描画
   ========================================================================== */
function renderSidePlayerList() {
    const sideEl = document.getElementById("game-side-players");
    if (!sideEl) return;
    sideEl.innerHTML = "";

    rawPlayerList.forEach(p => {
        const pInGame = game.players.find(gp => gp.id === p.id);
        if (!pInGame) return;

        const card = document.createElement("div");
        card.className = "side-player-card";
        
        if (p.disconnected) card.classList.add("disconnected");
        
        const currentTurnPlayer = game.players[game.turnIndex];
        if (currentTurnPlayer && currentTurnPlayer.id === p.id) {
            card.classList.add("active-turn");
        }

        const hostCrown = p.isHost ? "👑 " : "";
        const nameDiv = document.createElement("div");
        nameDiv.className = "side-player-name";
        nameDiv.innerHTML = `<span>${hostCrown}${p.name}</span> <span class="score-badge">${p.score || 0}勝</span>`;
        card.appendChild(nameDiv);

        // 各フェーズに応じたBGA風のパラメータ表示
        const statsDiv = document.createElement("div");
        statsDiv.className = "side-player-stats";
        if (game.phase === "BID") {
            // 競りフェーズ：現在のパス状況、保持コイン、入札値
            const passedText = pInGame.hasPassed ? "🏳️ パス済" : "🔨 参戦中";
            statsDiv.innerHTML = `<span>${passedText}</span> <span>🪙 ${pInGame.coins}k$</span>`;
        } else {
            // 売却フェーズ：現在の獲得総額
            statsDiv.innerHTML = `<span>💵 獲得額: $${pInGame.score || 0},000</span>`;
        }
        card.appendChild(statsDiv);
        sideEl.appendChild(card);
    });
}

/* ==========================================================================
   💬 ゲーム中専用：中央エリアの各人入札ログボックス
   ========================================================================== */
function renderBidStatusBoard() {
    const boardEl = document.getElementById("bid-status-board");
    if (!boardEl) return;
    boardEl.innerHTML = "";

    game.players.forEach(p => {
        const box = document.createElement("div");
        box.className = "bid-box";
        if (p.id === window.myId) box.classList.add("current-player");

        if (game.phase === "BID") {
            const statusStr = p.hasPassed ? "<span style='color:#7f8c8d;'>(パスアウト)</span>" : "";
            box.innerHTML = `<strong>${p.name}</strong> は入札した <span style='color:#e67e22; font-weight:bold;'>${p.bid || 0}</span> k$ ${statusStr}`;
        } else {
            const hasPlayed = p.hasPassed ? "🟢 提示完了" : "⏳ 選択中...";
            box.innerHTML = `<strong>${p.name}</strong>: ${hasPlayed}`;
        }
        boardEl.appendChild(box);
    });
}

/* ==========================================================================
   🏢 ゲーム中専用：カードマーケット（場）の描画
   ========================================================================== */
function renderMarket() {
    const listEl = document.getElementById("card-tracker-list");
    const titleEl = document.getElementById("market-title-text");
    if (!listEl) return;
    listEl.innerHTML = "";

    if (game.phase === "BID") {
        if (titleEl) titleEl.innerText = "競売にかけられた物件";
    } else {
        if (titleEl) titleEl.innerText = "オープンされた小切手 (ドル札)";
    }

    if (!game.market || game.market.length === 0) {
        listEl.innerHTML = "<p style='color:#7f8c8d;'>場にオープンされたカードはありません</p>";
        return;
    }

    game.market.forEach(val => {
        const card = document.createElement("div");
        card.className = "game-card";
        
        if (game.phase === "BID") {
            card.style.background = "#fff";
            card.innerHTML = `
                <div class="card-top-num">${val}</div>
                <div class="card-illustration">${getCardEmoji(val)}</div>
                <div class="card-bottom-num">${val}</div>
            `;
        } else {
            card.style.background = "#d4efdf";
            card.style.borderColor = "#27ae60";
            card.innerHTML = `
                <div class="card-top-num" style="color:#27ae60;">$${val}k</div>
                <div class="card-illustration">💵</div>
                <div class="card-bottom-num" style="color:#27ae60;">$${val}k</div>
            `;
        }
        listEl.appendChild(card);
    });
}

/* ==========================================================================
   🕹️ ゲーム中専用：下部コンソールおよび手札（コイン丸ボタン・所持物件）
   ========================================================================== */
function renderConsoleAndHand() {
    const consoleInfo = document.getElementById("console-info-text");
    const cardArea = document.getElementById("card-area");
    if (!cardArea) return;
    cardArea.innerHTML = "";

    const me = game.players.find(p => p.id === window.myId);
    if (!me) return;

    const currentTurnPlayer = game.players[game.turnIndex];
    const isMyTurn = currentTurnPlayer && currentTurnPlayer.id === window.myId;

    if (game.phase === "BID") {
        // 現在の場の最高入札額
        const currentHighest = Math.max(...game.players.map(p => Number(p.bid || 0)), 0);
        const minNeed = currentHighest + 1;
        
        // 自分がすでに乗せている現在の入札額
        const myCurrentBid = me.bid || 0;

        if (consoleInfo) {
            consoleInfo.innerHTML = `あなたの現在の入札値: <strong>${myCurrentBid}</strong> k$ | あなたの手持ちコイン: <strong>${me.coins}</strong> 枚 | 次に必要な最低値: <strong>${minNeed}</strong> k$`;
        }

        // 行動ボタンにイベントを直接アタッチ
        const bidBtn = document.getElementById("submit-bid-btn");
        const passBtn = document.getElementById("submit-pass-btn");

        if (bidBtn && passBtn) {
            if (isMyTurn && !me.hasPassed) {
                bidBtn.disabled = false;
                passBtn.disabled = false;
                
                // 入札実行ロジック
                bidBtn.onclick = () => {
                    if (currentSelectedCoins < minNeed) {
                        alert(`入札額が足りません！最低 ${minNeed}k$ 以上になるようにコインを選んでください。`);
                        return;
                    }
                    if (currentSelectedCoins > me.coins) {
                        alert("手持ちのコイン以上の入札はできません。");
                        return;
                    }
                    executePlayCard(currentSelectedCoins, {});
                };

                // パス実行ロジック
                passBtn.onclick = () => {
                    executePlayCard(-1, {});
                };
            } else {
                bidBtn.disabled = true;
                passBtn.disabled = true;
            }
        }

        // コインセレクター丸ボタンのレンダリング
        if (me.hasPassed) {
            cardArea.innerHTML = "<p style='color:#7f8c8d;'>このラウンドはパスアウトしました。全員の競り終了を待っています...</p>";
            return;
        }

        const coinContainer = document.createElement("div");
        coinContainer.className = "coin-selector-container";

        // 1から手持ちコイン最大値までのボタンを生成
        for (let i = 1; i <= me.coins; i++) {
            const coinBtn = document.createElement("div");
            coinBtn.className = "coin-button";
            coinBtn.innerText = `${i}\n1,000`;
            
            // 現在選択されている額と同じならハイライト
            if (currentSelectedCoins === i) coinBtn.classList.add("selected");
            
            if (isMyTurn) {
                coinBtn.onclick = () => {
                    currentSelectedCoins = i;
                    renderConsoleAndHand(); // 再描画してハイライトを更新
                };
            } else {
                coinBtn.style.cursor = "not-allowed";
                coinBtn.style.opacity = "0.7";
            }
            coinContainer.appendChild(coinBtn);
        }

        // デフォルトで最低金額にフォーカスを合わせる補助
        if (currentSelectedCoins < minNeed && me.coins >= minNeed) {
            currentSelectedCoins = minNeed;
            // 限界を超える場合は持てる最大
        } else if (currentSelectedCoins === 0 && me.coins > 0) {
            currentSelectedCoins = Math.min(minNeed, me.coins);
        }

        cardArea.appendChild(coinContainer);

    } else {
        // 売却（小切手）フェーズ：手札の物件カードを並べる
        if (consoleInfo) {
            consoleInfo.innerHTML = "提示する物件カード（手札）を1枚選んで場に出してください。";
        }

        // 売却フェーズでは入札ボタンは不要
        document.getElementById("submit-bid-btn").disabled = true;
        document.getElementById("submit-pass-btn").disabled = true;

        if (me.hasPassed) {
            cardArea.innerHTML = "<p style='color:#2ecc71;'>物件を提示しました。全員のオープンを待っています...</p>";
            return;
        }

        me.hand.forEach((val) => {
            const card = document.createElement("div");
            card.className = "game-card";
            card.style.display = "inline-block";
            card.style.margin = "5px";
            card.style.background = "#fff";
            
            card.innerHTML = `
                <div class="card-top-num">${val}</div>
                <div class="card-illustration">${getCardEmoji(val)}</div>
                <div class="card-bottom-num">${val}</div>
            `;

            if (isMyTurn) {
                card.onclick = () => {
                    if (confirm(`物件 No.${val} を場に提示しますか？`)) {
                        executePlayCard(val, {});
                    }
                };
                card.style.cursor = "pointer";
                card.style.transform = "hover: translateY(-5px)";
            } else {
                card.style.cursor = "not-allowed";
                card.style.opacity = "0.5";
            }
            cardArea.appendChild(card);
        });
    }
}

function executePlayCard(actionValue, target) {
    if (isHost) {
        game.playCard(window.myId, actionValue, target);
        currentSelectedCoins = 0; // 送信に成功したら選択をリセット
        broadcastState();
        updateUI();
    } else {
        if (connToHost && connToHost.open) {
            connToHost.send(JSON.stringify({
                type: "ACTION",
                playerId: window.myId,
                actionValue: actionValue,
                target: target
            }));
            currentSelectedCoins = 0;
        }
    }
}

/* ==========================================================================
   ⚙️ カスタム設定UI（既存維持）
   ========================================================================== */
export function renderCustomSettingsUI() {
    const div = document.getElementById("integrated-custom-settings");
    if (!div) return;

    if (!isHost) {
        div.style.opacity = "0.5";
        div.style.pointerEvents = "none";
    } else {
        div.style.opacity = "1.0";
        div.style.pointerEvents = "auto";
    }

    const titleText = isHost ? "⚙️ ルームカスタム設定 (ホスト権限)" : "📋 現在のルームカスタム設定 (閲覧のみ)";
    const disabledAttr = isHost ? "" : "disabled";

    div.innerHTML = `
        <h3 style="margin-top:0;">${titleText}</h3>
        <div style="background: rgba(0,0,0,0.2); padding: 10px; border-radius: 6px; margin-top: 5px; border: 1px solid #f1c40f;">
            <div class="setting-item" style="display:flex; justify-content:space-between; margin-bottom:8px;">
                <span>初期配布コイン枚数 (🪙):</span>
                <input type="number" id="cfg-initial-coins" value="${game.initialCoins || 18}" min="5" max="30" ${disabledAttr} style="width:60px;">
            </div>
            <div class="setting-item" style="display:flex; justify-content:space-between;">
                <span>1フェーズあたりのターン数:</span>
                <input type="number" id="cfg-custom-turns" value="${game.customTurns || 5}" min="2" max="15" ${disabledAttr} style="width:60px;">
            </div>
        </div>
    `;

    if (isHost) {
        document.getElementById("cfg-initial-coins")?.addEventListener("change", (e) => {
            game.initialCoins = Math.max(5, parseInt(e.target.value) || 18);
            broadcastState();
            updateUI();
        });

        document.getElementById("cfg-custom-turns")?.addEventListener("change", (e) => {
            game.customTurns = Math.max(2, parseInt(e.target.value) || 5);
            broadcastState();
            updateUI();
        });
    }
}

export function syncGuestSettingsUI(cardSettings, drawSettings) {}
export function injectCustomSettingsUIIntoGame() {}
export function injectAbortButton() {}