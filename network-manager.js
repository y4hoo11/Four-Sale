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
    serialization: 'json',
    config: {
        'iceServers': [
            { url: 'stun:stun.l.google.com:19302' },
            { url: 'stun:stun1.l.google.com:19302' },
            { url: 'stun:stun2.l.google.com:19302' }
        ]
    }
};

export function setIsHost(val) { 
    console.log(`[NETWORK SYSTEM] ホスト権限変更: ${isHost} -> ${val}`);
    isHost = val; 
    window.isHost = val; // グローバル同期
    if (isHost) {
        // 自分自身をrawPlayerList内でホスト扱いにマーク
        const me = rawPlayerList.find(p => p.id === window.myId);
        if (me) me.isHost = true;
    }
}
export function setRawPlayerList(list) { 
    console.log("[NETWORK SYSTEM] rawPlayerListを更新しました:", list);
    rawPlayerList = list; 
}
export function setConnections(conn) { 
    if (!guestConnections.some(c => c.peer === conn.peer)) {
        console.log(`[HOST NETWORK] 新しいゲストのコネクションを登録: ${conn.peer}`);
        guestConnections.push(conn); 
    }
}
export function setConnToHost(conn) { 
    console.log(`[GUEST NETWORK] ホストへのコネクションを設定: ${conn ? conn.peer : "null"}`);
    connToHost = conn; 
}

// ホストがデータを受信した時の処理
export function handleHostReceiveData(conn, data) {
    if (!isHost) return;

    console.log(`[HOST RECEIVE] ゲスト[${conn.peer}] からパケット受信:`, data);

    try {
        switch (data.type) {
            case "JOIN":
                console.log(`[HOST RECEIVE: JOIN] プレイヤー名: ${data.name}, ID: ${data.id}`);
                // 💡 条件1: 「名前が一致」かつ「本当に現在切断状態（disconnected: true）」のプレイヤーを探す
                const disconnectedPlayer = rawPlayerList.find(p => p.name === data.name && p.disconnected === true);
                
                if (disconnectedPlayer) {
                    // 【既存プレイヤーの復帰処理】
                    disconnectedPlayer.id = data.id; 
                    disconnectedPlayer.disconnected = false;
                    disconnectedPlayer.spectator = game.isGameStarted; 
                    game.log(`🔄 ${data.name} が再接続・同期しました。`);

                    if (game.isGameStarted && game.players) {
                        const gp = game.players.find(p => p.name === data.name);
                        if (gp) {
                            gp.id = data.id;
                            gp.disconnected = false;
                        }
                    }
                } else {
                    // 【新規プレイヤーの追加処理】（同名、または完全な新規）
                    if (!rawPlayerList.some(p => p.id === data.id)) {
                        
                        // 💡 同名プレイヤー（ホスト含む）がすでにアクティブに存在する場合、名前の後ろに数字をつける
                        let finalName = data.name || "ゲスト";
                        let counter = 1;
                        
                        // 名前の重複がなくなるまでループして「名前(1)」「名前(2)」を作る
                        while (rawPlayerList.some(p => p.name === finalName)) {
                            finalName = `${data.name}(${counter})`;
                            counter++;
                        }

                        // 💡 【仕様要件】離退した参加者と同じ名前、またはゲーム中に参加した人は一律で観戦状態にする
                        const isSpectator = game.isGameStarted || rawPlayerList.some(p => p.name === data.name);
                        
                        rawPlayerList.push({
                            id: data.id,
                            name: finalName, // 被らない安全な名前を適用
                            spectator: isSpectator,
                            score: 0,
                            isHost: false, // 確実にゲスト（false）として追加
                            disconnected: false
                        });

                        // 進行中のゲーム配列にも観戦者として追加
                        if (game.isGameStarted && game.players) {
                            if (!Array.isArray(game.players)) game.players = [];
                            game.players.push({
                                id: data.id,
                                name: isSpectator ? `${finalName}(観戦中)` : finalName,
                                coins: 0,
                                hand: [],
                                score: 0,
                                spectator: isSpectator,
                                disconnected: false,
                                alive: false // 進行中のラウンドでは不参加
                            });
                        }
                        
                        game.log(`👥 ${finalName} が${isSpectator ? "観戦者として" : ""}入室しました。`);
                    }
                }
                broadcastState();
                updateUI();
                break;

            case "ACTION":
                if (!game.isGameStarted) return;
                
                console.log("=== 【通信受信デバッグ: ACTION】 ===");
                const currentPlayer = game.players[game.turnIndex];
                if (currentPlayer && currentPlayer.id === data.playerId) {
                    const actualValue = data.cardValue !== undefined ? data.cardValue : (data.actionValue !== undefined ? data.actionValue : data.value);
                    console.log("ロジックに渡す実際の値:", actualValue);

                    game.playCard(data.playerId, actualValue, data.target);
                    
                    broadcastState();
                    updateUI();
                } else {
                    console.warn(`[HOST WARNING] 不正な手番プレイヤーからのアクション要求です。期待されるID: ${currentPlayer?.id}, 受信ID: ${data.playerId}`);
                }
                break;

            case "LEAVE":
                console.log(`[HOST RECEIVE: LEAVE] ゲスト[${conn.peer}] からの能動離脱要求`);
                handlePlayerDisconnect(conn.peer);
                break;

            case "REQUEST_SYNC":
                console.log(`🔄 プレイヤー [${data.playerName || data.playerId}] から再送要求を受信しました。最新データを送信します。`);
                sendStateToSingleConnection(conn);
                break;
            default:
                console.warn(`[HOST WARNING] 未知のデータタイプを受信しました: ${data.type}`);
        }
    } catch (err) {
        console.error("[HOST FATAL ERROR] handleHostReceiveData 内で例外クラッシュが発生しました:", err);
    }
}

// ゲストがデータを受信した時の処理
export function handleGuestReceiveData(data) {
    if (isHost) return;

    // 🔬 【ゲスト側・受信直後デバッグ】
    console.log("=== 📥 [GUEST INPUT] ホストからパケットが物理的に届きました ===");
    console.log("届いたデータの型:", typeof data);
    console.log("データ全体のプロパティ一覧:", data ? Object.keys(data) : "null/undefined");
    
    if (!data) {
        console.error("🚨 エラー: 届いたパケットデータが空(null/undefined)です。");
        return;
    }

    try {
        console.log("1. data.type の値:", data.type);
        console.log("2. data.rawPlayerList の中身:", data.rawPlayerList);
        
        if (data.gameState) {
            console.log("3. data.gameState のプロパティ一覧:", Object.keys(data.gameState));
            console.log("4. data.gameState.players の生の値:", data.gameState.players);
        } else if (data.type === "SYNC_STATE") {
            console.error("🚨 警告: SYNC_STATEパケットですが data.gameState 自体が存在しません！");
        }

        // 💡 ホスト移行命令（HOST_MIGRATION）を受信した場合の処理
        if (data.type === "HOST_MIGRATION") {
            game.log(`🔄 ホストが ${data.newHostName || "新しいホスト"} に移行されます。ネットワークを再構築中...`);
            isMigrating = true; 

            if (connToHost) {
                try { connToHost.close(); } catch(e) {}
                connToHost = null;
            }

            if (window.myId === data.newHostId) {
                let backupGameState = data.fullGameState ? JSON.parse(JSON.stringify(data.fullGameState)) : null;
                let backupPlayerList = Array.isArray(data.rawPlayerList) ? [...data.rawPlayerList] : [];

                game.log("👑 あなたが新しいホストに指名されました。ホストサーバーを起動しています...");

                const activePeer = window.peer || peer;
                if (activePeer) {
                    try {
                        activePeer.off("open");
                        activePeer.off("connection");
                        activePeer.off("error");
                        activePeer.destroy();
                    } catch(e) { console.error(e); }
                    window.peer = null;
                    peer = null;
                }

                window.peer = new Peer(data.newHostId, peerOptions); 
                peer = window.peer; 

                window.peer.on("open", (openedId) => {
                    window.myId = openedId;
                    setIsHost(true);
                    isMigrating = false;
                    displayMyRoomId(openedId);

                    if (backupGameState) {
                        try {
                            const parsed = (typeof backupGameState === "string") ? JSON.parse(backupGameState) : backupGameState;
                            Object.assign(game, parsed);
                            console.log("[GUEST TO HOST] ゲームステートの復元に成功しました:", game);
                        } catch (e) {
                            console.error("ゲームデータの復元に失敗しました:", e);
                        }
                    }
                    
                    rawPlayerList = backupPlayerList;
                    
                    const me = rawPlayerList.find(p => p.id === openedId);
                    if (me) {
                        me.isHost = true;
                        me.disconnected = false;
                    } else {
                        console.warn("名簿内に自分の新しいIDが見つからなかったため、強制追加します。");
                        rawPlayerList.push({
                            id: openedId,
                            name: data.newHostName,
                            spectator: false,
                            score: 0,
                            isHost: true,
                            disconnected: false
                        });
                    }

                    guestConnections = []; 
                    window.activateHostMode();
                    
                    game.log("👑 ホストサーバーの起動が完了しました！他のプレイヤーの再接続を待っています。");
                    updateUI();
                });

                window.peer.on("error", (err) => {
                    console.error("新ホスト起動中のエラー:", err);
                    game.log(`⚠️ 新ホスト起動エラー: ${err.type}`);
                });
            } 
            else {
                setTimeout(() => {
                    const myProfile = rawPlayerList.find(p => p.id === window.myId);
                    const myName = myProfile ? myProfile.name : "ゲスト";
                    
                    isMigrating = false;
                    guestJoinRoom(data.newHostId, myName);
                }, 1500);
            }
            return;
        }

        if (data.type === "SYNC_STATE") {
            console.log("🔍 [DEBUG] ゲストが SYNC_STATE 受信処理を開始します...");

            if (!data.gameState) {
                throw new Error("パケット内に 'gameState' フィールドが存在しません。");
            }

            // 💡 ui-manager.js 内の画面ロック解除
            import("./ui-manager.js").then(mod => {
                if (typeof mod.markFirstSyncComplete === "function") {
                    mod.markFirstSyncComplete();
                }
            }).catch(e => console.error("ui-managerのインポート失敗:", e));

            // 💡 画面表示の切り替え
            const setupContainer = document.getElementById("setup-container");
            const lobbyContainer = document.getElementById("lobby-container");
            const gameContainer = document.getElementById("game-container");
            if (setupContainer) setupContainer.style.display = "none";
            
            if (data.gameState.isGameStarted) {
                if (lobbyContainer) lobbyContainer.style.display = "none";
                if (gameContainer) gameContainer.style.display = "block";
            } else {
                if (lobbyContainer) lobbyContainer.style.display = "block";
                if (gameContainer) gameContainer.style.display = "none";
            }
            
            const joinBtn = document.getElementById("join-room-btn");
            if (joinBtn) joinBtn.disabled = false;
            
            // ステートのマッピング
            game.isGameStarted = data.gameState.isGameStarted;
            game.deck = data.gameState.deck;
            game.market = Array.isArray(data.gameState.market) ? [...data.gameState.market] : [];
            game.turnIndex = data.gameState.turnIndex;
            game.highestBid = data.gameState.highestBid || 0;
            game.cardSettings = data.gameState.cardSettings;
            game.drawSettings = data.gameState.drawSettings;
            game.phase = data.gameState.phase || game.phase; 

            rawPlayerList = data.rawPlayerList;

            // 送られてきたプレイヤーデータを安全に同期する
            if (data.gameState.players) {
                if (!Array.isArray(game.players)) {
                    console.log("[GUEST SYNC] game.players が配列ではないため初期化します");
                    game.players = [];
                }
                game.players.length = 0; 
                data.gameState.players.forEach(p => {
                    game.players.push(p);
                });
            }
            
            console.log("🔄 [同期完了直後] ゲスト側の game.players の中身:", game.players);

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

            // 自動移行でホストになった場合のフォールバック
            const myInfo = rawPlayerList.find(p => p.id === window.myId);
            if (myInfo && myInfo.isHost && !isHost) {
                setIsHost(true);
                game.log("👑 あなたが新しいホストに昇格しました！");
                if (typeof window.activateHostMode === "function") {
                    window.activateHostMode();
                }
            }
            
            // 画面描写の実行
            updateUI();
            console.log("⚙️ [GUEST SYNC] updateUI() を実行しました。");
        }
    } catch (syncError) {
        console.error("🚨 [GUEST CRITICAL ERROR] データ同期処理中に例外エラーが発生しました:", syncError);
    }
    console.log("=========================================================");
}

// プレイヤー切断時の共通処理
function handlePlayerDisconnect(peerId) {
    if (isMigrating) return; 

    console.log(`[NETWORK SYSTEM] プレイヤー切断検知: ${peerId}`);
    const leftPlayer = rawPlayerList.find(p => p.id === peerId);
    if (!leftPlayer) return;

    leftPlayer.disconnected = true;
    game.log(`🚪 ${leftPlayer.name} が退室（離脱）しました。`);
    
    guestConnections = guestConnections.filter(c => c.peer !== peerId);

    if (game.isGameStarted && game.players) {
        const pInGame = game.players.find(p => p.id === peerId);
        if (pInGame) {
            pInGame.disconnected = true; 
            pInGame.alive = false;
            pInGame.hand = [];
            pInGame.hasPassed = true; 
        }

        const activeCount = game.players.filter(p => !p.disconnected && !p.spectator).length;
        console.log(`📊 残りのアクティブプレイヤー数: ${activeCount}人`);

        if (game.players[game.turnIndex]?.id === peerId) {
            if (typeof game.nextTurn === "function") game.nextTurn();
        }

        const alives = game.players.filter(p => p.alive && !p.spectator && !p.disconnected);
        if (alives.length <= 1 || (game.deck && game.deck.length === 0)) {
            if (typeof game.endRound === "function") game.endRound();
        }
    } else {
        rawPlayerList = rawPlayerList.filter(p => p.id !== peerId);
    }

    if (leftPlayer.isHost) {
        leftPlayer.isHost = false;
        const nextHost = rawPlayerList.find(p => !p.disconnected);
        if (nextHost) {
            game.log(`👑 ホストが切断されたため、次の最古参プレイヤー ${nextHost.name} への移行準備を行います...`);
            
            if (nextHost.id === window.myId) {
                setIsHost(true);
                guestConnections = [];
                if (typeof window.activateHostMode === "function") {
                    window.activateHostMode();
                }
                rawPlayerList.forEach(p => { if(p.id !== window.myId) p.disconnected = true; });
                nextHost.isHost = true;
            }
        }
    }

    broadcastState();
    updateUI();
}

// 特定の1本の接続に対してデータを送る
function sendStateToSingleConnection(conn) {
    if (!conn || !conn.open) {
        console.warn(`[HOST SEND WARNING] コネクションが閉じているため送信をスキップしました: ${conn ? conn.peer : "null"}`);
        return;
    }

    console.log(`[HOST SEND] ターゲット[${conn.peer}] への同期データ構築開始`);

    let secretViewData = null;
    const targetPlayerInGame = game.players ? game.players.find(p => p.id === conn.peer) : null;
    if (targetPlayerInGame && targetPlayerInGame.pendingSecretView) {
        secretViewData = targetPlayerInGame.pendingSecretView;
        delete targetPlayerInGame.pendingSecretView;
    }

    let safePlayers = [];
    try {
        if (game.players && game.players.length > 0) {
            safePlayers = game.players.map(p => {
                const currentHand = Array.isArray(p.hand) ? p.hand : [];
                return {
                    id: String(p.id || ""),
                    name: String(p.name || "ゲスト"),
                    alive: p.alive !== undefined ? Boolean(p.alive) : true,
                    protected: p.protected !== undefined ? Boolean(p.protected) : false,
                    history: Array.isArray(p.history) ? [...p.history] : [],
                    spectator: Boolean(p.spectator),
                    disconnected: Boolean(p.disconnected), 
                    score: Number(p.score || 0),
                    coins: p.coins !== undefined ? Number(p.coins) : (game.initialCoins || 18),
                    bid: Number(p.bid || 0),
                    hasPassed: Boolean(p.hasPassed),
                    hand: (p.id === conn.peer || p.disconnected) ? [...currentHand] : currentHand.map(() => 0)
                };
            });
        } else {
            safePlayers = rawPlayerList.map(p => ({
                id: String(p.id || ""),
                name: String(p.name || "ゲスト"),
                alive: true,
                protected: false,
                history: [],
                spectator: Boolean(p.spectator),
                disconnected: Boolean(p.disconnected),
                score: Number(p.score || 0),
                coins: Number(game.initialCoins || 18),
                bid: 0,
                hasPassed: false,
                hand: []
            }));
        }
    } catch (buildError) {
        console.error("🚨 プレイヤーデータ構築中に深刻なエラーが発生しました:", buildError);
    }

    const payload = {
        type: "SYNC_STATE",
        rawPlayerList: rawPlayerList, 
        gameState: {
            isGameStarted: Boolean(game.isGameStarted),
            deck: Array.isArray(game.deck) ? [...game.deck] : [],
            market: Array.isArray(game.market) ? [...game.market] : [],
            turnIndex: Number(game.turnIndex || 0),
            highestBid: Number(game.highestBid || 0),
            phase: String(game.phase || "BID"),
            logMessages: Array.isArray(game.logMessages) ? [...game.logMessages] : [],
            cardSettings: game.cardSettings ? game.cardSettings : null,
            drawSettings: game.drawSettings ? game.drawSettings : null,
            players: safePlayers
        },
        secretView: secretViewData ? secretViewData : null
    };

    try {
        console.log(`[HOST SEND] 物理パケット送信実行 -> 宛先: ${conn.peer}`, payload);
        conn.send(payload);
    } catch (sendSerializeError) {
        console.error("🚨 送信失敗。JSONシリアライズフォールバックを実行します:", sendSerializeError);
        try { conn.send(JSON.stringify(payload)); } catch(e){ console.error("フォールバックも失敗しました:", e); }
    }
}

// ホストから全ゲストへ状態をブロードキャスト
export function broadcastState() {
    if (!isHost) return;
    console.log(`[HOST BROADCAST] 全ゲスト数 (${guestConnections.length}台) へ一斉送信開始`);
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

/**
 * 🗑️ ホスト用：「切断」状態のプレイヤーをルームから完全に削除する
 */
export function hostRemoveDisconnectedPlayer(peerId) {
    if (!isHost) return;

    const target = rawPlayerList.find(p => p.id === peerId);
    if (target) {
        game.log(`🗑️ ${target.name} のデータがルームから削除されました。`);
    }
    
    rawPlayerList = rawPlayerList.filter(p => p.id !== peerId);
    broadcastState();
    updateUI();
}

// 👑 ホスト用：明示的なホスト権限の譲渡
export function hostTransferAuthority(peerId) {
    if (!isHost) return;
    const target = rawPlayerList.find(p => p.id === peerId);
    if (!target || target.disconnected) return;

    transferHostPrivilege(peerId);
}

// 部屋を離脱
export function leaveRoom() {
    if (isHost) {
        const nextHost = rawPlayerList.find(p => p.id !== window.myId && !p.disconnected);
        if (nextHost) {
            if (confirm(`ホストを離脱します。権限を ${nextHost.name} へ譲渡しますか？`)) {
                transferHostPrivilege(nextHost.id);
                return;
            }
        }
        guestConnections.forEach(conn => {
            if (conn.open) conn.close();
        });
    } else {
        if (connToHost && connToHost.open) {
            connToHost.send({ type: "LEAVE", playerId: window.myId });
            setTimeout(() => { try { connToHost.close(); } catch(e){} }, 100);
        }
    }
    setTimeout(() => {
        window.location.reload();
    }, 200);
}

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
    console.log("[HOST INIT] 部屋の新規作成を開始します。名前:", myName);
    const activePeer = window.peer || peer;
    if (activePeer) {
        try { activePeer.destroy(); } catch(e) {}
        window.peer = null;
        peer = null;
    }

    window.peer = new Peer(peerOptions);
    peer = window.peer;

    window.peer.on("open", (id) => {
        console.log(`[HOST PEER OPEN] PeerJSサーバーとの接続成功。マイID: ${id}`);
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

    window.peer.on("error", (err) => {
        console.error("[HOST PEER ERROR] PeerJSエラーが発生しました:", err);
    });

    window.activateHostMode();
}

/**
 * 🟢 ゲストとしてホストの部屋に参加する
 */
export function guestJoinRoom(targetRoomId, myName) {
    console.log(`[GUEST INIT] 部屋[${targetRoomId}] への参加要求を開始します。プレイヤー名: ${myName}`);
    if (!targetRoomId) {
        alert("参加する部屋IDを入力してください。");
        return;
    }

    const activePeer = window.peer || peer; 
    
    if (!activePeer || activePeer.disconnected) {
        alert("ネットワークの準備ができていません。ページを再読み込みしてください。");
        const joinBtn = document.getElementById("join-room-btn");
        if (joinBtn) joinBtn.disabled = false;
        return;
    }

    let connectionTimeout = null;
    setIsHost(false);

    game.log(`🏠 部屋 [ ${targetRoomId} ] へ接続を試みています...`);

    const conn = activePeer.connect(targetRoomId);
    setConnToHost(conn);
    
    connectionTimeout = setTimeout(() => {
        game.log("<b style='color: red;'>❌ 入室失敗: ホストから応答がありません。部屋がまだ作成されていないか、IDが間違っています。</b>");
        
        const joinBtn = document.getElementById("join-room-btn");
        if (joinBtn) joinBtn.disabled = false;

        if (conn) {
            try { conn.close(); } catch(e){}
            setConnToHost(null);
        }
        updateUI();
        alert("ホストの部屋が見つかりませんでした。ホストが部屋を作成したことを確認してから再度お試しください。");
    }, 3000);

    conn.on("open", () => {
        console.log(`[GUEST PEER OPEN] ホストとの双方向P2P通信が開通しました！ターゲットホスト: ${targetRoomId}`);
        
        if (connectionTimeout) {
            clearTimeout(connectionTimeout);
            connectionTimeout = null;
        }

        game.log("⚡ ホストとの接続が確立しました。入室リクエストを送ります...");
        
        const joinPayload = {
            type: "JOIN",
            id: window.myId, 
            name: myName || "ゲスト"
        };
        console.log("[GUEST SEND] JOIN要求送信:", joinPayload);
        conn.send(joinPayload);
    });

    conn.on("data", (data) => {
        let parsedData = data;
        if (typeof data === "string") {
            try { parsedData = JSON.parse(data); } catch(e) {}
        }
        handleGuestReceiveData(parsedData);
    });

    conn.on("close", () => {
        console.log("[GUEST PEER CLOSE] コネクションが閉じられました。");
        if (isMigrating) {
            console.log("🛠️ ホスト移行中のため、一時的な切断を許容します。");
            return;
        }
        game.log("❌ ホストとの接続が切断されました。");
        setTimeout(() => { window.location.reload(); }, 1500);
    });

    conn.on("error", (err) => {
        console.error("[GUEST PEER CONNECT ERROR] 接続エラー:", err);
        game.log("⚠️ ホストへの接続中にエラーが発生しました。");
        const joinBtn = document.getElementById("join-room-btn");
        if (joinBtn) joinBtn.disabled = false;
        if (connectionTimeout) clearTimeout(connectionTimeout);
    });
}

// サーバー待ち受け処理
window.activateHostMode = function() {
    const activePeer = window.peer || peer;
    if (!activePeer) return;
    
    console.log("[HOST LISTEN] ゲストからの接続待ち受け（サーバーモード）を有効化しました。");
    activePeer.off("connection"); 
    
    activePeer.on("connection", (conn) => {
        console.log(`[HOST LISTEN] ゲストからのインバウンド接続を受け入れました: ${conn.peer}`);
        setConnections(conn);
        
        conn.on("data", (data) => {
            let parsedData = data;
            if (typeof data === "string") {
                try { parsedData = JSON.parse(data); } catch(e) {}
            }
            handleHostReceiveData(conn, parsedData);
        });
        
        conn.on("close", () => { 
            console.log(`[HOST LISTEN] ゲスト[${conn.peer}] の接続が閉じられました。`);
            handlePlayerDisconnect(conn.peer); 
        });
        conn.on("error", (err) => { 
            console.error(`[HOST LISTEN] ゲスト[${conn.peer}] でエラーが発生しました:`, err);
            handlePlayerDisconnect(conn.peer); 
        });
    });
};

// 明示的な権限委譲シーケンス
export function transferHostPrivilege(newHostId) {
    if (!isHost) return;

    const targetPlayer = rawPlayerList.find(p => p.id === newHostId);
    const targetName = targetPlayer ? targetPlayer.name : "新ホスト";

    game.log(`🔄 ホスト権限を ${targetName} へ移行する手続きを開始しました...`);

    const rawStateObject = {
        isGameStarted: Boolean(game.isGameStarted),
        deck: Array.isArray(game.deck) ? [...game.deck] : [],
        market: Array.isArray(game.market) ? [...game.market] : [],
        turnIndex: Number(game.turnIndex || 0),
        highestBid: Number(game.highestBid || 0),
        phase: String(game.phase || "BID"),
        logMessages: Array.isArray(game.logMessages) ? [...game.logMessages] : [],
        cardSettings: game.cardSettings ? game.cardSettings : null,
        drawSettings: game.drawSettings ? game.drawSettings : null,
        players: game.players ? game.players : []
    };

    const migratedPlayerList = rawPlayerList.map(p => {
        return {
            ...p,
            isHost: p.id === newHostId,
            disconnected: p.id === window.myId ? false : p.disconnected 
        };
    });

    const payload = {
        type: "HOST_MIGRATION",
        newHostId: newHostId,
        newHostName: targetName,
        fullGameState: rawStateObject,
        rawPlayerList: migratedPlayerList 
    };

    isMigrating = true;

    guestConnections.forEach(conn => {
        if (conn.open) conn.send(payload);
    });

    setIsHost(false);

    setTimeout(() => {
        console.log("🔄 旧ホストのネットワーククリーンアップを実行します。");
        if (guestConnections) {
            guestConnections.forEach(c => {
                try { c.close(); } catch(e){}
            });
            guestConnections = [];
        }
        const myProfile = rawPlayerList.find(p => p.id === window.myId);
        const myName = myProfile ? myProfile.name : "旧ホスト";
        
        isMigrating = false;
        guestJoinRoom(newHostId, myName);
    }, 1500);
}