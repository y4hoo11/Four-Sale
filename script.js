// script.js
import { game } from "./game-logic.js";
import { updateUI, hostStartGame, hostNextRound, injectCustomSettingsUIIntoGame, injectAbortButton } from "./ui-manager.js";
import { leaveRoom, setRawPlayerList, setConnections, setConnToHost, setIsHost, isHost, handleHostReceiveData, handleGuestReceiveData } from "./network-manager.js";

// 他のファイルからも新ホストへの移行時に呼び出せるようにグローバル(window)に登録
let peer = null;

document.addEventListener("DOMContentLoaded", () => {
    // 8桁のランダムな数字でPeerIDを生成
    const randomId = Math.floor(10000000 + Math.random() * 90000000).toString();
    peer = new Peer(randomId);

    // シグナリングサーバーへの接続成功時
    peer.on('open', (id) => {
        window.myId = id; 
        const idDisplay = document.getElementById("my-peer-id");
        if (idDisplay) {
            idDisplay.innerText = `部屋ID: ${id} (クリックでコピー)`;
            
            // クリップボードへのコピーイベント
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
    peer.on('error', (err) => {
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
});

// 👑 ホストとしての接続待ち受けを起動する共通関数
//（最初からホストの時だけでなく、途中で権限譲渡された時にも自動実行されます）
export function startHostListening() {
    if (!peer) return;

    // 既存のリスナーと重複しないよう一度リセットして再登録
    peer.off('connection');
    
    peer.on('connection', (conn) => {
        setConnections(conn);
        
        conn.on('open', () => {
            conn.on('data', (dataStr) => {
                try {
                    const data = typeof dataStr === "string" ? JSON.parse(dataStr) : dataStr;
                    handleHostReceiveData(conn, data);
                } catch (e) {
                    console.error("ホストデータ処理エラー:", e);
                }
            });
        });
    });

    // ホスト用のUIパーツ（強制中断ボタンなど）を確実に配置
    injectAbortButton();
}
// 外部モジュール（network-managerなど）から権限昇格時に呼べるようにwindowへ紐付け
window.activateHostMode = startHostListening;

// 🏠 部屋を作る (初期ホスト処理)
function beHost() {
    const nameInput = document.getElementById("name-input");
    window.myPlayerName = nameInput ? nameInput.value.trim() : "ホスト";
    setIsHost(true);

    // 自分自身（ホスト）をメンバー名簿に初期登録
    const initialList = [{ id: window.myId, name: window.myPlayerName, spectator: false, score: 0, isHost: true, disconnected: false }];
    setRawPlayerList(initialList);

    // 画面切り替え
    document.getElementById("setup-container").style.display = "none";
    document.getElementById("game-container").style.display = "block";

    // ホスト用のカスタムUIを非同期で構築
    import("./ui-manager.js").then(mod => {
        if (typeof mod.renderCustomSettingsUI === "function") {
            mod.renderCustomSettingsUI();
        } else {
            mod.injectCustomSettingsUIIntoGame();
        }
    });
    
    // 待ち受け開始
    startHostListening();
    
    // UI反映
    updateUI();
    game.log(`🏠 部屋を作成しました。部屋IDを友達に共有してください。`);
}

// 🌐 部屋に入る (ゲスト処理)
function joinRoom() {
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
    setIsHost(false);

    game.log(`🌐 部屋 [${targetRoomId}] に接続を試みています...`);

    const conn = peer.connect(targetRoomId);
    setConnToHost(conn);

    conn.on('open', () => {
        game.log(`🟢 ホストに接続しました！認証中...`);
        // ホストに自身のプレイヤー情報を送信
        conn.send(JSON.stringify({
            type: "JOIN",
            id: window.myId,
            name: window.myPlayerName
        }));

        document.getElementById("setup-container").style.display = "none";
        document.getElementById("game-container").style.display = "block";
    });

    conn.on('data', (dataStr) => {
        try {
            const data = typeof dataStr === "string" ? JSON.parse(dataStr) : dataStr;
            handleGuestReceiveData(data);
        } catch (e) {
            console.error("ゲストデータ処理エラー:", e);
        }
    });

    conn.on('close', () => {
        // 自分が新ホストに昇格して通信が切れたケースを除外してリロード
        if (!window.isHostMigrated) {
            alert("ホストとの接続が切断されました。");
            window.location.reload();
        }
    });
}