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
let isFirstSyncReceived = false;

// F12デバッグ用：いつでもコンソールから game を確認できるようにグローバル化
window.game = game;

// 💡 共通の接続安定化オプション（GoogleのパブリックSTUNサーバーを指定してタイムアウトを防ぐ）
const peerOptions = {
    serialization: 'json', // 💡 'none' ではなく 'json' に変更
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
                game.log(`🔄 ${data.name} が再接続・同期しました。`);

                if (game.isGameStarted && game.players) {
                    const gp = game.players.find(p => p.name === data.name);
                    if (gp) gp.id = data.id;
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

                    const isSpectator = game.isGameStarted;
                    rawPlayerList.push({
                        id: data.id,
                        name: finalName, // 被らない安全な名前を適用
                        spectator: isSpectator,
                        score: 0,
                        isHost: false, // 確実にゲスト（false）として追加
                        disconnected: false
                    });
                    
                    game.log(`👥 ${finalName} が入室しました。`);
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
            
            // 旧ホストから届いた「完全なゲーム状態」を退避（Peerリセットで消えないようにする）
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
                        const parsedGame = JSON.parse(backupGameState);
                        Object.assign(game, parsedGame);
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
        isFirstSyncReceived = true; // 同期完了をマーク
        
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

        // 💡 自動移行でホストになった場合のフォールバック（HOST_MIGRATIONが不発だった場合用）
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

    const payload = {
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
    };

    try {
        conn.send(payload);
    } catch (e) {
        console.error("送信エラー:", e);
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

// network-manager.js に追加してください

/**
 * 🗑️ ホスト用：「切断」状態のプレイヤーをルームから完全に削除する
 * 削除後、最新のリストを全ゲストへ同期します。
 */
export function hostRemoveDisconnectedPlayer(peerId) {
    if (!isHost) return;

    // 1. リストからターゲットを除外
    const target = rawPlayerList.find(p => p.id === peerId);
    if (target) {
        game.log(`🗑️ ${target.name} のデータがルームから削除されました。`);
    }
    
    // フィルターでリストを更新
    rawPlayerList = rawPlayerList.filter(p => p.id !== peerId);
    
    // 2. 削除後の最新状態を全員に通知する
    // これにより、ゲスト側でも表示が同期され、リストから該当者が消えます
    broadcastState();
    
    // 3. ホスト自身のUIを更新
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
    if (isHost) {
        const nextHost = rawPlayerList.find(p => p.id !== window.myId && !p.disconnected);
        if (nextHost) {
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
    // 💡 古いインスタンスがあればクリーンアップしてから生成
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

    // 💡 script.js で既に作成されている完璧な通信枠（window.peer）をそのまま利用する
    const activePeer = window.peer || peer; 
    
    if (!activePeer || activePeer.disconnected) {
        alert("ネットワークの準備ができていません。ページを再読み込みしてください。");
        return;
    }

    let connectionTimeout = null;
    setIsHost(false);

    game.log(`🏠 部屋 [ ${targetRoomId} ] へ接続を試みています...`);
    console.log(`[DEBUG 1] ${targetRoomId} に向けて activePeer.connect() を実行します。`);

    // 💡 ここで新しく作り直さず、既存の枠から直接コネクションを張る
    const conn = activePeer.connect(targetRoomId);
    setConnToHost(conn);
    
    console.log(`[DEBUG 2] conn オブジェクトの作成完了。`);

    // 🔥 3秒のセーフティタイマー（ホストがいない場合）
    connectionTimeout = setTimeout(() => {
        console.log(`[DEBUG ❌ TIMEOUT] 3秒間応答がありませんでした。`);
        game.log("<b style='color: red;'>❌ 入室失敗: ホストから応答がありません。部屋がまだ作成されていないか、IDが間違っています。</b>");
        
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
        if (connectionTimeout) clearTimeout(connectionTimeout);
    });
}

// 💡 改善されたサーバー待ち受け処理（移行時の再マッピング対応）
window.activateHostMode = function() {
    // 💡 window.peer を最優先で参照して一本化
    const activePeer = window.peer || peer;
    if (!activePeer) return;
    
    // 以前登録された古い connection リスナーをクリアして二重登録を防ぐ
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

// 💡 明示的な権限委譲シーケンス
export function transferHostPrivilege(newHostId) {
    if (!isHost) return;

    const targetPlayer = rawPlayerList.find(p => p.id === newHostId);
    const targetName = targetPlayer ? targetPlayer.name : "新ホスト";

    game.log(`🔄 ホスト権限を ${targetName} へ移行する手続きを開始しました...`);

    // 1. 新ホストに渡すための「完全なゲーム状態」をシリアライズ
    const fullGameState = JSON.stringify(game);

    // 2. 全員に「ホスト移行通知」と「完全な生データ」をブロードキャスト
    const payload = JSON.stringify({
        type: "HOST_MIGRATION",
        newHostId: newHostId,
        newHostName: targetName,
        fullGameState: fullGameState, 
        rawPlayerList: rawPlayerList.map(p => {
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

    // 💡 修正点2: タイミングバグの修正
    // 1.5秒待って、新ホストの開通完了＆他ゲストの離脱を待ってから旧ホストの再接続を行う
    setTimeout(() => {
        console.log("🔄 旧ホストのネットワーククリーンアップを実行します。");
        if (guestConnections) {
            guestConnections.forEach(c => {
                try { c.close(); } catch(e){}
            }); // 古い子機チャンネルを全切断
            guestConnections = [];
        }
        const myProfile = rawPlayerList.find(p => p.id === window.myId);
        const myName = myProfile ? myProfile.name : "旧ホスト";
        
        isMigrating = false;
        // 旧ホストも古いPeerオブジェクトがクリアされ、安全に新ホストへ子機として接続を試みる
        guestJoinRoom(newHostId, myName);
    }, 1500);
}

