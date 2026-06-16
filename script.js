// script.js
import { game } from "./game-logic.js";
import { updateUI, hostStartGame, hostNextRound } from "./ui-manager.js";
import { leaveRoom, setIsHost, setRawPlayerList, guestJoinRoom } from "./network-manager.js";

// 💡 ピアオブジェクトは window.peer で一元管理します
document.addEventListener("DOMContentLoaded", () => {
    // 8桁のランダムな数字でPeerIDを生成
    const randomId = Math.floor(10000000 + Math.random() * 90000000).toString();
    
    const peerOptions = {
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
    window.myId = randomId;

    // シグナリングサーバーへの接続成功時
    window.peer.on('open', (id) => {
        const idDisplay = document.getElementById("my-peer-id");
        if (idDisplay) {
            idDisplay.innerText = `部屋ID: ${id} (クリックでコピー)`;
            
            idDisplay.onclick = () => {
                navigator.clipboard.writeText(id).then(() => {
                    const originalText = idDisplay.innerText;
                    idDisplay.innerText = "📋 コピーしました！";
                    setTimeout(() => idDisplay.innerText = originalText, 1000);
                }).catch(err => {
                    console.error("コピー処理に失敗しました:", err);
                });
            };
        }
    });

    // 接続エラーハンドリング
    window.peer.on('error', (err) => {
        console.error("PeerJS Connection Error:", err);
        const idDisplay = document.getElementById("my-peer-id");
        if (idDisplay) idDisplay.innerText = `❌ エラーが発生しました: ${err.type}`;
    });

    // 各ボタンへのイベント紐付け
    document.getElementById("be-host-btn")?.addEventListener("click", beHost);
    document.getElementById("join-room-btn")?.addEventListener("click", joinRoom);
    document.getElementById("leave-room-btn")?.addEventListener("click", leaveRoom);
    document.getElementById("start-game-btn")?.addEventListener("click", hostStartGame);
    document.getElementById("next-round-btn")?.addEventListener("click", hostNextRound);

    // 💡 追加：ロビー画面内の離脱ボタンも既存の離脱ロジックを呼び出すように紐付け
    document.getElementById("lobby-leave-btn")?.addEventListener("click", leaveRoom);
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

    // 💡 修正：部屋作成時は game-container ではなく lobby-container を表示させる（実際の管理は updateUI で行うため、ここでは表示切替の準備のみ）
    document.getElementById("setup-container").style.display = "none";
    document.getElementById("lobby-container").style.display = "block";

    import("./ui-manager.js").then(mod => {
        if (typeof mod.renderCustomSettingsUI === "function") mod.renderCustomSettingsUI();
        else mod.injectCustomSettingsUIIntoGame();
    });
    
    startHostListening();
    updateUI(); // 💡 これにより、適切な待機状態のロビーがレンダリングされます
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

    // 💡 画面を切り替える権利を network-manager 側の「接続成功時」に委ねるため、ここではただ呼び出すだけ
    guestJoinRoom(targetRoomId, window.myPlayerName);
}