// network-manager.js
import { game } from "./game-logic.js";
import { updateUI } from "./ui-manager.js";

export let isHost = false;
export let rawPlayerList = []; 
export let guestConnections = []; // ホスト用: 接続されたconnの配列
export let connToHost = null;     // ゲスト用: ホストへのconn
export let peer = null;           // PeerJSインスタンス用

// 移行中の意図的な切断時にリロードが暴発するのを防ぐフラグ
let isMigrating = false;

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
            // 💡 改善点: PeerIDが変わっていても「名前」が一致していれば同一人物として復帰・紐付けを行う
            const disconnectedPlayer = rawPlayerList.find(p => p.name === data.name);
            
            if (disconnectedPlayer) {
                // 既存のアカウントデータを再利用して復帰（新PeerIDの再マッピング）
                disconnectedPlayer.id = data.id; 
                disconnectedPlayer.disconnected = false;
                game.log(`🔄 ${data.name} が新しいホストに再接続・同期しました。`);

                // ゲーム中ならゲームロジック側のプレイヤーIDも即座に更新
                if (game.isGameStarted && game.players) {
                    const gp = game.players.find(p => p.name === data.name);
                    if (gp) gp.id = data.id;
                }
            } else {
                // 完全な新規プレイヤーの追加
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
            
            console.log("=== 【通信受信デバッグ】 ===");
            const currentPlayer = game.players[game.turnIndex];
            if (currentPlayer && currentPlayer.id === data.playerId) {
                const actualValue = data.cardValue !== undefined ? data.cardValue : (data.actionValue !== undefined ? data.actionValue : data.value);
                console.log("ロジックに渡す実際の値:", actualValue);

                game.playCard(data.playerId, actualValue, data.target);
                
                broadcastState();
                updateUI();
            }
            break;

        case "LEAVE":
            handlePlayerDisconnect(conn.peer);
            break;

        case "REQUEST_SYNC":
            console.log(`🔄 プレイヤー [${data.playerName || data.playerId}] から再送要求を受信しました。最新データを送信します。`);
            sendStateToSingleConnection(conn);
            break;
    }
}

// ゲストがデータを受信した時の処理
export function handleGuestReceiveData(data) {
    if (isHost) return;

    // 💡 追記: ホスト移行命令（HOST_MIGRATION）を受信した場合の処理
    if (data.type === "HOST_MIGRATION") {
        game.log(`🔄 ホストが ${data.newHostName || "新しいホスト"} に移行されます。ネットワークを再構築中...`);
        isMigrating = true; // 意図的な切断フラグを立ててリロードを抑止

        // 1. 古いホストとのP2Pコネクションを破棄
        if (connToHost) {
            connToHost.close();
            connToHost = null;
        }

        // 2. 自分が「新ホスト」に指名されていた場合の処理
        if (window.myId === data.newHostId) {
            setIsHost(true);
            isMigrating = false;

            // 旧ホストから届いた「完全なゲーム状態（チート防止フィルターなし）」を自分のgameオブジェクトにマージして完全復元
            if (data.fullGameState) {
                try {
                    const parsedGame = JSON.parse(data.fullGameState);
                    Object.assign(game, parsedGame);
                } catch (e) {
                    console.error("ゲームデータの復元に失敗しました:", e);
                }
            }
            
            // ルーム名簿を引き継ぎ、自分をホストとしてマーク
            rawPlayerList = data.rawPlayerList;
            const me = rawPlayerList.find(p => p.id === window.myId);
            if (me) {
                me.isHost = true;
                me.disconnected = false;
            }

            // 新ホストとしての「子機からの接続待ち受け（サーバーモード）」を即時起動
            guestConnections = []; 
            window.activateHostMode();
            
            game.log("👑 あなたが新しいホストになりました！他のプレイヤーの再接続を待っています。");
            updateUI();
        } 
        // 3. 自分は「ゲスト（または旧ホスト）」のままの場合の処理
        else {
            // 新ホストがPeerのセッションを立ち上げるのを少し待ってから再接続をかける
            setTimeout(() => {
                const myProfile = rawPlayerList.find(p => p.id === window.myId);
                const myName = myProfile ? myProfile.name : "ゲスト";
                
                // 新ホストのIDに向けて再入場を試みる（新しいPeerインスタンスが生成され、新しいwindow.myIdを取得する）
                isMigrating = false;
                guestJoinRoom(data.newHostId, myName);
            }, 1200);
        }
        return;
    }

    if (data.type === "SYNC_STATE") {
        game.isGameStarted = data.gameState.isGameStarted;
        game.deck = data.gameState.deck;
        game.turnIndex = data.gameState.turnIndex;
        game.highestBid = data.gameState.highestBid || 0;
        game.cardSettings = data.gameState.cardSettings;
        game.drawSettings = data.gameState.drawSettings;

        rawPlayerList = data.rawPlayerList;

        if (data.gameState.players) {
            game.players = data.gameState.players;
        }

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

        if (data.secretView) {
            if (typeof window.showSecretCardModal === "function") {
                window.showSecretCardModal(data.secretView.targetName, data.secretView.cardValue);
            }
        }

        // 💡 補足: 自動移行でホストになった場合のフォールバック（HOST_MIGRATIONが不発だった場合用）
        const myInfo = rawPlayerList.find(p => p.id === window.myId);
        if (myInfo && myInfo.isHost && !isHost) {
            setIsHost(true);
            game.log("👑 あなたが新しいホストに昇格しました！");
            if (typeof window.activateHostMode === "function") {
                window.activateHostMode();
            }
        }

        updateUI();
    }
}

// プレイヤー切断時の共通処理
function handlePlayerDisconnect(peerId) {
    if (isMigrating) return; // 💡 移行中の意図的な切断であれば処理をスキップ

    const leftPlayer = rawPlayerList.find(p => p.id === peerId);
    if (!leftPlayer) return;

    leftPlayer.disconnected = true;
    game.log(`🚪 ${leftPlayer.name} が退室（接続切れ）しました。`);
    
    guestConnections = guestConnections.filter(c => c.peer !== peerId);

    if (game.isGameStarted && game.players) {
        const pInGame = game.players.find(p => p.id === peerId);
        if (pInGame) {
            pInGame.alive = false;
            pInGame.hand = [];
        }
        const alives = game.players.filter(p => p.alive && !p.spectator);
        if (alives.length <= 1 || game.deck.length === 0) {
            if (typeof game.endRound === "function") game.endRound();
        }
    }

    // 💡 ホストが「不意の事故」で突然切断された場合の自動マイグレーション処理
    if (leftPlayer.isHost) {
        leftPlayer.isHost = false;
        const nextHost = rawPlayerList.find(p => !p.disconnected);
        if (nextHost) {
            game.log(`👑 ホストが切断されたため、次の最古参プレイヤー ${nextHost.name} への移行準備を行います...`);
            
            // 自分が次のホストに選ばれた場合
            if (nextHost.id === window.myId) {
                setIsHost(true);
                guestConnections = [];
                if (typeof window.activateHostMode === "function") {
                    window.activateHostMode();
                }
                // 自分が持っている「直近のゲームデータ」を正として全員を再招待する号令を出す
                rawPlayerList.forEach(p => { if(p.id !== window.myId) p.disconnected = true; });
                nextHost.isHost = true;
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
                hand: (p.id === conn.peer) ? p.hand : p.hand.map(() => 0) // 💡 チート防止フィルター
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

// 👑 ホスト用：明示的なホスト権限の譲渡ボタンが押された時の処理
export function hostTransferAuthority(peerId) {
    if (!isHost) return;
    const target = rawPlayerList.find(p => p.id === peerId);
    if (!target || target.disconnected) return;

    // 💡 既存の内部ロジック関数 transferHostPrivilege を叩いて完全移行シーケンスを開始
    transferHostPrivilege(peerId);
}

// 部屋を離脱
export function leaveRoom() {
    if (isHost) {
        const nextHost = rawPlayerList.find(p => p.id !== window.myId && !p.disconnected);
        if (nextHost) {
            // 自発的離脱の際も、可能なら権限移行シーケンスを走らせる
            transferHostPrivilege(nextHost.id);
            return;
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

// HTML側のUI操作ヘルパー
function displayMyRoomId(id) {
    const roomIdInput = document.getElementById("room-id-input");     
    const roomIdDisplay = document.getElementById("room-id-display"); 
    
    if (roomIdInput) roomIdInput.value = id;
    if (roomIdDisplay) roomIdDisplay.innerText = id;
}

/**
 * 👑 ホストとして部屋を作成する
 */
export function hostCreateRoom(myName) {
    peer = new Peer(peerOptions);

    peer.on("open", (id) => {
        window.myId = id; 
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

    // 待ち受け処理の共通化
    window.activateHostMode();
}

/**
 * 🟢 ゲストとしてホストの部屋に参加する
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
            // 💡 改善点: ホスト移行作業中の意図的な切断であればリロードをスルーする
            if (isMigrating) {
                console.log("🛠️ ホスト移行中のため、一時的な切断を許容します。");
                return;
            }
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
        if (err.type === "peer-not-found" && !isMigrating) {
            alert("指定された部屋IDが見つかりません。");
        }
        game.log(`⚠️ ネットワークエラー: ${err.type}`);
    });
}

// 💡 改善されたサーバー待ち受け処理（移行時の再マッピング対応）
window.activateHostMode = function() {
    if (!peer) return;
    
    // 以前登録された古い connection リスナーがあれば上書きできるように再バインド
    peer.off("connection"); 
    
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

// 💡 明示的な権限委譲シーケンス
export function transferHostPrivilege(newHostId) {
    if (!isHost) return;

    const targetPlayer = rawPlayerList.find(p => p.id === newHostId);
    const targetName = targetPlayer ? targetPlayer.name : "新ホスト";

    game.log(`🔄 ホスト権限を ${targetName} へ移行する手続きを開始しました...`);

    // 1. 新ホストに渡すための「完全なゲーム状態（他人の秘密手札なども全て保持）」をシリアライズ
    const fullGameState = JSON.stringify(game);

    // 2. 全員に「ホスト移行通知」と「完全な生データ」をブロードキャスト
    const payload = JSON.stringify({
        type: "HOST_MIGRATION",
        newHostId: newHostId,
        newHostName: targetName,
        fullGameState: fullGameState, 
        rawPlayerList: rawPlayerList.map(p => {
            // これから新ホストに切り替わるターゲットのフラグを事前にtrueにしておく
            if (p.id === newHostId) p.isHost = true;
            if (p.id === window.myId) p.isHost = false;
            return p;
        })
    });

    isMigrating = true; // 自分自身もリロード抑止

    guestConnections.forEach(conn => {
        if (conn.open) conn.send(payload);
    });

    // 3. 自分自身を「ゲスト」に降格させる
    setIsHost(false);

    // 4. 旧ホスト自身も、1秒後に「新しいホスト」に子機としてぶら下がるため接続を実行
    setTimeout(() => {
        if (guestConnections) {
            guestConnections.forEach(c => c.close()); // 古い子機チャンネルを全切断
        }
        const myProfile = rawPlayerList.find(p => p.id === window.myId);
        const myName = myProfile ? myProfile.name : "旧ホスト";
        
        isMigrating = false;
        guestJoinRoom(newHostId, myName);
    }, 1000);
}