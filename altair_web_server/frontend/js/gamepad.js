/* ==========================================================================
   Altair Web Controller v2 - ゲームコントローラー変数化 ＆ モニター JavaScript
   機能: Web Gamepad API 連携, 入力周期送信 (20Hz), リアルタイムインプットモニター
   ========================================================================== */

document.addEventListener("DOMContentLoaded", () => {
  // コントローラ状態管理
  const state = {
    gamepadIdx: null,
    intervalId: null,
    prevButtons: [],
    axesCount: 4,
    buttonsCount: 16
  };

  const el = {
    indicator: document.getElementById("gamepad-status-indicator"),
    mappingsBody: document.getElementById("gamepad-mappings-body"),
    btnAddMapping: document.getElementById("btn-add-mapping"),
    terminal: document.getElementById("behavior-terminal")
  };

  // 直接マッピング追加ボタンなどは非表示またはラベル変更
  if (el.btnAddMapping) {
    el.btnAddMapping.style.display = "none"; // マッピング不要になったため非表示
  }

  // --- 1. Gamepad API イベントハンドリング ---
  window.addEventListener("gamepadconnected", (e) => {
    console.log("コントローラーが接続されました:", e.gamepad.id);
    state.gamepadIdx = e.gamepad.index;
    
    // UI表示の更新
    const icon = el.indicator.querySelector(".gamepad-icon");
    if (icon) icon.className = "fa-solid fa-gamepad gamepad-icon connected";
    
    const text = el.indicator.querySelector(".ctrl-status-text");
    if (text) text.textContent = `Connected: ${e.gamepad.id.substring(0, 24)}...`;

    appendLog(`[SYSTEM] コントローラーが接続されました: ${e.gamepad.id}`, "system-msg");

    // 周期（20Hz = 50ms）で WebSocket 送信＆モニター描画を行うタイマーを開始
    startGamepadPolling();
  });

  window.addEventListener("gamepaddisconnected", (e) => {
    if (state.gamepadIdx === e.gamepad.index) {
      console.log("コントローラーが切断されました。");
      state.gamepadIdx = null;
      
      // UIの初期化
      const icon = el.indicator.querySelector(".gamepad-icon");
      if (icon) icon.className = "fa-solid fa-gamepad gamepad-icon disconnected";
      
      const text = el.indicator.querySelector(".ctrl-status-text");
      if (text) text.textContent = "Not Connected (コントローラー未接続)";
      
      appendLog("[SYSTEM] コントローラーが切断されました。", "warning-msg");

      // タイマー停止
      stopGamepadPolling();
      renderDisconnectedMonitor();
    }
  });

  // --- 2. リアルタイムモニター表示の描画 ---
  function initMonitorTable() {
    if (!el.mappingsBody) return;
    el.mappingsBody.innerHTML = "";
    
    // アナログスティック軸モニター (4ch分)
    for (let i = 0; i < state.axesCount; i++) {
      let label = "";
      if (i === 0) label = "L-Stick 左右 (X)";
      else if (i === 1) label = "L-Stick 上下 (Y)";
      else if (i === 2) label = "R-Stick 左右 (X)";
      else if (i === 3) label = "R-Stick 上下 (Y)";
      else label = `Axis ${i}`;

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><i class="fa-solid fa-arrows-up-down-left-right"></i> ${label}</td>
        <td><code>self.gamepad.get_axis(${i})</code></td>
        <td colspan="3">
          <div class="progress-bar-container" style="background: #e8eaed; border-radius: 10px; height: 16px; width: 100%; position: relative; overflow: hidden;">
            <div id="monitor-axis-${i}" class="progress-bar" style="background: var(--color-primary); height: 100%; width: 50%; margin-left: 0; transition: width 0.05s ease; border-radius: 10px;"></div>
            <span id="monitor-axis-val-${i}" style="position: absolute; width: 100%; text-align: center; top: 0; font-size: 11px; font-weight: 700; color: #202124; line-height: 16px;">0.00</span>
          </div>
        </td>
      `;
      el.mappingsBody.appendChild(tr);
    }

    // 主要ボタンモニター (10ch分)
    const btnLabels = ["A / ×", "B / ○", "X / □", "Y / △", "L1", "R1", "L2", "R2", "Select / Share", "Start / Options"];
    for (let i = 0; i < btnLabels.length; i++) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><i class="fa-solid fa-circle-dot"></i> ${btnLabels[i]}</td>
        <td><code>self.gamepad.get_button(${i})</code></td>
        <td colspan="3">
          <span id="monitor-btn-${i}" class="badge badge-secondary">OFF</span>
        </td>
      `;
      el.mappingsBody.appendChild(tr);
    }
  }

  function renderDisconnectedMonitor() {
    if (!el.mappingsBody) return;
    el.mappingsBody.innerHTML = `
      <tr>
        <td colspan="5" style="text-align: center; color: var(--text-muted); padding: 30px 0;">
          <i class="fa-solid fa-gamepad" style="font-size: 32px; margin-bottom: 10px; display: block; color: var(--text-muted);"></i>
          コントローラーが接続されていません。ボタンやスティックの値を検出すると、ここにリアルタイムに値と変数名（Blocklyやコードで参照可能）が表示されます。
        </td>
      </tr>`;
  }

  // --- 3. コントローラー状態のサンプリング ＆ 送信タイマー ---
  function startGamepadPolling() {
    stopGamepadPolling();
    initMonitorTable();
    state.intervalId = setInterval(pollAndSendGamepad, 50); // 20Hz
  }

  function stopGamepadPolling() {
    if (state.intervalId) {
      clearInterval(state.intervalId);
      state.intervalId = null;
    }
  }

  function pollAndSendGamepad() {
    if (state.gamepadIdx === null) return;

    const gamepads = navigator.getGamepads();
    const gp = gamepads[state.gamepadIdx];
    if (!gp) return;

    // デッドバンド (遊び) を適用したスティック値の取得
    const DEADBAND = 0.05;
    const axesData = gp.axes.map(v => {
      let val = v;
      if (Math.abs(val) < DEADBAND) val = 0.0;
      return parseFloat(val.toFixed(3));
    });

    // ボタンの押し下げ状態の取得
    const buttonsData = gp.buttons.map(b => b.pressed);

    // WebSocket経由で操縦PC(ROS2ノード)へ送信
    const mainWs = window.appWs || window.parent.appWs;
    if (mainWs && mainWs.readyState === WebSocket.OPEN) {
      mainWs.send(JSON.stringify({
        type: "gamepad_state",
        axes: axesData,
        buttons: buttonsData
      }));
    }

    // 画面モニターの更新
    updateMonitorUI(axesData, buttonsData);
  }

  // リアルタイムインプットモニターの描画更新
  function updateMonitorUI(axes, buttons) {
    // 1. スティック軸の描画更新
    for (let i = 0; i < state.axesCount; i++) {
      const bar = document.getElementById(`monitor-axis-${i}`);
      const text = document.getElementById(`monitor-axis-val-${i}`);
      if (bar && text && i < axes.length) {
        const val = axes[i];
        // -1.0〜1.0 の値を progress のパーセンテージ幅に変換
        // -1.0 ➔ 0%、0 ➔ 50%、1.0 ➔ 100%
        const percent = ((val + 1.0) / 2.0) * 100;
        bar.style.width = `${percent}%`;
        text.textContent = val.toFixed(2);
        
        // ニュートラル(0)からの離脱によって色を変える
        if (Math.abs(val) > 0.1) {
          bar.style.backgroundColor = "var(--color-primary)";
        } else {
          bar.style.backgroundColor = "#bdc1c6";
        }
      }
    }

    // 2. ボタンの描画更新
    for (let i = 0; i < 10; i++) {
      const btnBadge = document.getElementById(`monitor-btn-${i}`);
      if (btnBadge && i < buttons.length) {
        const isPressed = buttons[i];
        if (isPressed) {
          btnBadge.textContent = "ON";
          btnBadge.className = "badge badge-success";
          btnBadge.style.boxShadow = "0 2px 4px rgba(19, 115, 51, 0.3)";
        } else {
          btnBadge.textContent = "OFF";
          btnBadge.className = "badge badge-secondary";
          btnBadge.style.boxShadow = "none";
        }
      }
    }
  }

  function appendLog(text, className = "") {
    if (el.terminal) {
      const line = document.createElement("div");
      line.className = `terminal-line ${className}`;
      line.textContent = `[CONTROLLER] ${text}`;
      el.terminal.appendChild(line);
      el.terminal.scrollTop = el.terminal.scrollHeight;
    }
  }

  // 初期化時の描画
  renderDisconnectedMonitor();
});
