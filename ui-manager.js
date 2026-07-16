// ui-manager.js
import { game } from "./game-logic.js";
import { isHost, rawPlayerList, broadcastState, hostKickPlayer, hostTransferAuthority, connToHost } from "./network-manager.js";

// 現在選択されている入札用の追加コイン枚数
let currentSelectedCoins = 0;

// ゲストがホストから最初のデータ同期を完了したかどうかのフラグ
let isFirstSyncReceived = false;

// ゲスト側でデータを受信したときに呼び出す同期完了通知関数
export function markFirstSyncComplete() {
    isFirstSyncReceived = true;
}

// 物件の絵文字をNoごとに決定するヘルパー
function getCardEmoji(val) {
    if (val <= 5) return "🧻"; 
    if (val <= 10) return "⛺"; 
    if (val <= 15) return "🏠"; 
    if (val <= 20) return "🏢"; 
    if (val <= 25) return "🏰"; 
    return "🚀"; 
}

// 物件カードの画像パスを取得するヘルパー
function getCardImagePath(val) {
    const num = String(val).padStart(2, '0'); // 1 → "01", 30 → "30"
    return `./image/Four Sale ${num}.png`;
}
// 物件カードの装飾フレーム画像パス（全カード共通の1枚）
function getCardFramePath() {
    return `./image/Four Sale 柄.png`;
}

export function hostStartGame() {
    if (!isHost) return;
    const success = game.initRound(rawPlayerList);
    if (success) {
        const startBtn = document.getElementById("start-game-btn");
        if (startBtn) startBtn.style.display = "none";
        currentSelectedCoins = 0;
        broadcastState();
        updateUI();
    }
}

// 👑 ホスト専用：ゲームの強制終了（中断）処理
export function hostAbortGame() {
    if (!isHost) return;
    if (!confirm("本当にゲームを強制終了して待機ロビーに戻りますか？\n現在の進行状況はリセットされます。")) return;
    game.isGameStarted = false;
    if (game.players) {
        game.players.forEach(p => {
            p.bid = 0;
            p.hasPassed = false;
        });
    }
    if (typeof game.log === "function") {
        game.log("🛑 ホストによってゲームが強制終了されました。");
    }
    broadcastState();
    updateUI();
}

export function hostNextRound() {
    if (!isHost) return;

    // 💡 前ラウンドの勝者（1位）に勝利数を+1する
    if (game.lastRoundWinnerId) {
        const winnerInList = rawPlayerList.find(p => p.id === game.lastRoundWinnerId);
        if (winnerInList) {
            winnerInList.wins = (winnerInList.wins || 0) + 1;
        }
    }

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

    // 👑 【ここを追加：リアルタイムホストID同期】
    // 権限譲渡などが発生した際、最新のプレイヤーリストから現在ホスト権限を持つ人のIDを割り出し、
    // ロビー内の部屋ID表示（赤文字）に即座に反映します。
    if (rawPlayerList && Array.isArray(rawPlayerList)) {
        const currentHost = rawPlayerList.find(p => p.isHost === true);
        const lobbyDisplay = document.getElementById("lobby-current-room-id");
        if (currentHost && currentHost.id && lobbyDisplay) {
            lobbyDisplay.textContent = currentHost.id;
        }
    }

    // 0. まだ自分のID（ログイン情報）がない場合は初期画面
    if (!window.myId) {
        if (setupContainer) setupContainer.style.display = "block";
        if (lobbyContainer) lobbyContainer.style.display = "none";
        if (gameContainer) gameContainer.style.display = "none";
        return;
    }

    // ログイン済み：セットアップ画面を隠す
    if (setupContainer) setupContainer.style.display = "none";

    // 1. 画面表示の排他制御
    // ゲストの場合：初回同期データが届くまではロビー画面を維持（チラつき防止）
    if (!isHost && !isFirstSyncReceived) {
        if (lobbyContainer) lobbyContainer.style.display = "block";
        if (gameContainer) gameContainer.style.display = "none";
    } else {
        // ホスト、または初回同期済みゲストの場合
        if (game.isGameStarted) {
            if (lobbyContainer) lobbyContainer.style.display = "none";
            if (gameContainer) gameContainer.style.display = "block";
        } else {
            if (lobbyContainer) lobbyContainer.style.display = "block";
            if (gameContainer) gameContainer.style.display = "none";
        }
    }

    // 3. 上部ステータスバー
    const roleDisplayEl = document.getElementById("role-display");
    if (roleDisplayEl) {
        if (!game.isGameStarted) {
            roleDisplayEl.innerText = isHost ? "👑 ホスト（待機中）" : "🟢 ゲスト（接続済み・待機中）";
            roleDisplayEl.style.color = "#2c3e50";
        } else if (game.players) {
            if (game.phase === "SELL") {
                const me = game.players.find(p => p.id === window.myId);
                if (me && !me.hasPassed) {
                    roleDisplayEl.innerText = "物件カードを1枚選んで裏向きに提示してください。";
                    roleDisplayEl.style.color = "#e74c3c";
                } else {
                    const waitingCount = game.players.filter(p => !p.hasPassed).length;
                    roleDisplayEl.innerText = `提示済みです。他 ${waitingCount}人 の提示を待っています...`;
                    roleDisplayEl.style.color = "#2c3e50";
                }
            } else {
                const currentTurnPlayer = game.players[game.turnIndex];
                if (currentTurnPlayer) {
                    if (currentTurnPlayer.id === window.myId) {
                        roleDisplayEl.innerText = "あなたのターンです。行動を選択してください。";
                        roleDisplayEl.style.color = "#e74c3c";
                    } else {
                        roleDisplayEl.innerText = `${currentTurnPlayer.name} の手番を待っています...`;
                        roleDisplayEl.style.color = "#2c3e50";
                    }
                }
            }
        }
    }

    // システムボタンの表示制御
    const startBtn = document.getElementById("start-game-btn");
    if (startBtn) startBtn.style.display = (isHost && !game.isGameStarted) ? "block" : "none";

    const nextRoundBtn = document.getElementById("next-round-btn");
    if (nextRoundBtn) {
        nextRoundBtn.style.display = (isHost && game.isGameStarted && typeof game.isGameEnded === "function" && game.isGameEnded()) ? "block" : "none";
    }

    const abortBtn = document.getElementById("host-abort-btn");
    if (abortBtn) {
        abortBtn.style.display = (isHost && game.isGameStarted) ? "block" : "none";
    }

    // 4. 各エリアの描画（ゲームの状態に応じて出し分け）
    if (!game.isGameStarted) {
        renderLobbyPlayerList();
    } else if (game.players) {
        renderSidePlayerList();
        renderBidStatusBoard();
        renderMarket();
        renderConsoleAndHand();
    }
    
    renderCustomSettingsUI();

    // === ID照合の不整合を突き止めるためのデバッグログ ===
    console.log("=== 【UI同期チェック】自分のIDとプレイヤーリストの照合 ===");
    console.log("1. window.myId の値:", window.myId, "型:", typeof window.myId);

    if (game && game.players) {
        console.log("2. game.players 内の全プレイヤーID一覧:");
        game.players.forEach((p, idx) => {
            const isMatchedStrict = (p.id === window.myId);
            const isMatchedLoose  = (String(p.id) === String(window.myId));
            
            console.log(`   └─ [プレイヤー ${idx}] 名前: ${p.name}`);
            console.log(`      ├─ サーバー側のID:`, p.id, "型:", typeof p.id);
            console.log(`      ├─ 厳密一致 (===):`, isMatchedStrict ? "⭕ 一致！" : "❌ 不一致");
            console.log(`      └─ 型変換一致 (String):`, isMatchedLoose ? "⭕ 一致！" : "❌ 不一致");
        });
    } else {
        console.log("2. ❌ game.players データ自体がまだ存在しません（または空です）");
    }
    console.log("==================================================");

    // 5. データ不整合検知による自動同期要求（ゲスト用）
    if (!isHost && game.isGameStarted && game.players && game.players.length > 0) {
        const myGameData = game.players.find(p => p.id === window.myId);
        if (myGameData && myGameData.coins === undefined) {
            if (connToHost && connToHost.open) {
                // 💡 serialization: 'json' のため、オブジェクトのまま生で送信
                connToHost.send({ 
                    type: "REQUEST_SYNC", 
                    playerId: window.myId, 
                    playerName: myGameData.name 
                });
            }
        }
    }
}

function renderLobbyPlayerList() {
    const listEl = document.getElementById("lobby-player-list");
    if (!listEl) return;
    listEl.innerHTML = "";

    rawPlayerList.forEach(p => {
        const item = document.createElement("div");
        item.className = "lobby-player-item";
        
        const nameGroup = document.createElement("div");
        nameGroup.className = "lobby-player-name-group";
        
        const nameSpan = document.createElement("span");
        nameSpan.className = "lobby-player-name";
        const hostCrown = p.isHost ? "👑 " : "";
        nameSpan.innerText = `${hostCrown}${p.name}`;
        
        const badge = document.createElement("span");
        badge.className = "score-badge";
        badge.innerText = `${p.wins || 0}勝`;
        
        nameGroup.appendChild(nameSpan);
        nameGroup.appendChild(badge);
        item.appendChild(nameGroup);

        if (isHost && p.id !== window.myId) {
            const btnGroup = document.createElement("div");
            btnGroup.className = "host-action-group";
            
            const transBtn = document.createElement("button");
            transBtn.className = "btn-host-transfer lobby-action-btn";
            transBtn.innerText = "権限譲渡";
            transBtn.onclick = () => hostTransferAuthority(p.id);

            const kickBtn = document.createElement("button");
            kickBtn.className = "btn-danger lobby-action-btn";
            kickBtn.innerText = "キック";
            kickBtn.onclick = () => hostKickPlayer(p.id);
            
            btnGroup.appendChild(transBtn);
            btnGroup.appendChild(kickBtn);
            item.appendChild(btnGroup);
        }
        listEl.appendChild(item);
    });
}

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
        
        if (game.phase === "BID") {
            const currentTurnPlayer = game.players[game.turnIndex];
            if (currentTurnPlayer && currentTurnPlayer.id === p.id) {
                card.classList.add("active-turn");
            }
        }

        const hostCrown = p.isHost ? "👑 " : "";
        const nameDiv = document.createElement("div");
        nameDiv.className = "side-player-name";
        nameDiv.innerHTML = `<span>${hostCrown}${p.name}</span> <span class="score-badge">${p.wins || 0}勝</span>`;
        card.appendChild(nameDiv);

        const statsDiv = document.createElement("div");
        statsDiv.className = "side-player-stats";
        if (game.phase === "BID") {
            const passedText = pInGame.hasPassed ? "🏳️ パス済" : "🔨 参戦中";
            statsDiv.innerHTML = `<span>${passedText}</span> <span>🪙 ${pInGame.coins}k$</span>`;
        } else {
            statsDiv.innerHTML = `<span>💵 獲得額: $${pInGame.score || 0},000</span>`;
        }
        card.appendChild(statsDiv);
        sideEl.appendChild(card);
    });
}

function renderBidStatusBoard() {
    const boardEl = document.getElementById("bid-status-board");
    if (!boardEl) return;
    boardEl.innerHTML = "";

    game.players.forEach(p => {
        const box = document.createElement("div");
        box.className = "bid-box";
        
        if (p.id === window.myId) box.classList.add("current-player");
        if (game.phase === "BID" && p.hasPassed) box.classList.add("passed-out");

        const textContainer = document.createElement("div");
        textContainer.style.fontSize = "0.85rem";
        
        if (game.phase === "BID") {
            const statusStr = p.hasPassed ? " <span style='color:#7f8c8d; font-weight:normal;'>(パス)</span>" : "";
            textContainer.innerHTML = `<strong>${p.name}</strong>: <span style='color:#e67e22; font-weight:bold;'>${p.bid || 0}</span> k$${statusStr}`;
        } else {
            const hasPlayed = p.hasPassed ? "<span style='color:#2ecc71; font-weight:bold;'>🟢 提示完了</span>" : "<span style='color:#7f8c8d;'>⏳ 選択中...</span>";
            textContainer.innerHTML = `<strong>${p.name}</strong>: ${hasPlayed}`;
        }
        box.appendChild(textContainer);

        const coinPool = document.createElement("div");
        coinPool.className = "coin-pool";
        box.appendChild(coinPool);

        boardEl.appendChild(box);

        if (game.phase === "BID") {
            const coinCount = p.bid || 0;
            
            for (let i = 0; i < coinCount; i++) {
                const coin = document.createElement("div");
                coin.className = "placed-field-coin";
                coin.innerText = "1k";
                coinPool.appendChild(coin);

                setTimeout(() => {
                    coin.classList.add("fade-in-active");
                }, i * 40);
            }
        }
    });
}

function renderMarket() {
    const listEl = document.getElementById("card-tracker-list");
    const titleEl = document.getElementById("market-title-text");
    if (!listEl) return;
    listEl.innerHTML = "";
    
    const deckContainer = document.getElementById("deck-pile-container");
    if (deckContainer) {
        deckContainer.innerHTML = ""; 
    }
    
    if (game.phase === "BID") {
        if (titleEl) titleEl.innerText = "競売にかけられた物件";
    } else {
        if (titleEl) titleEl.innerText = "オープンされた小切手 (ドル札)";
    }
    
    const displayMarket = game.phase === "SELL" ? [...(game.market || [])].reverse() : (game.market || []);
    
    if (displayMarket.length === 0) {
        const emptyText = document.createElement("p");
        emptyText.style.color = "#7f8c8d";
        emptyText.style.margin = "0";
        emptyText.innerText = "場にオープンされたカードはありません";
        listEl.appendChild(emptyText);
    } else {
        displayMarket.forEach(val => {
            const card = document.createElement("div");
            card.className = "game-card";
            if (game.phase === "BID") {
                card.innerHTML = `
                    <img src="${getCardImagePath(val)}" alt="物件 No.${val}" class="card-image"
                        onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
                    <div class="card-illustration-fallback" style="display:none;">${getCardEmoji(val)}</div>
                    <img src="${getCardFramePath()}" alt="" class="card-frame">
                    <div class="card-num card-num-top-left">${val}</div>
                    <div class="card-num card-num-top-right">${val}</div>
                    <div class="card-num card-num-bottom-left">${val}</div>
                    <div class="card-num card-num-bottom-right">${val}</div>
                `;
            } else {
                card.style.background = "#d4efdf";
                card.style.borderColor = "#27ae60";
                card.innerHTML = `
                    <div class="card-num card-num-top-left" style="color:#27ae60;">$${val}k</div>
                    <div class="card-num card-num-top-right" style="color:#27ae60;">$${val}k</div>
                    <div class="card-illustration">💵</div>
                    <div class="card-num card-num-bottom-left" style="color:#27ae60;">$${val}k</div>
                    <div class="card-num card-num-bottom-right" style="color:#27ae60;">$${val}k</div>
                `;
            }
            listEl.appendChild(card);
        });
    }
    
    const deckCount = (game.isGameStarted && game.deck) ? game.deck.length : 0;
    
    if (deckCount > 0 && deckContainer) {
        const deckCard = document.createElement("div");
        deckCard.className = "deck-card"; 
        
        deckCard.innerHTML = `
            <div style="font-size:0.75rem; opacity:0.8;">🎴</div>
            <div class="card-illustration" style="font-size: 2rem; margin: 5px 0;">🎴</div>
            <div style="font-size: 0.75rem; font-weight: bold;">残り ${deckCount} 枚</div>
            <div style="font-size:0.75rem; opacity:0.8;">x${deckCount}</div>
        `;
        
        deckContainer.appendChild(deckCard);
    }
}

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
        const currentHighest = Math.max(...game.players.map(p => Number(p.bid || 0)), 0);
        const minNeed = currentHighest + 1;
        const myCurrentBid = me.bid || 0;
        const canAffordBid = me.coins >= minNeed; 
        if (consoleInfo) {
            consoleInfo.innerHTML = `あなたの現在の入札値: <strong>${myCurrentBid}</strong> k$ | あなたの手持ちコイン: <strong>${me.coins}</strong> 枚 | 次に必要な最低値: <strong>${minNeed}</strong> k$`;
        }
        const bidBtn = document.getElementById("submit-bid-btn");
        const passBtn = document.getElementById("submit-pass-btn");
        if (bidBtn && passBtn) {
            if (isMyTurn && !me.hasPassed) {
                bidBtn.style.display = canAffordBid ? "inline-block" : "none";
                passBtn.style.display = "inline-block";
                bidBtn.disabled = !canAffordBid;
                passBtn.disabled = false;
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
                passBtn.onclick = () => { executePlayCard(-1, {}); };
            } else {
                bidBtn.style.display = "none";
                passBtn.style.display = "none";
                bidBtn.disabled = true;
                passBtn.disabled = true;
            }
        }
        if (me.hasPassed) {
            cardArea.innerHTML = "<p style='color:#7f8c8d;'>このラウンドはパスアウトしました。全員の競り終了を待っています...</p>";
            return;
        }
        if (isMyTurn && canAffordBid && currentSelectedCoins < minNeed) {
            currentSelectedCoins = minNeed;
        }
        const coinContainer = document.createElement("div");
        coinContainer.className = "coin-buttons";
        for (let i = 1; i <= me.coins; i++) {
            const coinBtn = document.createElement("div");
            coinBtn.className = "coin-btn";
            if (canAffordBid && i === currentSelectedCoins) {
                coinBtn.classList.add("active");
            } else if (canAffordBid && i < currentSelectedCoins) {
                coinBtn.classList.add("active-faded");
            }
            coinBtn.innerHTML = `<span>${i}</span><span style="font-size:0.5rem;opacity:0.7;">k$</span>`;
            if (isMyTurn && canAffordBid && i >= minNeed) {
                coinBtn.onclick = () => { currentSelectedCoins = i; renderConsoleAndHand(); };
            } else {
                coinBtn.classList.add("coin-disabled");
            }
            coinContainer.appendChild(coinBtn);
        }
        cardArea.appendChild(coinContainer);
    } else {
        if (consoleInfo) consoleInfo.innerHTML = "提示する物件カード（手札）を1枚選んで場に出してください。";
        
        const bidBtn = document.getElementById("submit-bid-btn");
        const passBtn = document.getElementById("submit-pass-btn");
        if (bidBtn && passBtn) {
            bidBtn.style.display = "none";
            passBtn.style.display = "none";
            bidBtn.disabled = true;
            passBtn.disabled = true;
        }

        if (me.hasPassed) {
            cardArea.innerHTML = "<p style='color:#2ecc71;'>物件を提示しました。全員のオープンを待っています...</p>";
            return;
        }

        if (me.hand) {
            me.hand.forEach((val) => {
                const card = document.createElement("div");
                card.className = "card";
                card.innerHTML = `
                    <img src="${getCardImagePath(val)}" alt="物件 No.${val}" class="card-image"
                        onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
                    <div class="card-illustration-fallback" style="display:none;">${getCardEmoji(val)}</div>
                    <img src="${getCardFramePath()}" alt="" class="card-frame">
                    <div class="card-num card-num-top-left">${val}</div>
                    <div class="card-num card-num-top-right">${val}</div>
                    <div class="card-num card-num-bottom-left">${val}</div>
                    <div class="card-num card-num-bottom-right">${val}</div>
                `;
                if (!me.hasPassed) {                // ← 自分がまだ提示していなければ常にクリック可能
                    card.onclick = () => { if (confirm(`物件 No.${val} を提示しますか？`)) executePlayCard(val, {}); };
                    card.style.cursor = "pointer";
                } else {
                    card.style.cursor = "not-allowed";
                    card.style.opacity = "0.5";
                }
                cardArea.appendChild(card);
            });
        }
    }
}

function executePlayCard(actionValue, target) {
    if (isHost) {
        game.playCard(window.myId, actionValue, target);
        currentSelectedCoins = 0; 
        broadcastState();
        updateUI();
    } else if (connToHost && connToHost.open) {
        connToHost.send({
            type: "ACTION",
            playerId: window.myId,
            actionValue: actionValue,
            target: target
        });
        currentSelectedCoins = 0;
    }
}

export function renderCustomSettingsUI() {
    const div = document.getElementById("integrated-custom-settings");
    if (!div) return;

    if (!div.hasAttribute("data-built")) {
        const titleText = isHost ? "⚙️ ルームカスタム設定 (ホスト権限)" : "📋 現在のルームカスタム設定 (閲覧のみ)";
        const disabledAttr = isHost ? "" : "disabled";

        div.innerHTML = `
            <h3 style="margin-top:0;">${titleText}</h3>
            <div style="background: rgba(0,0,0,0.03); padding: 10px; border-radius: 6px; margin-top: 5px; border: 1px solid #dcd1be;">
                <div class="setting-item" style="display:flex; justify-content:space-between; margin-bottom:8px;">
                    <span>初期配布コイン枚数 (🪙):</span>
                    <input type="number" id="cfg-initial-coins" min="5" max="30" ${disabledAttr} style="width:60px; padding:4px;">
                </div>
                <div class="setting-item" style="display:flex; justify-content:space-between;">
                    <span>1フェーズあたりのターン数:</span>
                    <input type="number" id="cfg-custom-turns" min="2" max="15" ${disabledAttr} style="width:60px; padding:4px;">
                </div>
            </div>
        `;
        div.setAttribute("data-built", "true");

        if (isHost) {
            document.getElementById("cfg-initial-coins")?.addEventListener("input", (e) => {
                game.initialCoins = Math.max(5, parseInt(e.target.value) || 18);
                broadcastState();
            });
            document.getElementById("cfg-custom-turns")?.addEventListener("input", (e) => {
                game.customTurns = Math.max(2, parseInt(e.target.value) || 5);
                broadcastState();
            });
        }
    }

    const coinInput = document.getElementById("cfg-initial-coins");
    const turnInput = document.getElementById("cfg-custom-turns");
    
    if (coinInput && document.activeElement !== coinInput) {
        coinInput.value = game.initialCoins || 18;
    }
    if (turnInput && document.activeElement !== turnInput) {
        turnInput.value = game.customTurns || 5;
    }

    if (!isHost) {
        div.style.opacity = "0.6";
        div.style.pointerEvents = "none";
        if (coinInput) coinInput.disabled = true;
        if (turnInput) turnInput.disabled = true;
    } else {
        div.style.opacity = "1.0";
        div.style.pointerEvents = "auto";
        if (coinInput) coinInput.disabled = false;
        if (turnInput) turnInput.disabled = false;
    }
}

// 互換性維持用の空関数
export function syncGuestSettingsUI(cardSettings, drawSettings) {}
export function injectCustomSettingsUIIntoGame() {}
export function injectAbortButton() {}