// ui-manager.js
import { game } from "./game-logic.js";
// 💡 不整合解決: connToHost を network-manager から直接インポート
import { isHost, rawPlayerList, broadcastState, hostKickPlayer, hostTransferAuthority, hostRemoveDisconnectedPlayer, connToHost } from "./network-manager.js";

// ホスト用：ゲーム開始
export function hostStartGame() {
    if (!isHost) return;
    const success = game.initRound(rawPlayerList);
    if (success) {
        document.getElementById("start-game-btn").style.display = "none";
        broadcastState();
        updateUI();
    }
}

// ホスト用：次のラウンドへ
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
        broadcastState();
        updateUI();
    }
}

// 画面全体の再描画（ゲスト側にもこの更新が走り同期されます）
export function updateUI() {
    const setupContainer = document.getElementById("setup-container");
    const lobbyContainer = document.getElementById("lobby-container");
    const gameContainer = document.getElementById("game-container");

    // 1. 画面コンテナの表示・非表示の排他制御
    if (window.myId) { 
        // 部屋に参加している場合
        setupContainer.style.display = "none";
        if (game.isGameStarted) {
            // ゲーム中
            lobbyContainer.style.display = "none";
            gameContainer.style.display = "block";
        } else {
            // ロビー待機中
            lobbyContainer.style.display = "block";
            gameContainer.style.display = "none";
        }
    } else {
        // 部屋に入る前
        setupContainer.style.display = "block";
        lobbyContainer.style.display = "none";
        gameContainer.style.display = "none";
    }

    // 2. 各種テキストやボタンの更新
    const deckCountEl = document.getElementById("deck-count");
    if (deckCountEl) {
        deckCountEl.innerText = game.isGameStarted ? `山札: ${game.deck.length}枚 (${game.phase === "BID" ? "物件" : "小切手"})` : "山札: --枚";
    }

    const roleDisplayEl = document.getElementById("role-display");
    if (roleDisplayEl) {
        if (!game.isGameStarted) {
            roleDisplayEl.innerText = isHost ? "👑 ホスト（待機中）" : "🟢 ゲスト（待機中）";
        } else {
            const currentTurnPlayer = game.players[game.turnIndex];
            if (currentTurnPlayer) {
                const phaseText = game.phase === "BID" ? "物件の競り" : "小切手売却";
                roleDisplayEl.innerText = `【${phaseText}】手番: ${currentTurnPlayer.name}`;
            }
        }
    }

    // ホスト用のゲーム開始ボタンの表示制御（ロビー側）
    const startBtn = document.getElementById("start-game-btn");
    if (startBtn) {
        startBtn.style.display = (isHost && !game.isGameStarted) ? "block" : "none";
    }

    const abortBtn = document.getElementById("abort-game-btn");
    if (abortBtn) {
        abortBtn.style.display = (isHost && game.isGameStarted) ? "block" : "none";
    }

    const nextRoundBtn = document.getElementById("next-round-btn");
    if (nextRoundBtn) {
        nextRoundBtn.style.display = (isHost && game.isGameStarted && typeof game.isGameEnded === "function" && game.isGameEnded()) ? "block" : "none";
    }

    renderPlayerList();
    renderMyHand();
    renderTracker();
    renderCustomSettingsUI();

    // 💡 ゲスト環境でのみ動作する、データの自動不整合（undefined）検知＆再送要求ロジック
    if (!isHost && game.isGameStarted && game.players && game.players.length > 0) {
        const myGameData = game.players.find(p => p.id === window.myId);
        if (myGameData && myGameData.coins === undefined) {
            console.warn("⚠️ 描画データに不整合（undefined）を検知。ホストに最新状態の再送を要求します...");
            if (connToHost && connToHost.open) {
                connToHost.send(JSON.stringify({
                    type: "REQUEST_SYNC",
                    playerId: window.myId,
                    playerName: myGameData.name
                }));
            }
        }
    }
}

// プレイヤーリストのレンダリング
function renderPlayerList() {
    // ゲーム中かロビー中かで描画先のコンテナを切り替える
    const targetId = game.isGameStarted ? "player-list" : "lobby-player-list";
    const listEl = document.getElementById(targetId);
    if (!listEl) return;
    listEl.innerHTML = "";

    // もう一方のリストはクリアしておく
    const otherId = game.isGameStarted ? "lobby-player-list" : "player-list";
    const otherEl = document.getElementById(otherId);
    if (otherEl) otherEl.innerHTML = "";

    rawPlayerList.forEach(p => {
        const item = document.createElement("div");
        item.className = "player-item";
        
        if (p.disconnected) {
            item.classList.add("eliminated");
        }

        const pInGame = game.isGameStarted ? game.players.find(gp => gp.id === p.id) : null;

        if (game.isGameStarted && pInGame) {
            const currentTurnPlayer = game.players[game.turnIndex];
            if (currentTurnPlayer && currentTurnPlayer.id === p.id) {
                item.classList.add("active");
            }
        }

        const header = document.createElement("div");
        header.className = "player-header";

        const nameSpan = document.createElement("span");
        nameSpan.style.fontWeight = "bold";
        
        const statusText = p.disconnected ? " <span style='color:#e74c3c;'>[接続切れ]</span>" : "";
        const hostCrown = p.isHost ? "👑 " : "";
        
        let gameStatusInfo = "";
        if (game.isGameStarted && pInGame) {
            if (game.phase === "BID") {
                gameStatusInfo = ` | 🪙${pInGame.coins}枚 (入札: ${pInGame.bid}枚)${pInGame.hasPassed ? " 🏳️パス済" : ""}`;
            } else {
                gameStatusInfo = ` | 💵獲得総額: $${pInGame.score || 0},000`;
            }
        }

        nameSpan.innerHTML = `${hostCrown}${p.name}${statusText} <span class="score-badge">${p.score || 0}勝</span>${gameStatusInfo}`;
        header.appendChild(nameSpan);

        // ホスト用のキック・譲渡ボタン
        if (isHost && p.id !== window.myId) {
            const btnGroup = document.createElement("div");
            
            if (p.disconnected) {
                const removeBtn = document.createElement("button");
                removeBtn.className = "btn-danger";
                removeBtn.innerText = "完全に削除";
                removeBtn.style.background = "#95a5a6";
                removeBtn.onclick = () => hostRemoveDisconnectedPlayer(p.id);
                btnGroup.appendChild(removeBtn);
            } else {
                const kickBtn = document.createElement("button");
                kickBtn.className = "btn-danger";
                kickBtn.innerText = "キック";
                kickBtn.onclick = () => hostKickPlayer(p.id);
                
                const transBtn = document.createElement("button");
                transBtn.className = "btn-host-transfer";
                transBtn.innerText = "権限譲渡";
                transBtn.onclick = () => hostTransferAuthority(p.id);

                btnGroup.appendChild(transBtn);
                btnGroup.appendChild(kickBtn);
            }
            header.appendChild(btnGroup);
        }
        header.style.display = "flex";
        header.style.justifyContent = "space-between";
        header.style.alignItems = "center";
        item.appendChild(header);

        if (game.isGameStarted && p.id !== window.myId && pInGame) {
            const handContainer = document.createElement("div");
            handContainer.className = "enemy-hand-container";
            handContainer.style.marginTop = "5px";
            handContainer.style.display = "flex";
            handContainer.style.gap = "5px";

            if (game.phase === "BID") {
                pInGame.hand.forEach((_, index) => {
                    const cardBack = document.createElement("div");
                    cardBack.className = "card-back-red";
                    cardBack.style.width = "45px";
                    cardBack.style.height = "30px";
                    cardBack.style.fontSize = "0.65rem";
                    cardBack.style.display = "flex";
                    cardBack.style.justifyContent = "center";
                    cardBack.style.alignItems = "center";
                    cardBack.style.borderRadius = "4px";
                    cardBack.style.border = "1px solid #fff";
                    cardBack.style.background = "linear-gradient(135deg, #e74c3c, #c0392b)";
                    cardBack.innerHTML = `<span style="color:#fff;">🏠物</span>`;
                    handContainer.appendChild(cardBack);
                });
            } else {
                if (pInGame.hasPassed && pInGame.bid > 0) {
                    const cardHidden = document.createElement("div");
                    cardHidden.style.background = "#2c3e50";
                    cardHidden.style.color = "#fff";
                    cardHidden.style.padding = "2px 6px";
                    cardHidden.style.borderRadius = "4px";
                    cardHidden.style.fontSize = "0.75rem";
                    cardHidden.innerText = "🏠 物件提示済 (裏向き)";
                    handContainer.appendChild(cardHidden);
                }
            }
            item.appendChild(handContainer);
        }

        if (game.isGameStarted && pInGame && pInGame.history && pInGame.history.length > 0) {
            const historyEl = document.createElement("div");
            historyEl.className = "played-history";
            historyEl.style.marginTop = "5px";
            pInGame.history.forEach(val => {
                const badge = document.createElement("span");
                badge.style.background = "#34495e";
                badge.style.color = "#fff";
                badge.style.padding = "2px 6px";
                badge.style.marginRight = "4px";
                badge.style.borderRadius = "3px";
                badge.style.fontSize = "0.75rem";
                badge.innerText = `No.${val}`;
                historyEl.appendChild(badge);
            });
            item.appendChild(historyEl);
        }

        listEl.appendChild(item);
    });
}

// 自分の手札エリアの描画
export function renderMyHand() {
    const cardArea = document.getElementById("card-area");
    const handTitle = document.getElementById("hand-title");
    if (!cardArea) return;
    cardArea.innerHTML = "";

    if (!game.isGameStarted) {
        if (handTitle) handTitle.style.display = "none";
        return;
    }

    const me = game.players.find(p => p.id === window.myId);
    if (!me) return;

    if (handTitle) {
        handTitle.style.display = "block";
        handTitle.innerText = game.phase === "BID" ? `あなたの所持金: 🪙 ${me.coins}枚` : "あなたの手札（所持物件）";
    }

    const currentTurnPlayer = game.players[game.turnIndex];
    const isMyTurn = currentTurnPlayer && currentTurnPlayer.id === window.myId;

    if (game.phase === "BID") {
        if (!isMyTurn || me.hasPassed) {
            cardArea.innerHTML = `<p style="color:#7f8c8d;">他のプレイヤーの入札を待っています...</p>`;
            return;
        }

        const currentHighest = game.players && game.players.length > 0 
            ? Math.max(...game.players.map(p => Number(p.bid || 0))) 
            : 0;

        const minBid = currentHighest + 1;
        
        const bidContainer = document.createElement("div");
        bidContainer.style.display = "flex";
        bidContainer.style.gap = "10px";
        bidContainer.style.alignItems = "center";
        
        bidContainer.innerHTML = `
            <label>入札額 (現在最高: <span style="font-weight:bold; color:#e67e22;">${currentHighest}</span>):</label>
            <input type="number" id="my-bid-input" value="${minBid}" min="${minBid}" max="${me.coins}" style="width:70px; padding:5px;">
            <button id="submit-bid-btn" class="btn-success" style="padding:6px 12px; background:#2ecc71; color:#fff; border:none; border-radius:4px; cursor:pointer;">入札する</button>
            <button id="submit-pass-btn" class="btn-danger" style="padding:6px 12px; background:#e74c3c; color:#fff; border:none; border-radius:4px; cursor:pointer;">パスする</button>
        `;
        cardArea.appendChild(bidContainer);

        document.getElementById("submit-bid-btn").onclick = () => {
            const amt = parseInt(document.getElementById("my-bid-input").value, 10) || 0;
            executePlayCard(amt, {});
        };

        document.getElementById("submit-pass-btn").onclick = () => {
            executePlayCard(-1, {});
        };

    } else {
        if (me.hasPassed) {
            cardArea.innerHTML = `<p style="color:#2ecc71;">物件を提示しました。全員のオープンを待っています...</p>`;
            return;
        }

        me.hand.forEach((val) => {
            const card = document.createElement("div");
            card.className = `card card-${val}`;
            card.style.border = "2px solid #34495e";
            card.style.padding = "10px";
            card.style.borderRadius = "6px";
            card.style.background = "#ecf0f1";
            card.style.display = "inline-block";
            card.style.margin = "5px";
            card.style.width = "70px";
            card.style.textAlign = "center";
            
            card.innerHTML = `
                <div style="font-size:0.7rem; color:#7f8c8d;">🏢 物件</div>
                <div class="card-num" style="font-size: 1.5rem; font-weight: bold; margin: 5px 0;">No.${val}</div>
            `;

            if (isMyTurn) {
                card.onclick = () => {
                    if(confirm(`物件 No.${val} を場に提示しますか？`)) {
                        executePlayCard(val, {});
                    }
                };
                card.style.cursor = "pointer";
                card.style.opacity = "1.0";
            } else {
                card.style.cursor = "not-allowed";
                card.style.opacity = "0.6";
            }

            cardArea.appendChild(card);
        });
    }
}

// データの送信処理
function executePlayCard(actionValue, target) {
    if (isHost) {
        game.playCard(window.myId, actionValue, target);
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
        }
    }
}

// フォーセールの場（マーケット）状況を表示
function renderTracker() {
    const listEl = document.getElementById("card-tracker-list");
    if (!listEl) return;
    listEl.innerHTML = "";

    if (!game.isGameStarted || !game.market || game.market.length === 0) {
        listEl.innerHTML = "<p style='color:#7f8c8d;'>現在、場にオープンされているカードはありません</p>";
        return;
    }

    const title = document.createElement("h4");
    title.innerText = game.phase === "BID" ? "🏢 現在競りに出されている物件" : "💵 現在オープンされている小切手";
    title.style.margin = "0 0 10px 0";
    listEl.appendChild(title);

    const container = document.createElement("div");
    container.style.display = "flex";
    container.style.justifyContent = "center";
    container.style.gap = "10px";

    game.market.forEach(val => {
        const item = document.createElement("div");
        item.style.padding = "8px 16px";
        item.style.borderRadius = "4px";
        item.style.fontWeight = "bold";
        item.style.fontSize = "1.2rem";

        if (game.phase === "BID") {
            item.style.background = "#e67e22";
            item.style.color = "#fff";
            item.innerText = `No.${val}`;
        } else {
            item.style.background = "#2ecc71";
            item.style.color = "#fff";
            item.innerText = `$${val},000`;
        }
        container.appendChild(item);
    });

    listEl.appendChild(container);
}

// ホスト用の設定UIをロビー向けにレンダリング
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
        <p style="font-size:0.75rem; color:#bdc3c7; margin-top:5px; margin-bottom:0;">※ターン数を増やすと、小切手は自動拡張されます。</p>
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

// 互換性維持用スタブ
export function syncGuestSettingsUI(cardSettings, drawSettings) {}
export function injectCustomSettingsUIIntoGame() {}

// ホスト用：ゲーム強制中断ボタン
export function injectAbortButton() {
    const gameContainer = document.getElementById("game-container");
    if (!gameContainer || document.getElementById("abort-game-btn")) return;

    const btn = document.createElement("button");
    btn.id = "abort-game-btn";
    btn.innerText = "🛑 ゲームを強制中断して待機室に戻る";
    btn.style.background = "#e74c3c";
    btn.style.marginTop = "10px";
    btn.style.display = isHost ? "block" : "none";
    
    btn.onclick = () => {
        if (!isHost) return;
        game.isGameStarted = false;
        game.log("🛑 ホストによってゲームが強制中断されました。");
        broadcastState();
        updateUI();
    };

    const tracker = document.getElementById("card-tracker-container");
    gameContainer.insertBefore(btn, tracker);
}