// script.js
import { game } from "./game-logic.js";
import { updateUI, hostStartGame, hostNextRound, hostAbortGame } from "./ui-manager.js";
import { leaveRoom, setIsHost, setRawPlayerList, guestJoinRoom } from "./network-manager.js";

// 💡 自分の本来のPeerIDを安全に保持しておくための変数
let originalMyId = "";

// 💡 ピアオブジェクトは window.peer で一元管理します
document.addEventListener("DOMContentLoaded", () => {
    // 8桁のランダムな数字でPeerIDを生成
    const randomId = Math.floor(10000000 + Math.random() * 90000000).toString();
    originalMyId = randomId; // 本来のIDを退避
    
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
        // 💡 共通の表示関数を呼び出すことで、CSSの見た目を崩さずに文字だけを安全に差し替えます
        updateIdDisplays(id, false);
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
        
        // 💡 離退時はIDを「自分自身の本来のID」に復元する（nullにしない）
        window.myId = originalMyId; 
        updateIdDisplays(originalMyId, false);
        
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

/**
 * 🆔 画面上の部屋ID表示を一括更新する共通関数
 * @param {string} id - 表示するID
 * @param {boolean} isGuestMode - ゲストとして参加中かどうか
 */
function updateIdDisplays(id, isGuestMode = false) {
    const parentDisplay = document.getElementById("my-peer-id");
    const currentDisplay = document.getElementById("current-display-id");
    const lobbyDisplay = document.getElementById("lobby-current-room-id");

    if (currentDisplay) {
        if (isGuestMode) {
            currentDisplay.innerHTML = `ゲストとして参加中 (部屋ID: <span style="font-weight: bold; text-decoration: underline;">${id}</span>)`;
            if (parentDisplay) parentDisplay.onclick = null; // ゲスト時はクリックコピーを一変無効化
        } else {
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
    }

    if (lobbyDisplay) {
        lobbyDisplay.textContent = id;
    }
}

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

    // 強制中断ボタンの配置
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

    // ホスト自身の画面のID表示を確定
    updateIdDisplays(window.myId, false);

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

    if (targetRoomId === originalMyId) {
        alert("自分の部屋IDには入室できません。");
        return;
    }

    const nameInput = document.getElementById("name-input");
    window.myPlayerName = nameInput ? nameInput.value.trim() : "ゲスト";

    // 💡 接続を試みるタイミングでホストのID表示に切り替える
    updateIdDisplays(targetRoomId, true);

    guestJoinRoom(targetRoomId, window.myPlayerName);
}