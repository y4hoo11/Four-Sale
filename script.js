// script.js
import { game } from "./game-logic.js";
import { updateUI, hostStartGame, hostNextRound, injectCustomSettingsUIIntoGame, injectAbortButton } from "./ui-manager.js";
import { leaveRoom, setRawPlayerList, setConnections, setConnToHost, setIsHost, isHost, handleHostReceiveData, handleGuestReceiveData } from "./network-manager.js";

// 💡 ピアオブジェクトは network-manager.js 側と共有するため、初期は null に
export let peer = null;

document.addEventListener("DOMContentLoaded", () => {
    // 💡 ページを開いた時点で、network-manager.js のピア初期化を呼び出す（共通化のため）
    import("./network-manager.js").then(mod => {
        // 8桁のランダムな数字でPeerIDを生成
        const randomId = Math.floor(10000000 + Math.random() * 90000000).toString();
        
        // 💡 network-manager側で管理されている peer 変数に直接代入、またはwindow経由で初期化する
        // ※ network-manager.js 側でも扱えるよう、グローバルおよびモジュール間でIDを握り合わせます。
        window.myId = randomId;
        
        // ここで network-manager 側の初期化メソッドを直接叩くか、
        // network-manager 側の peer オブジェクトを script.js が生成して window に乗せます。
        // 今回はシンプルに、最初から利用する Peer オブジェクトを確実に 8桁数字 で固定します。
        const peerOptions = {
            config: {
                'iceServers': [
                    { url: 'stun:stun.l.google.com:19302' },
                    { url: 'stun:stun1.l.google.com:19302' },
                    { url: 'stun:stun2.l.google.com:19302' }
                ]
            }
        };
        
        // window.peer に入れて network-manager と共有できるようにします
        window.peer = new Peer(randomId, peerOptions);

        // シグナリングサーバーへの接続成功時
        window.peer.on('open', (id) => {
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
        window.peer.on('error', (err) => {
            console.error("PeerJS Connection Error:", err);
            const idDisplay = document.getElementById("my-peer-id");
            if (idDisplay) idDisplay.innerText = `❌ エラーが発生しました: ${err.type}`;
        });
    });

    // 各ボタンへのイベント紐付け
    document.getElementById("be-host-btn")?.addEventListener("click", beHost);
    document.getElementById("join-room-btn")?.addEventListener("click", joinRoom);
    document.getElementById("leave-room-btn")?.addEventListener("click", leaveRoom);
    document.getElementById("start-game-btn")?.addEventListener("click", hostStartGame);
    document.getElementById("next-round-btn")?.addEventListener("click", hostNextRound);
});

// 👑 ホストとしての接続待ち受けを起動する共通関数
export function startHostListening() {
    const activePeer = window.peer;
    if (!activePeer) return;

    // 既存のリスナーと重複しないよう一度リセットして再登録
    activePeer.off('connection');
    
    activePeer.on('connection', (conn) => {
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
// 外部モジュールから権限昇格時に呼べるようにwindowへ紐付け
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

    import("./network-manager.js").then(mod => {
        console.log("[DEBUG] network-manager.js の guestJoinRoom を呼び出します。");
        mod.guestJoinRoom(targetRoomId, window.myPlayerName);
    });
}