// network-manager.js
import { game } from "./game-logic.js";
import { updateUI } from "./ui-manager.js";

export let isHost = false;
export let rawPlayerList = []; 
export let guestConnections = []; // ホスト用: 接続されたconnの配列
export let connToHost = null;     // ゲスト用: ホストへのconn

export function setIsHost(val) { 
    isHost = val; 
    window.isHost = val; // グローバル同期
    if (isHost) {
        // 自分自身をrawPlayerList内でホスト扱いにマーク
        const me = rawPlayerList.find(p => p.id === window.myId);
        if (me) me.isHost = true;
    }
}
export function setRawPlayerList(list) { rawPlayerList = list; }
export function setConnections(conn) { 
    if (!guestConnections.some(c => c.peer === conn.peer)) {
        guestConnections.push(conn); 
    }
}
export function setConnToHost(conn) { connToHost = conn; }

// ホストがデータを受信した時の処理
export function handleHostReceiveData(conn, data) {
    if (!isHost) return;

    switch (data.type) {
        case "JOIN":
            // 同一プレイヤー名の接続切れ復帰チェック
            const disconnectedPlayer = rawPlayerList.find(p => p.name === data.name && p.disconnected);
            
            if (disconnectedPlayer) {
                // 既存のアカウントデータを再利用して復帰
                disconnectedPlayer.id = data.id; // 新しいPeerIDを再マッピング
                disconnectedPlayer.disconnected = false;
                game.log(`🔄 ${data.name} の接続が復帰しました。`);

                // もしゲーム中ならゲームロジック側のプレイヤーIDも更新
                if (game.isGameStarted) {
                    const gp = game.players.find(p => p.name === data.name);
                    if (gp) gp.id = data.id;
                }
            } else {
                // 新規プレイヤーの追加
                if (!rawPlayerList.some(p => p.id === data.id)) {
                    const isSpectator = game.isGameStarted;
                    rawPlayerList.push({
                        id: data.id,
                        name: data.name || "ゲスト",
                        spectator: isSpectator,
                        score: 0,
                        isHost: false,
                        disconnected: false
                    });
                    game.log(`👥 ${data.name} が入室しました。`);
                }
            }
            broadcastState();
            updateUI();
            break;

        case "ACTION":
            if (!game.isGameStarted) return;
            const currentPlayer = game.players[game.turnIndex];
            if (currentPlayer && currentPlayer.id === data.playerId) {
                game.playCard(data.playerId, data.cardValue, data.target);
                broadcastState();
                updateUI();
            }
            break;

        case "LEAVE":
            handlePlayerDisconnect(conn.peer);
            break;
    }
}

// ゲストがデータを受信した時の処理 (課題5, 7完全対応)
export function handleGuestReceiveData(data) {
    if (isHost) return;

    if (data.type === "SYNC_STATE") {
        game.isGameStarted = data.gameState.isGameStarted;
        game.deck = data.gameState.deck;
        game.turnIndex = data.gameState.turnIndex;
        game.cardSettings = data.gameState.cardSettings;
        game.drawSettings = data.gameState.drawSettings;

        // サーバ側（ホスト側）から同期されたリストをそのまま受け取る
        rawPlayerList = data.rawPlayerList;

        // ゲーム内プレイヤー状態の復元（他人の手札の中身は隠蔽されたまま配列長さを維持）
        if (data.gameState.players) {
            game.players = data.gameState.players;
        }

        // ログの同期
        if (data.gameState.logMessages) {
            const logBox = document.getElementById("log-box");
            if (logBox) {
                logBox.innerHTML = "";
                data.gameState.logMessages.forEach(msg => {
                    const p = document.createElement("p");
                    p.innerText = msg;
                    logBox.appendChild(p);
                });
                logBox.scrollTop = logBox.scrollHeight;
            }
        }

        // 課題5解決：自分宛ての魔術師の極秘のぞき見データがあれば、ポップアップUIを起動
        if (data.secretView) {
            if (typeof window.showSecretCardModal === "function") {
                window.showSecretCardModal(data.secretView.targetName, data.secretView.cardValue);
            }
        }

        // 自分に👑ホスト権限が移ってきたかをチェック
        const myInfo = rawPlayerList.find(p => p.id === window.myId);
        if (myInfo && myInfo.isHost) {
            isHost = true;
            window.isHost = true;
            game.log("👑 あなたが新しいホストになりました！");
            if (typeof window.activateHostMode === "function") {
                window.isHostMigrated = true; // 切断エラーによるリロードを防止
                window.activateHostMode();   // ゲスト待ち受けを即時開始！
            }
        }

        updateUI();
    }
}

// プレイヤー切断時の共通処理（元の30行を完全復元・強化）
function handlePlayerDisconnect(peerId) {
    const leftPlayer = rawPlayerList.find(p => p.id === peerId);
    if (!leftPlayer) return;

    leftPlayer.disconnected = true;
    game.log(`🚪 ${leftPlayer.name} が退室（接続切れ）しました。`);
    
    guestConnections = guestConnections.filter(c => c.peer !== peerId);

    // ゲーム中のプレイヤーであれば脱落処理を裏で行う
    if (game.isGameStarted) {
        const pInGame = game.players.find(p => p.id === peerId);
        if (pInGame) {
            pInGame.alive = false;
            pInGame.hand = [];
        }
        // 残り生存者が1人以下、または山札切れならラウンド終了
        const alives = game.players.filter(p => p.alive && !p.spectator);
        if (alives.length <= 1 || game.deck.length === 0) {
            game.endRound();
        }
    }

    // ホストが切断された場合、残っている最も入室が早いプレイヤーに権限を移行
    if (leftPlayer.isHost) {
        leftPlayer.isHost = false;
        const nextHost = rawPlayerList.find(p => !p.disconnected);
        if (nextHost) {
            nextHost.isHost = true;
            game.log(`👑 ホストが切断されたため、${nextHost.name} が新しいホストになりました。`);
            if (nextHost.id === window.myId) {
                isHost = true;
                window.isHost = true;
                if (typeof window.activateHostMode === "function") {
                    window.isHostMigrated = true;
                    window.activateHostMode();
                }
            }
        }
    }

    broadcastState();
    updateUI();
}

// ホストから全ゲストへ状態をブロードキャスト（課題5, 6, 7対応版）
export function broadcastState() {
    if (!isHost) return;

    guestConnections.forEach(conn => {
        if (!conn.open) return;

        // 特定のプレイヤー宛てに魔術師データがあるかチェック（課題5対応）
        let secretViewData = null;
        const targetPlayerInGame = game.players.find(p => p.id === conn.peer);
        if (targetPlayerInGame && targetPlayerInGame.pendingSecretView) {
            secretViewData = targetPlayerInGame.pendingSecretView;
            delete targetPlayerInGame.pendingSecretView; // 送信後に消去
        }

        const payload = JSON.stringify({
            type: "SYNC_STATE",
            rawPlayerList: rawPlayerList, 
            gameState: {
                isGameStarted: game.isGameStarted,
                deck: game.deck,
                turnIndex: game.turnIndex,
                cardSettings: game.cardSettings,
                drawSettings: game.drawSettings,
                logMessages: game.logMessages,
                // セキュリティ保護：送信先プレイヤー本人以外の他人の手札の中身は「0」にして送る
                players: game.players.map(p => ({
                    id: p.id,
                    name: p.name,
                    alive: p.alive,
                    protected: p.protected,
                    history: p.history,
                    spectator: p.spectator,
                    score: p.score,
                    hand: (p.id === conn.peer) ? p.hand : p.hand.map(() => 0)
                }))
            },
            secretView: secretViewData // のぞき見データ
        });

        conn.send(payload);
    });
}

// ホスト用：プレイヤーのキック
export function hostKickPlayer(peerId) {
    if (!isHost) return;
    const conn = guestConnections.find(c => c.peer === peerId);
    if (conn) {
        conn.close();
    }
    handlePlayerDisconnect(peerId);
}

// ホスト用：「接続切れ」状態のプレイヤーを表示ごとリストから抹殺する
export function hostRemoveDisconnectedPlayer(peerId) {
    if (!isHost) return;
    const target = rawPlayerList.find(p => p.id === peerId);
    if (target) {
        game.log(`🗑️ ${target.name} のデータがルームから完全に削除されました。`);
    }
    rawPlayerList = rawPlayerList.filter(p => p.id !== peerId);
    
    broadcastState();
    updateUI();
}

// ホスト用：ホスト権限の譲渡
export function hostTransferAuthority(peerId) {
    if (!isHost) return;
    const target = rawPlayerList.find(p => p.id === peerId);
    if (!target || target.disconnected) return;

    const currentHost = rawPlayerList.find(p => p.id === window.myId);
    if (currentHost) currentHost.isHost = false;
    
    target.isHost = true;
    isHost = false; 
    window.isHost = false;
    
    game.log(`👑 ホスト権限が ${target.name} に譲渡されました。`);
    broadcastState();
    updateUI();
}

// 部屋を離脱
export function leaveRoom() {
    if (isHost) {
        const nextHost = rawPlayerList.find(p => p.id !== window.myId && !p.disconnected);
        if (nextHost) {
            nextHost.isHost = true;
            broadcastState(); 
        }
        guestConnections.forEach(conn => {
            if (conn.open) conn.close();
        });
    } else {
        if (connToHost && connToHost.open) {
            connToHost.send(JSON.stringify({ type: "LEAVE" }));
            connToHost.close();
        }
    }
    setTimeout(() => {
        window.location.reload();
    }, 200);
}