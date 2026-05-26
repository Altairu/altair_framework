/* ==========================================================================
   Altair Web Controller v2 - フロントエンド メイン JavaScript
   機能: ビュー切り替え, REST API通信, WebSocket双方向通信, 動的カード描画, プロファイル管理
   ========================================================================== */

document.addEventListener("DOMContentLoaded", () => {
  // アプリケーションの状態管理
  const state = {
    ws: null,
    wsUrl: `ws://${window.location.hostname}:8000/ws`,
    config: { modules: [] },
    ports: [],
    profiles: [],
    canConnected: false,
    behaviorStatus: "IDLE",
    controlMode: "SETUP", // SETUP (送信待ち), CONTROL (制御中)
    gamepadMappings: [], // コントローラーのマッピングデータ
  };

  // --- 1. DOM要素の取得 ---
  const el = {
    menuItems: document.querySelectorAll(".menu-item"),
    views: document.querySelectorAll(".content-view"),
    pageTitle: document.getElementById("page-title"),
    
    // 接続関連
    canStatusIndicator: document.getElementById("can-status-indicator"),
    chkAutoConnect: document.getElementById("chk-auto-connect"),
    selCanPort: document.getElementById("sel-can-port"),
    btnRefreshPorts: document.getElementById("btn-refresh-ports"),
    btnConnectCan: document.getElementById("btn-connect-can"),
    btnDisconnectCan: document.getElementById("btn-disconnect-can"),
    btnEmergencyStop: document.getElementById("btn-emergency-stop"),

    // パラメータ・モジュール管理
    btnSendParams: document.getElementById("btn-send-params"),
    lblControlModeStatus: document.getElementById("control-mode-status"),
    modulesContainer: document.getElementById("modules-container"),
    btnAddModuleModal: document.getElementById("btn-add-module-modal"),
    
    // プロファイル管理
    profileListUl: document.getElementById("profile-list-ul"),
    txtNewProfileName: document.getElementById("txt-new-profile-name"),
    btnSaveProfile: document.getElementById("btn-save-profile"),
    fileImportProfile: document.getElementById("file-import-profile"),
    btnExportProfile: document.getElementById("btn-export-profile"),

    // 動作プログラム(Behavior)関連
    selBehaviorScript: document.getElementById("sel-behavior-script"),
    btnStartBehavior: document.getElementById("btn-start-behavior"),
    btnStopBehavior: document.getElementById("btn-stop-behavior"),
    lblBehaviorStatus: document.getElementById("lbl-behavior-status"),
    behaviorTerminal: document.getElementById("behavior-terminal"),
    btnClearConsole: document.getElementById("btn-clear-console"),

    // システムログ関連
    canLogsTerminal: document.getElementById("can-logs-terminal"),
    btnClearCanLogs: document.getElementById("btn-clear-can-logs"),

    // モジュール追加モーダル
    modal: document.getElementById("add-module-modal"),
    btnCloseModal: document.getElementById("btn-close-modal"),
    btnCancelModal: document.getElementById("btn-cancel-modal"),
    btnSaveModule: document.getElementById("btn-save-module"),
    modalModuleType: document.getElementById("modal-module-type"),
    modalModuleName: document.getElementById("modal-module-name"),
    modalModuleId: document.getElementById("modal-module-id"),
    modalModuleDesc: document.getElementById("modal-module-desc"),
  };

  // --- 2. ビュー（画面）切り替えロジック ---
  el.menuItems.forEach(item => {
    item.addEventListener("click", (e) => {
      e.preventDefault();
      const targetId = item.getAttribute("data-target");

      // メニューの活性状態をトグル
      el.menuItems.forEach(i => i.classList.remove("active"));
      item.classList.add("active");

      // ビューの表示をトグル
      el.views.forEach(view => {
        if (view.id === targetId) {
          view.classList.add("active");
          el.pageTitle.textContent = item.textContent.trim();
        } else {
          view.classList.remove("active");
        }
      });
    });
  });

  // --- 3. WebSocket 接続管理 ＆ メッセージング ---
  function connectWebSocket() {
    console.log("WebSocket接続を開始します: ", state.wsUrl);
    state.ws = new WebSocket(state.wsUrl);

    state.ws.onopen = () => {
      console.log("WebSocket接続が確立されました。");
      window.appWs = state.ws; // コントローラー（gamepad.js）との連携用にグローバルに共有
    };

    state.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleWsMessage(msg);
      } catch (err) {
        console.error("受信データのパースに失敗しました:", err);
      }
    };

    state.ws.onclose = () => {
      console.warn("WebSocket接続が切断されました。2秒後に再接続を試みます...");
      setTimeout(connectWebSocket, 2000);
    };

    state.ws.onerror = (err) => {
      console.error("WebSocketエラーが発生しました:", err);
    };
  }

  // 受信メッセージのディスパッチ
  function handleWsMessage(msg) {
    const type = msg.type;
    const data = msg.data;

    switch (type) {
      case "can_status":
        updateCanStatusUI(data);
        break;

      case "behavior_status":
        updateBehaviorStatusUI(data);
        break;

      case "behavior_log":
        appendTerminalLog(el.behaviorTerminal, data);
        break;

      case "mdd_feedback":
        updateMddCardFeedback(msg.name, data);
        break;
      
      case "raw_can_frame": // システム全体のCANログ用
        appendCanLog(data);
        break;
    }
  }

  // --- 4. 接続状態UIの更新 ---
  function updateCanStatusUI(data) {
    state.canConnected = data.is_connected;
    const dot = el.canStatusIndicator.querySelector(".status-dot");
    const text = el.canStatusIndicator.querySelector(".status-text");

    if (data.is_connected) {
      dot.className = "status-dot connected";
      text.textContent = `CAN: Connected (${data.active_port})`;
      el.btnConnectCan.disabled = true;
      el.btnDisconnectCan.disabled = false;
    } else {
      dot.className = "status-dot disconnected";
      text.textContent = "CAN: Disconnected";
      el.btnConnectCan.disabled = false;
      el.btnDisconnectCan.disabled = true;
      
      if (data.error_message) {
        appendTerminalLog(el.behaviorTerminal, `[CAN ERROR] ${data.error_message}`, "error-msg");
      }
    }
  }

  // --- 5. 動作プログラム状態UIの更新 ---
  function updateBehaviorStatusUI(status) {
    state.behaviorStatus = status;
    el.lblBehaviorStatus.textContent = status;
    
    // バッジ色の変更
    if (status.includes("RUNNING")) {
      el.lblBehaviorStatus.className = "badge badge-success";
      el.btnStartBehavior.disabled = true;
      el.btnStopBehavior.disabled = false;
    } else if (status === "IDLE") {
      el.lblBehaviorStatus.className = "badge badge-secondary";
      el.btnStartBehavior.disabled = false;
      el.btnStopBehavior.disabled = true;
    } else {
      el.lblBehaviorStatus.className = "badge badge-warning";
      el.btnStartBehavior.disabled = false;
      el.btnStopBehavior.disabled = true;
    }
  }

  // --- 6. コンソールロギングヘルパー ---
  function appendTerminalLog(terminal, text, className = "") {
    const line = document.createElement("div");
    line.className = `terminal-line ${className}`;
    line.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
    terminal.appendChild(line);
    
    // 最大300行に制限
    while (terminal.childElementCount > 300) {
      terminal.removeChild(terminal.firstChild);
    }
    
    // スクロール追従
    terminal.scrollTop = terminal.scrollHeight;
  }

  // --- 7. モジュール構成 (config) のロードとレンダリング ---
  async function loadConfigAndRender() {
    try {
      const res = await fetch("/api/config");
      state.config = await res.json();
      
      renderModuleCards();
    } catch (err) {
      console.error("モジュール設定のロードに失敗しました:", err);
    }
  }

  function renderModuleCards() {
    el.modulesContainer.innerHTML = ""; // クリア

    if (state.config.modules.length === 0) {
      el.modulesContainer.innerHTML = `
        <div class="glass-card page-card" style="grid-column: 1/-1; text-align: center; padding: 40px;">
          <i class="fa-solid fa-folder-open" style="font-size: 48px; color: var(--text-muted); margin-bottom: 15px;"></i>
          <p>登録されている制御モジュールはありません。右上の「Add Module」から追加してください。</p>
        </div>`;
      return;
    }

    state.config.modules.forEach(mod => {
      const card = document.createElement("div");
      card.className = `glass-card module-card module-card-${mod.type}`;
      card.id = `module-card-${mod.name}`;

      // 各モジュールタイプに応じた内部HTMLの生成
      let contentHtml = "";

      if (mod.type === "mdd") {
        contentHtml = renderMddCardHtml(mod);
      } else if (mod.type === "servo") {
        contentHtml = renderServoCardHtml(mod);
      } else if (mod.type === "solenoid") {
        contentHtml = renderSolenoidCardHtml(mod);
      }

      card.innerHTML = `
        <div class="card-header-row">
          <div class="module-title">
            <h2>${mod.name}</h2>
            <div class="module-meta-info">
              <span>ID: ${mod.base_id}</span>
              <span>Type: ${mod.type.toUpperCase()}</span>
            </div>
          </div>
          <div class="card-actions">
            <button class="btn btn-secondary btn-icon btn-xs" onclick="editModule('${mod.name}')" title="設定編集">
              <i class="fa-solid fa-pen-to-square"></i>
            </button>
            <button class="btn btn-danger btn-icon btn-xs" onclick="deleteModule('${mod.name}')" title="削除">
              <i class="fa-solid fa-trash"></i>
            </button>
          </div>
        </div>
        <div class="card-body">
          ${contentHtml}
        </div>
      `;

      el.modulesContainer.appendChild(card);
      
      // イベントリスナーの動的設定
      bindCardEvents(mod);
    });
  }

  // --- MDDカードレンダリング ---
  function renderMddCardHtml(mod) {
    let slidersHtml = "";
    for (let i = 1; i <= 4; i++) {
      slidersHtml += `
        <div class="control-slider-group mt-2">
          <div class="slider-label-row">
            <span class="slider-name">Motor ${i} Goal</span>
            <span class="slider-val" id="val-${mod.name}-m${i}">0.0 rps</span>
          </div>
          <input type="range" class="custom-range range-mdd" data-module="${mod.name}" data-motor="${i}" 
                 min="-10" max="10" step="0.1" value="0" id="range-${mod.name}-m${i}">
        </div>`;
    }

    return `
      <!-- モータ目標値スライダー -->
      <div class="mdd-sliders">
        ${slidersHtml}
      </div>
      
      <!-- PID等の内部パラメータ表示 -->
      <div class="mdd-params-grid mt-3">
        <div class="mdd-param-item">M1 mode: <span id="lbl-${mod.name}-m1-mode">-</span></div>
        <div class="mdd-param-item">M2 mode: <span id="lbl-${mod.name}-m2-mode">-</span></div>
        <div class="mdd-param-item">M1 PID: <span id="lbl-${mod.name}-m1-pid">-</span></div>
        <div class="mdd-param-item">M2 PID: <span id="lbl-${mod.name}-m2-pid">-</span></div>
      </div>

      <!-- Limitスイッチインジケータ -->
      <div class="switches-section mt-3">
        <h4 style="font-size: 13px; margin-bottom: 8px;">Limit Switches</h4>
        <div class="switches-row">
          <div class="sw-indicator" id="sw-${mod.name}-1">SW 1</div>
          <div class="sw-indicator" id="sw-${mod.name}-2">SW 2</div>
          <div class="sw-indicator" id="sw-${mod.name}-3">SW 3</div>
          <div class="sw-indicator" id="sw-${mod.name}-4">SW 4</div>
        </div>
      </div>

      <!-- エンコーダ実測データ表示 -->
      <div class="mdd-params-grid mt-3">
        <div class="mdd-param-item">M1 Ang/Spd: <span id="lbl-${mod.name}-m1-fb">0.0° / 0.0</span></div>
        <div class="mdd-param-item">M2 Ang/Spd: <span id="lbl-${mod.name}-m2-fb">0.0° / 0.0</span></div>
        <div class="mdd-param-item">M3 Ang/Spd: <span id="lbl-${mod.name}-m3-fb">0.0° / 0.0</span></div>
        <div class="mdd-param-item">M4 Ang/Spd: <span id="lbl-${mod.name}-m4-fb">0.0° / 0.0</span></div>
      </div>
    `;
  }

  // --- Servoカードレンダリング ---
  function renderServoCardHtml(mod) {
    let slidersHtml = "";
    for (let i = 1; i <= 6; i++) {
      slidersHtml += `
        <div class="control-slider-group mt-2">
          <div class="slider-label-row">
            <span class="slider-name">Servo ${i}</span>
            <span class="slider-val" id="val-${mod.name}-s${i}">90°</span>
          </div>
          <input type="range" class="custom-range range-servo" data-module="${mod.name}" data-servo="${i}" 
                 min="0" max="180" value="90" id="range-${mod.name}-s${i}">
        </div>`;
    }
    return slidersHtml;
  }

  // --- Solenoidカードレンダリング ---
  function renderSolenoidCardHtml(mod) {
    let buttonsHtml = "";
    for (let i = 1; i <= 12; i++) {
      buttonsHtml += `<button class="valve-btn btn-solenoid" data-module="${mod.name}" data-channel="${i}" id="btn-${mod.name}-v${i}">V${i}</button>`;
    }
    return `
      <div class="valves-grid">
        ${buttonsHtml}
      </div>
    `;
  }

  // --- モジュール操作イベントのバインディング ---
  function bindCardEvents(mod) {
    if (mod.type === "mdd") {
      // MDDスライダーのドラッグイベント
      const sliders = document.querySelectorAll(`.range-mdd[data-module="${mod.name}"]`);
      sliders.forEach(slider => {
        slider.addEventListener("input", (e) => {
          const motorIdx = e.target.getAttribute("data-motor");
          const valEl = document.getElementById(`val-${mod.name}-m${motorIdx}`);
          
          // モード表示の読み込み
          const mode = mod.parameters?.[`m${motorIdx}`]?.mode ?? 0;
          const unit = mode === 0 ? "rps" : mode === 1 ? "deg" : "mm";
          valEl.textContent = `${parseFloat(e.target.value).toFixed(1)} ${unit}`;

          // WebSocket経由で指令送信
          sendMddTargetCommand(mod.name);
        });
      });

      // 設定パラメータのカードへの初期描画
      for (let i = 1; i <= 4; i++) {
        const motorParam = mod.parameters?.[`m${i}`] ?? { mode: 0, p: 1.0, i: 0.0, d: 0.0 };
        const modeText = motorParam.mode === 0 ? "Speed" : motorParam.mode === 1 ? "Angle" : "Pos";
        
        // M1, M2のみ簡易表示
        if (i <= 2) {
          const modeEl = document.getElementById(`lbl-${mod.name}-m${i}-mode`);
          const pidEl = document.getElementById(`lbl-${mod.name}-m${i}-pid`);
          if (modeEl) modeEl.textContent = modeText;
          if (pidEl) pidEl.textContent = `P:${motorParam.p} I:${motorParam.i}`;
        }
      }

    } else if (mod.type === "servo") {
      // サーボスライダーのドラッグイベント
      const sliders = document.querySelectorAll(`.range-servo[data-module="${mod.name}"]`);
      sliders.forEach(slider => {
        slider.addEventListener("input", (e) => {
          const servoIdx = e.target.getAttribute("data-servo");
          const valEl = document.getElementById(`val-${mod.name}-s${servoIdx}`);
          valEl.textContent = `${e.target.value}°`;

          // 即時送信
          sendServoAngleCommand(mod.name);
        });
      });

    } else if (mod.type === "solenoid") {
      // ソレノイドバルブのON/OFFトグルイベント
      const btns = document.querySelectorAll(`.btn-solenoid[data-module="${mod.name}"]`);
      btns.forEach(btn => {
        btn.addEventListener("click", (e) => {
          btn.classList.toggle("active");
          
          // 即時送信
          sendSolenoidCommand(mod.name);
        });
      });
    }
  }

  // --- WebSocket 指令送信ロジック ---
  function sendMddTargetCommand(moduleName) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;

    // 4つのスライダー値を取得
    const targets = [];
    for (let i = 1; i <= 4; i++) {
      const slider = document.getElementById(`range-${moduleName}-m${i}`);
      targets.push(parseFloat(slider.value));
    }

    const payload = {
      type: "mdd_cmd",
      name: moduleName,
      targets: targets
    };
    state.ws.send(JSON.stringify(payload));
  }

  function sendServoAngleCommand(moduleName) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;

    const angles = [];
    for (let i = 1; i <= 6; i++) {
      const slider = document.getElementById(`range-${moduleName}-s${i}`);
      angles.push(parseInt(slider.value));
    }

    const payload = {
      type: "servo_cmd",
      name: moduleName,
      angles: angles
    };
    state.ws.send(JSON.stringify(payload));
  }

  function sendSolenoidCommand(moduleName) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;

    const valves = [];
    for (let i = 1; i <= 12; i++) {
      const btn = document.getElementById(`btn-${moduleName}-v${i}`);
      valves.push(btn.classList.contains("active"));
    }

    const payload = {
      type: "solenoid_cmd",
      name: moduleName,
      valves: valves
    };
    state.ws.send(JSON.stringify(payload));
  }

  // --- 8. WebSocket テレメトリ（フィードバック）のカード反映 ---
  function updateMddCardFeedback(name, data) {
    // Limitスイッチ
    for (let i = 0; i < 4; i++) {
      const swEl = document.getElementById(`sw-${name}-${i+1}`);
      if (swEl) {
        if (data.limit_switches[i]) {
          swEl.classList.add("active");
        } else {
          swEl.classList.remove("active");
        }
      }
    }

    // エンコーダフィードバック (角度 ＆ 速度)
    for (let i = 0; i < 4; i++) {
      const fbEl = document.getElementById(`lbl-${name}-m${i+1}-fb`);
      if (fbEl) {
        const ang = data.angles[i].toFixed(1);
        const spd = data.speeds[i].toFixed(2);
        fbEl.textContent = `${ang}° / ${spd} rps`;
      }
    }

    // エラー状態のチェック
    if (data.error_code > 0) {
      const card = document.getElementById(`module-card-${name}`);
      card.style.borderColor = "var(--color-danger)";
    } else {
      const card = document.getElementById(`module-card-${name}`);
      if (card) card.style.borderColor = "var(--border-light)";
    }
  }

  // --- 9. ポート一覧 ＆ CAN接続制御 ---
  async function refreshPorts() {
    try {
      const res = await fetch("/api/ports");
      const data = await res.json();
      state.ports = data.ports;

      el.selCanPort.innerHTML = "";
      if (state.ports.length === 0) {
        el.selCanPort.innerHTML = '<option value="">ポート未検出</option>';
        return;
      }

      state.ports.forEach(port => {
        const opt = document.createElement("option");
        opt.value = port;
        opt.textContent = port;
        el.selCanPort.appendChild(opt);
      });
    } catch (err) {
      console.error("ポート取得失敗:", err);
    }
  }

  el.btnRefreshPorts.addEventListener("click", refreshPorts);

  // 自動探索チェックボックスの挙動
  el.chkAutoConnect.addEventListener("change", (e) => {
    const isAuto = e.target.checked;
    el.selCanPort.disabled = isAuto;
    el.btnRefreshPorts.disabled = isAuto;
  });

  // 接続ボタン
  el.btnConnectCan.addEventListener("click", async () => {
    const auto = el.chkAutoConnect.checked;
    const port = el.selCanPort.value;

    appendTerminalLog(el.behaviorTerminal, "USB-to-CAN 接続要求を送信中...");
    
    try {
      const res = await fetch("/api/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ port: port, auto_connect: auto })
      });
      const data = await res.json();
      
      if (data.success) {
        appendTerminalLog(el.behaviorTerminal, `[SYSTEM] ${data.message}`, "system-msg");
      } else {
        appendTerminalLog(el.behaviorTerminal, `[ERROR] ${data.message}`, "error-msg");
      }
    } catch (err) {
      appendTerminalLog(el.behaviorTerminal, `[ERROR] 通信に失敗しました: ${err}`, "error-msg");
    }
  });

  // 切断ボタン
  el.btnDisconnectCan.addEventListener("click", async () => {
    appendTerminalLog(el.behaviorTerminal, "USB-to-CAN 切断要求を送信中...");
    try {
      const res = await fetch("/api/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ port: "", auto_connect: false }) // 空で送ると切断
      });
      const data = await res.json();
      appendTerminalLog(el.behaviorTerminal, `[SYSTEM] ${data.message}`, "system-msg");
    } catch (err) {
      appendTerminalLog(el.behaviorTerminal, `[ERROR] 通信失敗: ${err}`, "error-msg");
    }
  });

  // パラメータ送信 ＆ 制御開始
  el.btnSendParams.addEventListener("click", async () => {
    appendTerminalLog(el.behaviorTerminal, "制御パラメータ送信中...");
    try {
      const res = await fetch("/api/start_control", { method: "POST" });
      const data = await res.json();
      
      if (data.success) {
        appendTerminalLog(el.behaviorTerminal, "[SYSTEM] パラメータ送信成功。制御実行状態になりました！", "system-msg");
        el.lblControlModeStatus.innerHTML = 'ステータス: <span class="badge badge-success">制御実行中 (Control Mode)</span>';
        state.controlMode = "CONTROL";
      } else {
        appendTerminalLog(el.behaviorTerminal, `[ERROR] 送信失敗: ${data.message}`, "error-msg");
      }
    } catch (err) {
      appendTerminalLog(el.behaviorTerminal, `[ERROR] 通信失敗: ${err}`, "error-msg");
    }
  });

  // --- 10. プロファイル管理処理 ---
  async function refreshProfiles() {
    try {
      const res = await fetch("/api/profiles");
      const data = await res.json();
      state.profiles = data.profiles;

      el.profileListUl.innerHTML = "";
      if (state.profiles.length === 0) {
        el.profileListUl.innerHTML = '<li class="profile-item">プロファイルはありません。</li>';
        return;
      }

      state.profiles.forEach(pname => {
        const li = document.createElement("li");
        li.className = "profile-item";
        li.innerHTML = `
          <div class="profile-name-sec">
            <i class="fa-solid fa-file-invoice"></i>
            <span>${pname}</span>
          </div>
          <div class="profile-actions">
            <button class="btn btn-primary btn-xs" onclick="loadProfile('${pname}')">適用</button>
            <button class="btn btn-danger btn-xs" onclick="deleteProfileFile('${pname}')">削除</button>
          </div>
        `;
        el.profileListUl.appendChild(li);
      });
    } catch (err) {
      console.error("プロファイル取得失敗:", err);
    }
  }

  // プロファイルのロード（グローバル関数化）
  window.loadProfile = async (name) => {
    appendTerminalLog(el.behaviorTerminal, `プロファイル '${name}' をロード中...`);
    try {
      const res = await fetch(`/api/profiles/load?name=${name}`, { method: "POST" });
      const data = await res.json();
      appendTerminalLog(el.behaviorTerminal, `[SYSTEM] ${data.message}`, "system-msg");
      
      // 設定ファイルを再読み込みしてDashboardを更新
      await loadConfigAndRender();
    } catch (err) {
      appendTerminalLog(el.behaviorTerminal, `[ERROR] ロード失敗: ${err}`, "error-msg");
    }
  };

  // プロファイル新規保存
  el.btnSaveProfile.addEventListener("click", async () => {
    const name = el.txtNewProfileName.value.trim();
    if (!name) return;

    appendTerminalLog(el.behaviorTerminal, `現在の構成をプロファイル '${name}' として保存中...`);
    try {
      const res = await fetch(`/api/profiles/save?name=${name}`, { method: "POST" });
      const data = await res.json();
      appendTerminalLog(el.behaviorTerminal, `[SYSTEM] ${data.message}`, "system-msg");
      
      el.txtNewProfileName.value = "";
      refreshProfiles();
    } catch (err) {
      appendTerminalLog(el.behaviorTerminal, `[ERROR] 保存失敗: ${err}`, "error-msg");
    }
  });

  // プロファイルエクスポート
  el.btnExportProfile.addEventListener("click", async () => {
    try {
      const res = await fetch("/api/config");
      const configData = await res.json();
      
      const blob = new Blob([JSON.stringify(configData, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      
      const a = document.createElement("a");
      a.href = url;
      a.download = "modules_config.json";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("エクスポート失敗:", err);
    }
  });

  // プロファイルインポート
  el.fileImportProfile.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const configData = JSON.parse(event.target.result);
        
        // サーバーの設定を上書き更新
        const res = await fetch("/api/config/update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(configData)
        });
        const data = await res.json();
        
        appendTerminalLog(el.behaviorTerminal, `[SYSTEM] 設定ファイルをインポートしました: ${data.message}`, "system-msg");
        await loadConfigAndRender();
      } catch (err) {
        alert("インポートに失敗しました。JSONファイルの構造が正しいか確認してください。");
      }
    };
    reader.readAsText(file);
  });

  // --- 11. 動作プログラム(Behavior)の起動 ＆ 停止制御 ---
  el.btnStartBehavior.addEventListener("click", async () => {
    const script = el.selBehaviorScript.value;
    appendTerminalLog(el.behaviorTerminal, `プログラム '${script}' の起動要求を送信...`);
    try {
      const res = await fetch("/api/behavior/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ behavior_name: script })
      });
      const data = await res.json();
      if (data.success) {
        appendTerminalLog(el.behaviorTerminal, `[SYSTEM] ${data.message}`, "system-msg");
      } else {
        appendTerminalLog(el.behaviorTerminal, `[ERROR] ${data.message}`, "error-msg");
      }
    } catch (err) {
      appendTerminalLog(el.behaviorTerminal, `[ERROR] 通信エラー: ${err}`, "error-msg");
    }
  });

  el.btnStopBehavior.addEventListener("click", async () => {
    appendTerminalLog(el.behaviorTerminal, "プログラム停止要求を送信...");
    try {
      const res = await fetch("/api/behavior/stop", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        appendTerminalLog(el.behaviorTerminal, `[SYSTEM] ${data.message}`, "system-msg");
      } else {
        appendTerminalLog(el.behaviorTerminal, `[ERROR] ${data.message}`, "error-msg");
      }
    } catch (err) {
      appendTerminalLog(el.behaviorTerminal, `[ERROR] 通信エラー: ${err}`, "error-msg");
    }
  });

  el.btnClearConsole.addEventListener("click", () => {
    el.behaviorTerminal.innerHTML = '<div class="terminal-line system-msg">[SYSTEM] ターミナルをクリアしました。</div>';
  });

  // --- 12. モジュール動的削除 ＆ 編集用（グローバル定義） ---
  window.deleteModule = async (name) => {
    if (!confirm(`本当にモジュール '${name}' を削除しますか？`)) return;

    // 設定ファイルから除外して更新
    state.config.modules = state.config.modules.filter(m => m.name !== name);
    
    try {
      const res = await fetch("/api/config/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state.config)
      });
      const data = await res.json();
      appendTerminalLog(el.behaviorTerminal, `モジュールを削除しました: ${data.message}`);
      await loadConfigAndRender();
    } catch (err) {
      console.error("モジュール削除失敗:", err);
    }
  };

  // モーダル制御
  el.btnAddModuleModal.addEventListener("click", () => {
    el.modal.classList.add("active");
  });

  el.btnCloseModal.addEventListener("click", closeModal);
  el.btnCancelModal.addEventListener("click", closeModal);

  function closeModal() {
    el.modal.classList.remove("active");
    // フォームクリア
    el.modalModuleName.value = "";
    el.modalModuleId.value = "";
    el.modalModuleDesc.value = "";
  }

  el.btnSaveModule.addEventListener("click", async () => {
    const type = el.modalModuleType.value;
    const name = el.modalModuleName.value.trim();
    const id = el.modalModuleId.value.trim();
    const desc = el.modalModuleDesc.value.trim();

    if (!name || !id) {
      alert("名前とBase CAN IDは必須です。");
      return;
    }

    // 重複チェック
    if (state.config.modules.some(m => m.name === name)) {
      alert("すでに同じ名前のモジュールが存在します。");
      return;
    }

    // 新規モジュールオブジェクト
    const newMod = {
      name: name,
      type: type,
      base_id: id,
      description: desc
    };

    // MDD特有の初期パラメータ構造を追加
    if (type === "mdd") {
      newMod.parameters = {
        m1: { p: 1.5, i: 0.1, d: 0.05, diameter: 100.0, direction: 1, mode: 0 },
        m2: { p: 1.5, i: 0.1, d: 0.05, diameter: 100.0, direction: 1, mode: 0 },
        m3: { p: 1.5, i: 0.1, d: 0.05, diameter: 100.0, direction: 1, mode: 0 },
        m4: { p: 1.5, i: 0.1, d: 0.05, diameter: 100.0, direction: 1, mode: 0 }
      };
    }

    state.config.modules.push(newMod);

    try {
      const res = await fetch("/api/config/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state.config)
      });
      const data = await res.json();
      appendTerminalLog(el.behaviorTerminal, `モジュールを追加しました: ${data.message}`);
      
      closeModal();
      await loadConfigAndRender();
    } catch (err) {
      console.error("モジュール追加失敗:", err);
    }
  });

  // 非常停止
  el.btnEmergencyStop.addEventListener("click", async () => {
    appendTerminalLog(el.behaviorTerminal, "🚨 [EMERGENCY STOP] 非常停止コマンドを発行しました！", "error-msg");
    // 全指令を停止するために WebSocket に停止要求を一括送信
    state.config.modules.forEach(mod => {
      if (mod.type === "mdd") {
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
          state.ws.send(JSON.stringify({ type: "mdd_cmd", name: mod.name, targets: [0, 0, 0, 0] }));
        }
      } else if (mod.type === "solenoid") {
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
          state.ws.send(JSON.stringify({ type: "solenoid_cmd", name: mod.name, valves: [false]*12 }));
        }
      }
    });

    // 動作プログラムの強制終了
    await fetch("/api/behavior/stop", { method: "POST" });
  });

  // --- 13. 初期化処理の実行 ---
  connectWebSocket();
  loadConfigAndRender();
  refreshPorts();
  refreshProfiles();
});
