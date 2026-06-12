// network-manager.js
import { game } from "./game-logic.js";
import { updateUI } from "./ui-manager.js";

export let isHost = false;
export let rawPlayerList = []; 
export let guestConnections = []; // ホスト用: 接続されたconnの配列
export let connToHost = null;     // ゲスト用: ホストへのconn
export let peer = null;           // PeerJSインスタンス用

// F12デバッグ用：いつでもコンソールから game を確認できるようにグローバル化
window.game = game;

// 💡 共通の接続安定化オプション（GoogleのパブリックSTUNサーバーを指定してタイムアウトを防ぐ）
const peerOptions = {
    config: {
        'iceServers': [
            { url: 'stun:stun.l.google.com:19302' },
            { url: 'stun:stun1.l.google.com:19302' },
            { url: 'stun:stun2.l.google.com:19302' }
        ]
    }
};

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
            
            // 🚀 デバッグログ：受信したパケットのプロパティ名をチェック
            console.log("=== 【通信受信デバッグ】 ===");
            console.log("パケット全体:", data);
            console.log("data.cardValue:", data.cardValue);
            console.log("data.actionValue:", data.actionValue);
            console.log("data.value:", data.value);

            const currentPlayer = game.players[game.turnIndex];
            if (currentPlayer && currentPlayer.id === data.playerId) {
                // 💡 UI（送信側）がどのプロパティ名で送ってきてもいいようにフォールバック（代わりの値）を設定
                const actualValue = data.cardValue !== undefined ? data.cardValue : (data.actionValue !== undefined ? data.actionValue : data.value);
                
                console.log("ロジックに渡す実際の値:", actualValue);

                // 修正：特定した正しい値を第2引数に渡す
                game.playCard(data.playerId, actualValue, data.target);
                
                broadcastState();
                updateUI();
            }
            break;

        case "LEAVE":
            handlePlayerDisconnect(conn.peer);
            break;

        // 💡 追加：ゲスト（プレイヤー）からのデータ再送・同期要求を個別に処理する
        case "REQUEST_SYNC":
            console.log(`🔄 プレイヤー [${data.playerName || data.playerId}] から再送要求を受信しました。最新データを送信します。`);
            sendStateToSingleConnection(conn);
            break;
    }
}

// ゲストがデータを受信した時の処理
export function handleGuestReceiveData(data) {
    if (isHost) return;

    if (data.type === "SYNC_STATE") {
        game.isGameStarted = data.gameState.isGameStarted;
        game.deck = data.gameState.deck;
        game.turnIndex = data.gameState.turnIndex;
        game.highestBid = data.gameState.highestBid || 0;
        game.cardSettings = data.gameState.cardSettings;
        game.drawSettings = data.gameState.drawSettings;

        // サーバ側（ホスト側）から同期されたリストをそのまま受け取る
        rawPlayerList = data.rawPlayerList;

        // ゲーム内プレイヤー状態の復元
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
                    p.innerHTML = msg;
                    logBox.appendChild(p);
                });
                logBox.scrollTop = logBox.scrollHeight;
            }
        }

        // 自分宛ての魔術師の極秘のぞき見データがあれば、ポップアップUIを起動
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

// プレイヤー切断時の共通処理
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

// 特定の1本の接続に対してデータを送る（再送要求応答用ヘルパー）
function sendStateToSingleConnection(conn) {
    if (!conn || !conn.open) return;

    let secretViewData = null;
    const targetPlayerInGame = game.players ? game.players.find(p => p.id === conn.peer) : null;
    if (targetPlayerInGame && targetPlayerInGame.pendingSecretView) {
        secretViewData = targetPlayerInGame.pendingSecretView;
        delete targetPlayerInGame.pendingSecretView;
    }

    const payload = JSON.stringify({
        type: "SYNC_STATE",
        rawPlayerList: rawPlayerList, 
        gameState: {
            isGameStarted: game.isGameStarted,
            deck: game.deck,
            turnIndex: game.turnIndex,
            highestBid: game.highestBid,
            cardSettings: game.cardSettings,
            drawSettings: game.drawSettings,
            logMessages: game.logMessages,
            players: game.players ? game.players.map(p => ({
                id: p.id,
                name: p.name,
                alive: p.alive,
                protected: p.protected,
                history: p.history,
                spectator: p.spectator,
                score: p.score,
                coins: p.coins,
                bid: p.bid,
                hasPassed: p.hasPassed,
                hand: (p.id === conn.peer) ? p.hand : p.hand.map(() => 0)
            })) : []
        },
        secretView: secretViewData
    });
    conn.send(payload);
}

// ホストから全ゲストへ状態をブロードキャスト
export function broadcastState() {
    if (!isHost) return;
    guestConnections.forEach(conn => {
        sendStateToSingleConnection(conn);
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

// HTML側のUI操作ヘルパー（IDの表示やコピペ用入力欄への反映）
function displayMyRoomId(id) {
    const roomIdInput = document.getElementById("room-id-input");     // コピペ用入力欄
    const roomIdDisplay = document.getElementById("room-id-display"); // テキスト表示エリア
    
    if (roomIdInput) roomIdInput.value = id;
    if (roomIdDisplay) roomIdDisplay.innerText = id;
}

/**
 * 👑 ホストとして部屋を作成する
 * @param {string} myName - ホストプレイヤーの名前
 */
export function hostCreateRoom(myName) {
    peer = new Peer(peerOptions);

    peer.on("open", (id) => {
        window.myId = id; // グローバルに自分のIDを保持
        setIsHost(true);
        
        displayMyRoomId(id);

        rawPlayerList = [{
            id: id,
            name: myName || "ホスト",
            spectator: false,
            score: 0,
            isHost: true,
            disconnected: false
        }];

        game.log(`🏠 <b>部屋を作成しました！</b>`);
        game.log(`部屋ID: <b>${id}</b> を一緒に遊ぶ人に共有してください。`);
        updateUI();
    });

    peer.on("connection", (conn) => {
        setConnections(conn);

        conn.on("open", () => {
            // 接続完了時はゲストからの JOIN メッセージを待つ
        });

        conn.on("data", (data) => {
            let parsedData = data;
            if (typeof data === "string") {
                try { parsedData = JSON.parse(data); } catch(e) {}
            }
            handleHostReceiveData(conn, parsedData);
        });

        conn.on("close", () => { handlePlayerDisconnect(conn.peer); });
        conn.on("error", () => { handlePlayerDisconnect(conn.peer); });
    });

    peer.on("error", (err) => {
        console.error("PeerJSエラー (ホスト):", err);
        game.log(`⚠️ ネットワークエラー: ${err.type}`);
    });
}

/**
 * 🟢 ゲストとしてホストの部屋に参加する
 * @param {string} targetRoomId - 接続先（ホスト）の部屋ID
 * @param {string} myName - 自分のプレイヤー名
 */
export function guestJoinRoom(targetRoomId, myName) {
    if (!targetRoomId) {
        alert("参加する部屋IDを入力してください。");
        return;
    }

    peer = new Peer(peerOptions);

    peer.on("open", (id) => {
        window.myId = id;
        setIsHost(false);
        displayMyRoomId(id);

        game.log(`🌐 シグナリングサーバに接続しました。ID: ${id}`);
        game.log(`🏠 部屋 [ ${targetRoomId} ] へ接続を試みています...`);

        const conn = peer.connect(targetRoomId);
        setConnToHost(conn);

        conn.on("open", () => {
            game.log("⚡ ホストとの接続が確立しました。入室リクエストを送ります。");
            
            conn.send(JSON.stringify({
                type: "JOIN",
                id: id,
                name: myName || "ゲスト"
            }));
        });

        conn.on("data", (data) => {
            let parsedData = data;
            if (typeof data === "string") {
                try { parsedData = JSON.parse(data); } catch(e) {}
            }
            handleGuestReceiveData(parsedData);
        });

        conn.on("close", () => {
            game.log("❌ ホストとの接続が切断されました。");
            setTimeout(() => { window.location.reload(); }, 1500);
        });

        conn.on("error", (err) => {
            console.error("接続エラー:", err);
            game.log("⚠️ ホストへの接続中にエラーが発生しました。");
        });
    });

    peer.on("error", (err) => {
        console.error("PeerJSエラー (ゲスト):", err);
        if (err.type === "peer-not-found") {
            alert("指定された部屋IDが見つかりません。入力に間違いがないか確認してください。");
        }
        game.log(`⚠️ ネットワークエラー: ${err.type}`);
    });
}

window.activateHostMode = function() {
    if (!peer) return;
    peer.on("connection", (conn) => {
        setConnections(conn);
        conn.on("data", (data) => {
            let parsedData = data;
            if (typeof data === "string") {
                try { parsedData = JSON.parse(data); } catch(e) {}
            }
            handleHostReceiveData(conn, parsedData);
        });
        conn.on("close", () => { handlePlayerDisconnect(conn.peer); });
        conn.on("error", () => { handlePlayerDisconnect(conn.peer); });
    });
};