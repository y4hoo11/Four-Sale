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
            // 💡 条件1: 「名前が一致」かつ「本当に現在切断状態（disconnected: true）」のプレイヤーを探す
            const disconnectedPlayer = rawPlayerList.find(p => p.name === data.name && p.disconnected === true);
            
            if (disconnectedPlayer) {
                // 【既存プレイヤーの復帰処理】
                disconnectedPlayer.id = data.id; 
                disconnectedPlayer.disconnected = false;
                // 観戦中フラグが残っている場合は解除、または同名再ログインのルールを適用
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

                    // 💡 【仕様要件】離脱した参加者と同じ名前、またはゲーム中に参加した人は一律で観戦状態にする
                    // かつ、ゲーム中に入ってきた新規プレイヤーも spectator = true
                    const isSpectator = game.isGameStarted || rawPlayerList.some(p => p.name === data.name);
                    
                    rawPlayerList.push({
                        id: data.id,
                        name: finalName, // 被らない安全な名前を適用
                        spectator: isSpectator,
                        score: 0,
                        isHost: false, // 確実にゲスト（false）として追加
                        disconnected: false
                    });

                    // 進行中のゲーム配列にも観戦者として追加（次のゲームからシームレスに復帰可能にするため）
                    if (game.isGameStarted && game.players) {
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
            // 💡 ゲストが能動的に「部屋を離脱」ボタンを押した場合も切断処理へ流す
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

    // 🔬 【ゲスト側・受信直後デバッグ】
    console.log("=== 📥 [GUEST INPUT] ホストからパケットが物理的に届きました ===");
    console.log("届いたデータの型:", typeof data);
    console.log("データ全体のプロパティ一覧:", data ? Object.keys(data) : "null/undefined");
    
    if (data) {
        console.log("1. data.type の値:", data.type);
        console.log("2. data.rawPlayerList の中身:", data.rawPlayerList);
        
        if (data.gameState) {
            console.log("3. data.gameState のプロパティ一覧:", Object.keys(data.gameState));
            console.log("4. data.gameState.players の生の値:", data.gameState.players);
        } else {
            console.log("🚨 警告: data.gameState 自体が存在しません！");
        }
    }
    console.log("=========================================================");

    // 💡 ホスト移行命令（HOST_MIGRATION）を受信した場合の処理
    if (data.type === "HOST_MIGRATION") {
        game.log(`🔄 ホストが ${data.newHostName || "新しいホスト"} に移行されます。ネットワークを再構築中...`);
        isMigrating = true; // 意図的な切断フラグを立ててリロードを抑止

        // 1. 古いホストとのP2Pコネクションを破棄
        if (connToHost) {
            try { connToHost.close(); } catch(e) {}
            connToHost = null;
        }

        // 2. 自分が「新ホスト」に指名されていた場合の処理
        if (window.myId === data.newHostId) {
            
            // 💡 【最重要バグ修正】すでにパース済みのオブジェクトとして届いているため、再パースせずそのままマージ
            let backupGameState = data.fullGameState;
            let backupPlayerList = data.rawPlayerList;

            game.log("👑 あなたが新しいホストに指名されました。ホストサーバーを起動しています...");

            // 💡 既存の古いPeer（ゲスト用）を完全に破棄してポートを解放する
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

            // 旧ホストが使っていた「同じ部屋ID」を自分が引き継いでPeerを再生成する
            window.peer = new Peer(data.newHostId, peerOptions); 
            peer = window.peer; // ローカル変数側も同期

            window.peer.on("open", (id) => {
                window.myId = id;
                setIsHost(true);
                isMigrating = false;
                displayMyRoomId(id);

                // 退避していたゲームデータを自分のgameオブジェクトにマージして完全復元
                if (backupGameState) {
                    try {
                        // 💡 もし文字列だった場合のみパースするセーフティガード
                        const parsed = (typeof backupGameState === "string") ? JSON.parse(backupGameState) : backupGameState;
                        Object.assign(game, parsed);
                    } catch (e) {
                        console.error("ゲームデータの復元に失敗しました:", e);
                    }
                }
                
                // ルーム名簿を引き継ぎ、自分をホストとしてマーク
                rawPlayerList = backupPlayerList;
                const me = rawPlayerList.find(p => p.id === window.myId);
                if (me) {
                    me.isHost = true;
                    me.disconnected = false;
                }

                // 新ホストとしての「子機からの接続待ち受け（サーバーモード）」を起動
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
        // 3. 自分は「ゲスト（または旧ホスト）」のままの場合の処理
        else {
            // 新ホストがPeerの再起動を終えて、シグナリングサーバーに部屋を開通させるのを確実に待つ（1.5秒待機）
            setTimeout(() => {
                const myProfile = rawPlayerList.find(p => p.id === window.myId);
                const myName = myProfile ? myProfile.name : "ゲスト";
                
                isMigrating = false;
                // 新ホストのIDに向けて再入場を試みる
                guestJoinRoom(data.newHostId, myName);
            }, 1500);
        }
        return;
    }

    if (data.type === "SYNC_STATE") {
        console.log("🔍 [DEBUG] ゲストが SYNC_STATE を受信しました:", data);

        // 💡 ui-manager.js 内のフラグ管理関数を呼び出して、向こうの画面ロックを解除させる
        import("./ui-manager.js").then(mod => {
            mod.markFirstSyncComplete();
        });

        // 💡 画面表示の切り替え（前回の残存コンテナ非表示バグの修正）
        const setupContainer = document.getElementById("setup-container");
        const lobbyContainer = document.getElementById("lobby-container");
        const gameContainer = document.getElementById("game-container");
        if (setupContainer) setupContainer.style.display = "none";
        
        // ゲームが開始されているかいないかでコンテナを制御
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
        game.phase = data.gameState.phase || game.phase; // phase も同期

        rawPlayerList = data.rawPlayerList;

        // 送られてきたプレイヤーデータを安全に同期する
        if (data.gameState.players) {
            if (Array.isArray(game.players)) {
                game.players.length = 0; 
                data.gameState.players.forEach(p => {
                    game.players.push(p);
                });
            } else {
                if (typeof game.players === "object" && game.players !== null) {
                    Object.assign(game.players, data.gameState.players);
                } else {
                    game.players = data.gameState.players;
                }
            }
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
        
        updateUI();
    }
}

// プレイヤー切断時の共通処理
function handlePlayerDisconnect(peerId) {
    if (isMigrating) return; // 💡 移行中の意図的な切断であれば処理をスキップ

    const leftPlayer = rawPlayerList.find(p => p.id === peerId);
    if (!leftPlayer) return;

    // 💡 【仕様要件】離脱したプレイヤーのフラグ管理
    leftPlayer.disconnected = true;
    game.log(`🚪 ${leftPlayer.name} が退室（離脱）しました。`);
    
    guestConnections = guestConnections.filter(c => c.peer !== peerId);

    if (game.isGameStarted && game.players) {
        const pInGame = game.players.find(p => p.id === peerId);
        if (pInGame) {
            // UIマネージャー側で赤く染めるため、disconnectedプロパティをゲーム側プレイヤーにも付与
            pInGame.disconnected = true; 
            pInGame.alive = false;
            pInGame.hand = [];
            pInGame.hasPassed = true; // 競りフェーズをストップさせないよう自動パス化
        }

        // 💡 【仕様要件】プレイヤーが減った（離脱した）場合、場に表示・配布するカード枚数を減らす連動ロジック
        // 残った有効なアクティブプレイヤーの数を数える
        const activeCount = game.players.filter(p => !p.disconnected && !p.spectator).length;
        console.log(`📊 残りのアクティブプレイヤー数: ${activeCount}人 (これに伴い次のラウンドから場の配布カード数が自動的に減ります)`);

        // もし離脱したプレイヤーが現在の手番プレイヤーだった場合、ターンを次に進める
        if (game.players[game.turnIndex]?.id === peerId) {
            if (typeof game.nextTurn === "function") game.nextTurn();
        }

        const alives = game.players.filter(p => p.alive && !p.spectator && !p.disconnected);
        if (alives.length <= 1 || (game.deck && game.deck.length === 0)) {
            if (typeof game.endRound === "function") game.endRound();
        }
    } else {
        // ゲーム開始前のカスタム/スタート待機画面であれば、名簿から完全に削除して詰める
        rawPlayerList = rawPlayerList.filter(p => p.id !== peerId);
    }

    // 💡 ホストが突然切断・離脱された場合の自動マイグレーション処理
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

// 特定の1本の接続に対してデータを送る（再送要求応答用ヘルパー）
function sendStateToSingleConnection(conn) {
    if (!conn || !conn.open) return;

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
                    disconnected: Boolean(p.disconnected), // 離脱状態を伝播
                    score: Number(p.score || 0),
                    coins: p.coins !== undefined ? Number(p.coins) : (game.initialCoins || 18),
                    bid: Number(p.bid || 0),
                    hasPassed: Boolean(p.hasPassed),
                    // 🔒 他人の手札は0にマスク。ただし離脱したプレイヤーのカードは公開または空にする
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
        // 💡 【重要修正】 serialization: 'json' 設定時のため、二重シリアライズを避けプレーンオブジェクトのまま送信
        conn.send(payload);
    } catch (sendSerializeError) {
        console.error("🚨 送信失敗。フォールバックを実行します:", sendSerializeError);
        try { conn.send(JSON.stringify(payload)); } catch(e){}
    }
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

// 👑 ホスト用：明示的なホスト権限の譲渡ボタンが押された時の処理
export function hostTransferAuthority(peerId) {
    if (!isHost) return;
    const target = rawPlayerList.find(p => p.id === peerId);
    if (!target || target.disconnected) return;

    transferHostPrivilege(peerId);
}

// 部屋を離脱
export function leaveRoom() {
    // 💡 【仕様要件】カスタム＆スタート待機画面でもゲーム中と同じく正常に離脱できるように統合
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
            // ホストへLEAVEパケットを送信して、ホスト側の名簿から正常離脱させる
            connToHost.send({ type: "LEAVE", playerId: window.myId });
            setTimeout(() => { try { connToHost.close(); } catch(e){} }, 100);
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
    const activePeer = window.peer || peer;
    if (activePeer) {
        try { activePeer.destroy(); } catch(e) {}
        window.peer = null;
        peer = null;
    }

    window.peer = new Peer(peerOptions);
    peer = window.peer;

    window.peer.on("open", (id) => {
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
    
    // 🔥 3秒のセーフティタイマー（ホストがいない場合）
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

    // 接続成功時の処理
    conn.on("open", () => {
        console.log(`[DEBUG 3 🎉 OPEN] ホストとの双方向P2P通信が完全に開通しました！`);
        
        if (connectionTimeout) {
            clearTimeout(connectionTimeout);
            connectionTimeout = null;
        }

        // 画面切り替えのロジックを削除（updateUI() での同期完了を待つため）
        game.log("⚡ ホストとの接続が確立しました。入室リクエストを送ります...");
        
        // serialization: 'json' 設定時は、オブジェクトをそのまま送るだけでOK
        conn.send({
            type: "JOIN",
            id: window.myId, 
            name: myName || "ゲスト"
        });
    });

    conn.on("data", (data) => {
        let parsedData = data;
        if (typeof data === "string") {
            try { parsedData = JSON.parse(data); } catch(e) {}
        }
        handleGuestReceiveData(parsedData);
    });

    conn.on("close", () => {
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
        const joinBtn = document.getElementById("join-room-btn");
        if (joinBtn) joinBtn.disabled = false;
        if (connectionTimeout) clearTimeout(connectionTimeout);
    });
}

// サーバー待ち受け処理
window.activateHostMode = function() {
    const activePeer = window.peer || peer;
    if (!activePeer) return;
    
    activePeer.off("connection"); 
    
    activePeer.on("connection", (conn) => {
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

// 明示的な権限委譲シーケンス
export function transferHostPrivilege(newHostId) {
    if (!isHost) return;

    const targetPlayer = rawPlayerList.find(p => p.id === newHostId);
    const targetName = targetPlayer ? targetPlayer.name : "新ホスト";

    game.log(`🔄 ホスト権限を ${targetName} へ移行する手続きを開始しました...`);

    // 💡 【重要バグの完全修正】二重文字列化を避けるため、プレーンな生オブジェクトのまま引き渡す
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

    const payload = {
        type: "HOST_MIGRATION",
        newHostId: newHostId,
        newHostName: targetName,
        fullGameState: rawStateObject, // ❌ JSON.stringify(game) を廃止して生オブジェクトを配置
        rawPlayerList: rawPlayerList.map(p => {
            if (p.id === newHostId) p.isHost = true;
            if (p.id === window.myId) p.isHost = false;
            return p;
        })
    };

    isMigrating = true;

    guestConnections.forEach(conn => {
        if (conn.open) conn.send(payload); // 自動的にライブラリ側で綺麗にJSONシリアライズされます
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