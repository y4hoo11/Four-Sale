// script.js
import { game } from "./game-logic.js";
import { updateUI, hostStartGame, hostNextRound, hostAbortGame } from "./ui-manager.js";
import { leaveRoom, setIsHost, setRawPlayerList, guestJoinRoom } from "./network-manager.js";

// 💡 ピアオブジェクトは window.peer で一元管理します
document.addEventListener("DOMContentLoaded", () => {
    // 8桁のランダムな数字でPeerIDを生成
    const randomId = Math.floor(10000000 + Math.random() * 90000000).toString();
    
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
    // グローバルに1つだけ生成（UUID化を防ぐ）
    window.peer = new Peer(randomId, peerOptions);
    
    // 🔬 【原因特定ログ】window.myId の書き換えを常時監視する
    let _myId = randomId;
    Object.defineProperty(window, 'myId', {
        get() { return _myId; },
        set(newVal) {
            console.error(`🚨【警告】window.myId が ${_myId} から ${newVal} に上書きされました！`);
            console.trace("書き換えた犯人の追跡 (Trace):");
            _myId = newVal;
        },
        configurable: true
    });
    
    window.myId = randomId;

    // シグナリングサーバーへの接続成功時
    window.peer.on('open', (id) => {
        // 💡 起動時に自分のIDを緑のカプセルに一度だけセットします（以後、固定）
        const currentDisplay = document.getElementById("current-display-id");
        const parentDisplay = document.getElementById("my-peer-id");
        
        if (currentDisplay) {
            currentDisplay.innerText = `部屋ID: ${id} (クリックでコピー)`;
            if (parentDisplay) {
                parentDisplay.onclick = () => {
                    navigator.clipboard.writeText(id).then(() => {
                        const originalText = currentDisplay.innerText;
                        currentDisplay.innerText = "📋 コピーしました！";
                        setTimeout(() => currentDisplay.innerText = originalText, 1000);
                    }).catch(err => console.error("コピーに失敗しました:", err));
                };
            }
        }
    });

    // 接続エラーハンドリング
    window.peer.on('error', (err) => {
        console.error("PeerJS Connection Error:", err);
        const idDisplay = document.getElementById("current-display-id");
        if (idDisplay) idDisplay.innerText = `❌ エラーが発生しました: ${err.type}`;
    });

    // 各ボタンへのイベント紐付け
    document.getElementById("be-host-btn")?.addEventListener("click", beHost);
    document.getElementById("join-room-btn")?.addEventListener("click", joinRoom);
    
    // 待機ロビーとゲーム内、両方の離脱ボタンに処理を登録する
    const handleLeave = () => {
        if (!confirm("本当に部屋を離脱しますか？")) return;
        leaveRoom();
        
        // 💡 画面最上部の自分のID（緑カプセル）は書き換えないため、
        // ロビー内の「現在の部屋ID」の文字だけをリセットします。
        const lobbyDisplay = document.getElementById("lobby-current-room-id");
        if (lobbyDisplay) lobbyDisplay.textContent = "---- ----";
        
        updateUI();
    };
    
    document.getElementById("lobby-leave-btn")?.addEventListener("click", handleLeave);
    document.getElementById("leave-room-btn")?.addEventListener("click", handleLeave);
    document.getElementById("start-game-btn")?.addEventListener("click", hostStartGame);
    document.getElementById("next-round-btn")?.addEventListener("click", hostNextRound);
    document.getElementById("host-abort-btn")?.addEventListener("click", hostAbortGame);

    // 🏡 獲得物件一覧の表示オンオフ設定の初期連動
    const showOwnedCardsCheckbox = document.getElementById("setting-show-owned-cards");
    const ownedCardsPanel = document.getElementById("owned-cards-panel");
    if (showOwnedCardsCheckbox && ownedCardsPanel) {
        showOwnedCardsCheckbox.addEventListener("change", () => {
            ownedCardsPanel.style.display = showOwnedCardsCheckbox.checked ? "block" : "none";
        });
    }
});

// 👑 ホストとしての接続待ち受けを起動する共通関数
export function startHostListening() {
    if (!window.peer) return;

    window.peer.off('connection');
    window.peer.on('connection', (conn) => {
        import("./network-manager.js").then(mod => {
            mod.setConnections(conn);
            conn.on('open', () => {
                conn.on('data', (dataStr) => {
                    try {
                        const data = typeof dataStr === "string" ? JSON.parse(dataStr) : dataStr;
                        mod.handleHostReceiveData(conn, data);
                    } catch (e) {
                        console.error("ホストデータ処理エラー:", e);
                    }
                });
            });
        });
    });

    import("./ui-manager.js").then(mod => mod.injectAbortButton());
}
window.activateHostMode = startHostListening;

// 🏠 部屋を作る (初期ホスト処理)
function beHost() {
    const nameInput = document.getElementById("name-input");
    window.myPlayerName = nameInput ? nameInput.value.trim() : "ホスト";
    setIsHost(true);

    const initialList = [{ id: window.myId, name: window.myPlayerName, spectator: false, score: 0, isHost: true, disconnected: false }];
    setRawPlayerList(initialList);

    document.getElementById("setup-container").style.display = "none";
    document.getElementById("game-container").style.display = "block";

    // 💡 自分がホストになったので、ロビー内の「現在の部屋ID（赤文字）」に自分のIDを表示
    const lobbyDisplay = document.getElementById("lobby-current-room-id");
    if (lobbyDisplay) lobbyDisplay.textContent = window.myId;

    import("./ui-manager.js").then(mod => {
        if (typeof mod.renderCustomSettingsUI === "function") mod.renderCustomSettingsUI();
        else mod.injectCustomSettingsUIIntoGame();
    });
    
    startHostListening();
    updateUI();
    game.log(`🏠 部屋を作成しました。部屋IDを友達に共有してください。`);
}

// 🌐 部屋に入る (ゲスト処理)
function joinRoom() {
    console.log("🟢 [DEBUG 0] 入室ボタンがクリックされました！");

    const roomIdInput = document.getElementById("room-id-input");
    const targetRoomId = roomIdInput ? roomIdInput.value.trim() : "";
    
    if (targetRoomId.length !== 8 || isNaN(targetRoomId)) {
        alert("部屋IDは8桁の数字で入力してください。");
        return;
    }

    if (targetRoomId === window.myId) {
        alert("自分の部屋IDには入室できません。");
        return;
    }

    const nameInput = document.getElementById("name-input");
    window.myPlayerName = nameInput ? nameInput.value.trim() : "ゲスト";

    // 💡 画面最上部の自分の緑カプセルは一切変更せず、
    // ロビー内の「現在の部屋ID（赤文字）」に入室先ターゲットの部屋ID（相手のID）を同期させます。
    const lobbyDisplay = document.getElementById("lobby-current-room-id");
    if (lobbyDisplay) lobbyDisplay.textContent = targetRoomId;

    guestJoinRoom(targetRoomId, window.myPlayerName);
}

/**
 * 👑 現在のルームのホストIDを自動検出し、ロビーの部屋ID表示をリアルタイムに更新する関数
 * @param {Array} playerList - 現在の全プレイヤーリスト（省略された場合はwindow上のリスト等から取得を試みる）
 */
export function syncLobbyHostId(playerList) {
    const lobbyDisplay = document.getElementById("lobby-current-room-id");
    if (!lobbyDisplay) return;

    // 1. 引数で渡されたリスト、またはグローバルな領域からプレイヤーリストを探す
    const list = playerList || window.rawPlayerList || (window.game && window.game.players);
    if (!list || !Array.isArray(list)) return;

    // 2. リストの中から「isHost: true」のプレイヤーを探し出す
    const currentHost = list.find(p => p.isHost === true);

    // 3. 見つかったホストのIDをロビーの赤文字部分にリアルタイム反映
    if (currentHost && currentHost.id) {
        lobbyDisplay.textContent = currentHost.id;
    }
}
// 他のファイルから直接window経由でも呼べるようにグローバルに登録
window.syncLobbyHostId = syncLobbyHostId;