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
    const deckCountEl = document.getElementById("deck-count");
    if (deckCountEl) {
        deckCountEl.innerText = game.isGameStarted ? `山札: ${game.deck.length}枚` : "山札: --枚";
    }

    const roleDisplayEl = document.getElementById("role-display");
    if (roleDisplayEl) {
        if (!game.isGameStarted) {
            roleDisplayEl.innerText = isHost ? "👑 ホスト（待機中）" : "🟢 ゲスト（待機中）";
        } else {
            const currentTurnPlayer = game.players[game.turnIndex];
            if (currentTurnPlayer) {
                roleDisplayEl.innerText = `Turn: ${currentTurnPlayer.name}`;
            }
        }
    }

    const startBtn = document.getElementById("start-game-btn");
    if (startBtn) {
        startBtn.style.display = (isHost && !game.isGameStarted) ? "block" : "none";
    }

    const abortBtn = document.getElementById("abort-game-btn");
    if (abortBtn) {
        abortBtn.style.display = (isHost && game.isGameStarted) ? "block" : "none";
    }

    // 💡 不整合解決: ホスト移行時に「次のラウンドへ」ボタンの表示権限も正常に引き継ぐ
    const nextRoundBtn = document.getElementById("next-round-btn");
    if (nextRoundBtn) {
        nextRoundBtn.style.display = (isHost && game.isGameStarted && game.isGameEnded && game.isGameEnded()) ? "block" : "none";
    }

    renderPlayerList();
    renderMyHand();
    renderTracker();
    renderCustomSettingsUI();
}

// プレイヤーリストのレンダリング
function renderPlayerList() {
    const listEl = document.getElementById("player-list");
    if (!listEl) return;
    listEl.innerHTML = "";

    rawPlayerList.forEach(p => {
        const item = document.createElement("div");
        item.className = "player-item";
        
        if (p.disconnected) {
            item.classList.add("eliminated");
        }

        if (game.isGameStarted) {
            const pInGame = game.players.find(gp => gp.id === p.id);
            if (pInGame && !pInGame.alive) item.classList.add("eliminated");
            const currentTurnPlayer = game.players[game.turnIndex];
            if (currentTurnPlayer && currentTurnPlayer.id === p.id && (!pInGame || pInGame.alive)) {
                item.classList.add("active");
            }
        }

        const header = document.createElement("div");
        header.className = "player-header";

        const nameSpan = document.createElement("span");
        nameSpan.style.fontWeight = "bold";
        
        const statusText = p.disconnected ? " <span style='color:#e74c3c;'>[接続切れ]</span>" : "";
        const hostCrown = p.isHost ? "👑 " : "";
        const isProtected = game.isGameStarted && game.players.find(gp => gp.id === p.id)?.protected ? "🛡️" : "";

        // コイン枚数の表示対応（game.playersから現在の所持コインを取得、初期値またはゲーム中の値）
        const pInGame = game.isGameStarted ? game.players.find(gp => gp.id === p.id) : null;
        const coinCount = pInGame ? (pInGame.coins ?? game.initialCoins ?? 18) : (game.initialCoins ?? 18);

        nameSpan.innerHTML = `${hostCrown}${p.name}${statusText} <span class="score-badge">${p.score || 0}勝</span> 🪙${coinCount}枚 ${isProtected}`;
        header.appendChild(nameSpan);

        // 操作対象が「自分自身以外」の時だけキック・譲渡ボタンを表示するガード
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

        // 相手の手札描画
        if (game.isGameStarted && !p.spectator && p.id !== window.myId) {
            const pInGame = game.players.find(gp => gp.id === p.id);
            if (pInGame && pInGame.alive) {
                const handContainer = document.createElement("div");
                handContainer.className = "enemy-hand-container";
                handContainer.style.marginTop = "5px";
                handContainer.style.display = "flex";
                handContainer.style.gap = "5px";

                pInGame.hand.forEach((cardVal, index) => {
                    const cardBack = document.createElement("div");
                    cardBack.className = "card-back-red";
                    const isInitialHand = index < (game.drawSettings?.firstTurnCount ?? 1);
                    
                    cardBack.style.width = "55px";
                    cardBack.style.height = "40px";
                    cardBack.style.fontSize = "0.65rem";
                    cardBack.style.display = "flex";
                    cardBack.style.flexDirection = "column";
                    cardBack.style.justifyContent = "center";
                    cardBack.style.alignItems = "center";
                    cardBack.style.borderRadius = "4px";
                    cardBack.style.border = "1.5px solid #fff";

                    if (isInitialHand) {
                        cardBack.style.background = "linear-gradient(135deg, #2980b9, #2c3e50)";
                        cardBack.innerHTML = `<span style="color:#f1c40f;">★初手</span><span>[${index + 1}枚目]</span>`;
                    } else {
                        cardBack.style.background = "linear-gradient(135deg, #e74c3c, #c0392b)";
                        cardBack.innerHTML = `<span style="color:#fff;">📥ドロー</span><span>[${index + 1}枚目]</span>`;
                    }
                    handContainer.appendChild(cardBack);
                });
                item.appendChild(handContainer);
            }
        }

        // 捨て札履歴
        const pInGame = game.players.find(gp => gp.id === p.id);
        if (pInGame && pInGame.history && pInGame.history.length > 0) {
            const historyEl = document.createElement("div");
            historyEl.className = "played-history";
            pInGame.history.forEach(val => {
                const info = game.cardSettings?.[val] || game.defaultCardSettings?.[val] || { name: `カード${val}`, desc: "カスタム効果カード" };
                const badge = document.createElement("div");
                badge.className = `history-card card-${val}`;
                badge.title = `【${val}: ${info.name}】\n${info.desc}`;
                badge.style.cursor = "help"; 

                badge.innerHTML = `
                    <div>${val}</div>
                    <div class="h-name">${info.name}</div>
                `;
                historyEl.appendChild(badge);
            });
            item.appendChild(historyEl);
        }

        listEl.appendChild(item);
    });
}

// 💡 不整合解決: 外部連携用の export キーワードを復元
// 自分の手札をレンダリング（ゲームスタート時に即座に手札を描画させ同期ズレを完全に防ぐ）
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
    if (!me || !me.alive || me.spectator) {
        if (handTitle) {
            handTitle.style.display = "block";
            handTitle.innerText = "あなたは観戦中、または脱落しています";
        }
        return;
    }

    if (handTitle) {
        handTitle.style.display = "block";
        handTitle.innerText = "あなたの手札";
    }

    const currentTurnPlayer = game.players[game.turnIndex];
    const isMyTurn = currentTurnPlayer && currentTurnPlayer.id === window.myId;

    me.hand.forEach((val, index) => {
        const info = game.cardSettings?.[val] || game.defaultCardSettings?.[val] || { name: `カード${val}`, desc: "カスタム効果カード" };
        const card = document.createElement("div");
        card.className = `card card-${val}`;
        card.title = info.desc;
        
        const isInitialHand = index < (game.drawSettings?.firstTurnCount ?? 1);
        const originText = isInitialHand ? "★初手" : "📥ドロー";

        card.innerHTML = `
            <div style="font-size:0.65rem; background:rgba(0,0,0,0.4); padding:2px 6px; border-radius:10px; color:#fff; display:inline-block;">${originText}</div>
            <div class="card-num" style="font-size: 1.8rem; font-weight: bold; text-align: center; margin: 5px 0;">${val}</div>
            <div class="card-name" style="text-align: center; font-weight: bold;">${info.name}</div>
        `;

        if (isMyTurn) {
            card.onclick = () => selectPlayTarget(val);
            card.style.cursor = "pointer";
            card.style.opacity = "1.0";
        } else {
            card.style.cursor = "not-allowed";
            card.style.opacity = "0.6";
        }

        cardArea.appendChild(card);
    });
}

// ターゲット選択モーダル
function selectPlayTarget(cardValue) {
    if ([4, 7, 8].includes(cardValue)) {
        executePlayCard(cardValue, {});
        return;
    }

    const modal = document.getElementById("target-modal");
    const container = document.getElementById("target-buttons");
    if (!modal || !container) return;

    const currentInfo = game.cardSettings?.[cardValue] || { name: "カード" };
    container.innerHTML = `<h4>「${currentInfo.name}」の対象プレイヤーを選択</h4>`;
    const targets = game.players.filter(p => p.alive && !p.spectator && p.id !== window.myId);

    if (targets.length === 0) {
        const btn = document.createElement("button");
        btn.innerText = "対象なし（不発プレイ）";
        btn.onclick = () => {
            modal.style.display = "none";
            executePlayCard(cardValue, {});
        };
        container.appendChild(btn);
    } else {
        targets.forEach(t => {
            const btn = document.createElement("button");
            btn.innerText = `${t.name} ${t.protected ? "(🛡️保護中)" : ""}`;
            btn.onclick = () => {
                // 複数枚所持ルールに対応。相手の手札が2枚以上あれば、どの位置のカードを狙うか選択させる
                if (t.hand && t.hand.length > 1) {
                    selectTargetCardSlot(cardValue, t.id, t.hand.length);
                } else {
                    // 手札が1枚だけならスロット0番を自動指定
                    if (cardValue === 1) {
                        selectGuessValue(cardValue, t.id, 0);
                    } else {
                        modal.style.display = "none";
                        executePlayCard(cardValue, { targetPlayerId: t.id, targetCardIndex: 0 });
                    }
                }
            };
            container.appendChild(btn);
        });
    }

    const cancelBtn = document.createElement("button");
    cancelBtn.innerText = "キャンセル";
    cancelBtn.style.background = "#7f8c8d";
    cancelBtn.onclick = () => { modal.style.display = "none"; };
    container.appendChild(cancelBtn);

    modal.style.display = "flex";
}

// 相手が複数枚持っている場合に「何枚目のカードを対象にするか」を選ばせるUI
function selectTargetCardSlot(cardValue, targetPlayerId, handSize) {
    const container = document.getElementById("target-buttons");
    if (!container) return;
    container.innerHTML = `<h4>対象の手札を1枚選択してください</h4><p style="font-size:0.8rem; color:#bdc3c7;">相手は手札を ${handSize} 枚持っています</p>`;

    for (let i = 0; i < handSize; i++) {
        const btn = document.createElement("button");
        btn.innerText = `${i + 1}枚目の手札を対象にする`;
        btn.onclick = () => {
            if (cardValue === 1) {
                selectGuessValue(cardValue, targetPlayerId, i);
            } else {
                document.getElementById("target-modal").style.display = "none";
                executePlayCard(cardValue, { targetPlayerId: targetPlayerId, targetCardIndex: i });
            }
        };
        container.appendChild(btn);
    }
}

// 兵士用：数字選択（選択した手札インデックスを引き継ぐ）
function selectGuessValue(cardValue, targetPlayerId, targetCardIndex) {
    const container = document.getElementById("target-buttons");
    if (!container) return;
    container.innerHTML = `<h4>予想するカード数字を選択</h4>`;

    for (let i = 2; i <= 8; i++) {
        const btn = document.createElement("button");
        const info = game.cardSettings?.[i] || { name: "" };
        btn.innerText = `${i}: ${info.name}`;
        btn.onclick = () => {
            document.getElementById("target-modal").style.display = "none";
            executePlayCard(cardValue, { 
                targetPlayerId: targetPlayerId, 
                guessCardValue: i,
                targetCardIndex: targetCardIndex 
            });
        };
        container.appendChild(btn);
    }
}

// 見た人にだけゲーム内UIとしてカード内容を綺麗にポップアップ表示し、ログにも記録する関数
export function showSecretCardModal(targetName, cardValue) {
    const modal = document.getElementById("target-modal");
    const container = document.getElementById("target-buttons");
    if (!modal || !container) return;

    const info = game.cardSettings?.[cardValue] || game.defaultCardSettings?.[cardValue] || { name: "未知のカード", desc: "" };
    
    container.innerHTML = `
        <h3 style="color:#f1c40f; margin-bottom:15px;">🔍 カードののぞき見に成功！</h3>
        <p style="font-size:0.9rem;">${targetName} の手札を確認しました：</p>
        <div class="card card-${cardValue}" style="margin: 15px auto; pointer-events:none; float:none; display:block;">
            <div class="card-num" style="font-size:2rem; font-weight:bold; text-align:center;">${cardValue}</div>
            <div class="card-name" style="text-align:center; font-weight:bold;">${info.name}</div>
        </div>
        <p style="font-size:0.8rem; background:rgba(0,0,0,0.3); padding:8px; border-radius:4px; max-width:280px; text-align:left; margin:10px auto;">
            <strong>効果:</strong> ${info.desc}
        </p>
    `;

    const closeBtn = document.createElement("button");
    closeBtn.innerText = "確認しました（閉じる）";
    closeBtn.style.marginTop = "10px";
    closeBtn.onclick = () => { modal.style.display = "none"; };
    container.appendChild(closeBtn);

    modal.style.display = "flex";

    // 見た人本人だけのログボックスにシステムログとして情報を追記して残す
    game.log(`👁️ [あなた限定ログ] ${targetName} の手札は「${cardValue}: ${info.name}」でした。`);
}
window.showSecretCardModal = showSecretCardModal;

function executePlayCard(cardValue, target) {
    if (isHost) {
        game.playCard(window.myId, cardValue, target);
        broadcastState();
        updateUI();
    } else {
        // 💡 不整合解決: window.connToHost ではなく、インポートしたモジュールローカルの connToHost を参照
        if (connToHost && connToHost.open) {
            connToHost.send(JSON.stringify({
                type: "ACTION",
                playerId: window.myId,
                cardValue: cardValue,
                target: target
            }));
        }
    }
}

// トラッカーレンダリング
function renderTracker() {
    const listEl = document.getElementById("card-tracker-list");
    if (!listEl) return;
    listEl.innerHTML = "";

    listEl.style.display = "block";
    listEl.style.textAlign = "center";
    listEl.style.width = "100%";
    listEl.style.padding = "10px 0";
    listEl.style.boxSizing = "border-box";

    const baseCounts = {};
    for (const [val, config] of Object.entries(game.cardSettings || {})) {
        baseCounts[val] = config.count;
    }

    const usedCounts = { 1:0, 2:0, 3:0, 4:0, 5:0, 6:0, 7:0, 8:0 };
    if (game.isGameStarted) {
        game.players.forEach(p => {
            if (p.history) {
                p.history.forEach(c => { if (usedCounts[c] !== undefined) usedCounts[c]++; });
            }
        });
    }

    const circledNumbers = { 1:"①", 2:"②", 3:"③", 4:"④", 5:"⑤", 6:"⑥", 7:"⑦", 8:"⑧" };

    for (let i = 1; i <= 8; i++) {
        const total = baseCounts[i] !== undefined ? baseCounts[i] : 0;
        const used = usedCounts[i] || 0;
        const remain = Math.max(0, total - used);
        
        const info = game.cardSettings?.[i] || game.defaultCardSettings?.[i] || { name: "カスタムカード", desc: "カード効果の説明" };

        for (let k = 0; k < total; k++) {
            const badge = document.createElement("div");
            const isUsed = k >= remain;

            badge.className = `tracker-item tracker-${i}`;
            
            badge.style.display = "inline-flex";
            badge.style.justifyContent = "center";
            badge.style.alignItems = "center";
            badge.style.width = "34px";
            badge.style.height = "34px";
            badge.style.margin = "4px";
            badge.style.borderRadius = "50%";
            badge.style.fontSize = "1.3rem";
            badge.style.fontWeight = "bold";
            badge.style.cursor = "help";
            badge.style.overflow = "hidden";
            badge.style.whiteSpace = "nowrap";
            
            badge.innerText = circledNumbers[i];
            
            badge.title = `【${i}: ${info.name}】\n${info.desc}`;

            if (isUsed) {
                badge.style.background = "#2c3e50";
                badge.style.color = "#7f8c8d";
                badge.style.opacity = "0.25";
                badge.style.border = "1px dashed #7f8c8d";
            } else {
                badge.style.color = "#ffffff";
                const colors = { 1:"#2ecc71", 2:"#3498db", 3:"#9b59b6", 4:"#e67e22", 5:"#1abc9c", 6:"#e67e22", 7:"#95a5a6", 8:"#f1c40f" };
                badge.style.background = colors[i] || "#34495e";
            }

            listEl.appendChild(badge);
        }
    }
}

// ⚙️ 統合されたルール・枚数カスタム設定UI
export function renderCustomSettingsUI() {
    const gameContainer = document.getElementById("game-container");
    if (!gameContainer) return;

    const oldHostUI = document.getElementById("host-custom-settings");
    const oldGuestUI = document.getElementById("guest-custom-settings");
    if (oldHostUI) oldHostUI.remove();
    if (oldGuestUI) oldGuestUI.remove();

    let div = document.getElementById("integrated-custom-settings");
    if (!div) {
        div = document.createElement("div");
        div.id = "integrated-custom-settings";
        div.className = "custom-card-settings";
        const logBox = document.getElementById("log-box");
        gameContainer.insertBefore(div, logBox);
    }

    if (!isHost) {
        div.style.opacity = "0.5";
        div.style.pointerEvents = "none";
    } else {
        div.style.opacity = "1.0";
        div.style.pointerEvents = "auto";
    }

    const titleText = isHost ? "⚙️ ルームカスタム設定 (ホスト権限)" : "📋 現在のルームカスタム設定 (閲覧のみ)";
    const disabledAttr = isHost ? "" : "disabled";

    let html = `<h3>${titleText}</h3>`;
    
    // 🪙 コイン設定項目を追加
    const coinVal = game.initialCoins !== undefined ? game.initialCoins : 18;
    html += `
        <div style="background: rgba(0,0,0,0.2); padding: 10px; border-radius: 6px; margin-bottom: 15px; border: 1px solid #3498db;">
            <h4 style="margin: 0 0 8px 0; color: #3498db; font-size:0.9rem;">🪙 トークン設定</h4>
            <div class="setting-item">
                <span>初期コイン枚数:</span>
                <div class="setting-input-wrapper">
                    <input type="number" id="cfg-initial-coins" value="${coinVal}" min="0" max="99" ${disabledAttr}>
                </div>
            </div>
        </div>
    `;

    html += `<h4 style="margin: 5px 0 12px 0; font-size:0.9rem;">🃏 カードデッキ構成枚数</h4>`;

    for (let i = 1; i <= 8; i++) {
        const info = game.cardSettings?.[i] || game.defaultCardSettings?.[i] || { name: `カード${i}` };
        const countVal = game.cardSettings?.[i]?.count !== undefined ? game.cardSettings[i].count : 1;
        html += `
            <div class="setting-item">
                <span class="setting-card-info">${i}番 ${info.name}</span>
                <div class="setting-input-wrapper">
                    <label>枚数:</label>
                    <input type="number" id="cfg-count-${i}" value="${countVal}" min="0" max="10" ${disabledAttr}>
                </div>
            </div>
        `;
    }

    const firstDrawVal = game.drawSettings?.firstTurnCount !== undefined ? game.drawSettings.firstTurnCount : 1;
    const everyDrawVal = game.drawSettings?.everyTurnCount !== undefined ? game.drawSettings.everyTurnCount : 1;

    html += `
        <div style="background: rgba(0,0,0,0.2); padding: 10px; border-radius: 6px; margin-top: 15px; border: 1px solid #f1c40f;">
            <h4 style="margin: 0 0 8px 0; color: #f1c40f; font-size:0.9rem;">📐 配布枚数設定</h4>
            <div class="setting-item">
                <span>最初の手札枚数:</span>
                <div class="setting-input-wrapper">
                    <input type="number" id="cfg-first-draw" value="${firstDrawVal}" min="1" max="5" ${disabledAttr}>
                </div>
            </div>
            <div class="setting-item">
                <span>毎ターンのドロー枚数:</span>
                <div class="setting-input-wrapper">
                    <input type="number" id="cfg-every-draw" value="${everyDrawVal}" min="1" max="3" ${disabledAttr}>
                </div>
            </div>
        </div>
    `;
    
    div.innerHTML = html;

    if (isHost) {
        // コイン枚数変更イベントの監視
        document.getElementById("cfg-initial-coins")?.addEventListener("change", (e) => {
            game.initialCoins = Math.max(0, parseInt(e.target.value) || 0);
            broadcastState();
            updateUI();
        });

        document.getElementById("cfg-first-draw")?.addEventListener("change", (e) => {
            if(!game.drawSettings) game.drawSettings = {};
            game.drawSettings.firstTurnCount = Math.max(1, parseInt(e.target.value) || 1);
            broadcastState();
            updateUI();
        });

        document.getElementById("cfg-every-draw")?.addEventListener("change", (e) => {
            if(!game.drawSettings) game.drawSettings = {};
            game.drawSettings.everyTurnCount = Math.max(1, parseInt(e.target.value) || 1);
            broadcastState();
            updateUI();
        });

        for (let i = 1; i <= 8; i++) {
            document.getElementById(`cfg-count-${i}`)?.addEventListener("change", (e) => {
                if(!game.cardSettings[i]) game.cardSettings[i] = {};
                game.cardSettings[i].count = Math.max(0, parseInt(e.target.value) || 0);
                broadcastState();
                updateUI();
            });
        }
    }
}

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