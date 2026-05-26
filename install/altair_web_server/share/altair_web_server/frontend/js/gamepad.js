/* ==========================================================================
   Altair Web Controller v2 - ゲームコントローラー連携 JavaScript
   機能: Web Gamepad API 連携, 入力ポーリング(60Hz), 操作マッピングの管理
   ========================================================================== */

document.addEventListener("DOMContentLoaded", () => {
  // コントローラ状態管理
  const state = {
    gamepadIdx: null,
    animationFrameId: null,
    mappings: [
      // 初期サンプルマッピング
      { input: "axis-1", module: "drive_mdd", action: "mdd_speed_y", scale: -5.0 }, // 左スティックY軸で前後走行
      { input: "axis-0", module: "drive_mdd", action: "mdd_speed_x", scale: 5.0 },  // 左スティックX軸で左右旋回
      { input: "btn-0", module: "valve_controller", action: "valve_toggle", channel: 1 } // ×ボタンでバルブ1トグル
    ],
    // ボタンの押し下げをトグル処理するための前状態キャッシュ
    prevButtons: {}
  };

  const el = {
    indicator: document.getElementById("gamepad-status-indicator"),
    mappingsBody: document.getElementById("gamepad-mappings-body"),
    btnAddMapping: document.getElementById("btn-add-mapping"),
    terminal: document.getElementById("behavior-terminal")
  };

  // --- 1. Gamepad API イベントハンドリング ---
  window.addEventListener("gamepadconnected", (e) => {
    console.log("コントローラーが接続されました:", e.gamepad.id);
    state.gamepadIdx = e.gamepad.index;
    
    // UI表示の更新
    const icon = el.indicator.querySelector(".gamepad-icon");
    icon.className = "fa-solid fa-gamepad gamepad-icon connected";
    
    const text = el.indicator.querySelector(".ctrl-status-text");
    text.textContent = `Connected: ${e.gamepad.id.substring(0, 24)}...`;

    appendLog(`[SYSTEM] コントローラーが接続されました: ${e.gamepad.id}`, "system-msg");

    // 入力監視ループの開始
    startGamepadLoop();
  });

  window.addEventListener("gamepaddisconnected", (e) => {
    if (state.gamepadIdx === e.gamepad.index) {
      console.log("コントローラーが切断されました。");
      state.gamepadIdx = null;
      
      // UIの初期化
      const icon = el.indicator.querySelector(".gamepad-icon");
      icon.className = "fa-solid fa-gamepad gamepad-icon disconnected";
      
      const text = el.indicator.querySelector(".ctrl-status-text");
      text.textContent = "Not Connected (コントローラー未接続)";
      
      appendLog("[SYSTEM] コントローラーが切断されました。", "warning-msg");

      // ループの停止
      stopGamepadLoop();
    }
  });

  // --- 2. 割り当てマップ (Mappings) UI の描画 ---
  function renderMappings() {
    el.mappingsBody.innerHTML = "";

    if (state.mappings.length === 0) {
      el.mappingsBody.innerHTML = `
        <tr>
          <td colspan="5" style="text-align: center; color: var(--text-muted);">
            割り当てがありません。右上の「新規割り当て」から追加してください。
          </td>
        </tr>`;
      return;
    }

    state.mappings.forEach((map, idx) => {
      const tr = document.createElement("tr");

      // 入力名のラベル化
      let inputLabel = map.input;
      if (map.input.startsWith("axis-")) {
        const axisNum = map.input.split("-")[1];
        inputLabel = `<i class="fa-solid fa-arrows-up-down-left-right"></i> Stick Axis ${axisNum}`;
      } else if (map.input.startsWith("btn-")) {
        const btnNum = map.input.split("-")[1];
        inputLabel = `<i class="fa-solid fa-circle-dot"></i> Button ${btnNum}`;
      }

      // アクション名
      let actionLabel = map.action;
      if (map.action === "mdd_speed_y") actionLabel = "モータ前後 (RPS)";
      else if (map.action === "mdd_speed_x") actionLabel = "モータ左右旋回 (RPS)";
      else if (map.action === "valve_toggle") actionLabel = `電磁弁 ${map.channel}ch トグル`;
      else if (map.action === "servo_angle") actionLabel = "サーボ角度指定";

      tr.innerHTML = `
        <td>${inputLabel}</td>
        <td><strong>${map.module}</strong></td>
        <td>${actionLabel}</td>
        <td>${map.scale || "-"}</td>
        <td>
          <button class="btn btn-danger btn-xs btn-icon" onclick="deleteMapping(${idx})" title="削除">
            <i class="fa-solid fa-trash"></i>
          </button>
        </td>
      `;

      el.mappingsBody.appendChild(tr);
    });
  }

  // マッピング削除
  window.deleteMapping = (idx) => {
    state.mappings.splice(idx, 1);
    renderMappings();
  };

  // 新規割り当て追加
  el.btnAddMapping.addEventListener("click", () => {
    // ユーザーに簡易プロンプトで追加（実際にはダイアログが望ましいが簡易化のためJSの対話を利用）
    const inputType = confirm("スティック(軸)の割り当てですか？ (OK=スティック, キャンセル=ボタン)") ? "axis" : "btn";
    
    let inputNum = prompt(inputType === "axis" ? "スティックの軸番号を入力してください (例: 0=左X, 1=左Y, 2=右X, 3=右Y)" : "ボタンの番号を入力してください (例: 0=×, 1=○, 2=□, 3=△)");
    if (inputNum === null || inputNum === "") return;
    
    const targetModule = prompt("ターゲットモジュール名を入力してください (例: drive_mdd, arm_servo)");
    if (!targetModule) return;

    let action = "";
    let scale = 1.0;
    let channel = 1;

    if (inputType === "axis") {
      action = prompt("操作アクションを選択 (mdd_speed_y / mdd_speed_x / servo_angle)");
      if (!action) return;
      scale = parseFloat(prompt("スケール（係数）を入力してください (例: 5.0 または -5.0)"));
      if (isNaN(scale)) scale = 1.0;
    } else {
      action = "valve_toggle";
      channel = parseInt(prompt("操作する電磁弁のチャネル(1〜12)を入力してください"));
      if (isNaN(channel)) channel = 1;
    }

    // 新規登録
    state.mappings.push({
      input: `${inputType}-${inputNum}`,
      module: targetModule,
      action: action,
      scale: scale,
      channel: channel
    });

    renderMappings();
    appendLog(`[SYSTEM] コントローラー割り当てを追加しました: ${inputType}-${inputNum} ➔ ${targetModule}`, "system-msg");
  });

  // --- 3. ゲームパッド入力ポーリングループ (60Hz) ---
  function startGamepadLoop() {
    if (state.animationFrameId) {
      cancelAnimationFrame(state.animationFrameId);
    }
    tick();
  }

  function stopGamepadLoop() {
    if (state.animationFrameId) {
      cancelAnimationFrame(state.animationFrameId);
      state.animationFrameId = null;
    }
  }

  function tick() {
    pollGamepad();
    state.animationFrameId = requestAnimationFrame(tick);
  }

  // メインサンプリング
  function pollGamepad() {
    if (state.gamepadIdx === null) return;

    const gamepads = navigator.getGamepads();
    const gp = gamepads[state.gamepadIdx];
    if (!gp) return;

    // 最新のモータ目標値 (MDD用の一時バッファ)
    const mddTargets = {
      // "drive_mdd": { speed_y: 0.0, speed_x: 0.0 } 等
    };

    // マッピングルールに沿って入力をスキャン
    state.mappings.forEach(map => {
      // A. スティック入力 (軸) の処理
      if (map.input.startsWith("axis-")) {
        const axisIdx = parseInt(map.input.split("-")[1]);
        if (axisIdx >= gp.axes.length) return;

        let val = gp.axes[axisIdx];
        
        // デッドバンド (遊び) の適用 (スティックの微小なチャタリングノイズを除去)
        const DEADBAND = 0.08;
        if (Math.abs(val) < DEADBAND) {
          val = 0.0;
        }

        const scaledVal = val * (map.scale || 1.0);

        if (map.action === "mdd_speed_y" || map.action === "mdd_speed_x") {
          if (!mddTargets[map.module]) {
            mddTargets[map.module] = { speed_y: 0.0, speed_x: 0.0 };
          }
          if (map.action === "mdd_speed_y") {
            mddTargets[map.module].speed_y = scaledVal;
          } else {
            mddTargets[map.module].speed_x = scaledVal;
          }
        }
      } 
      
      // B. ボタン入力の処理
      else if (map.input.startsWith("btn-")) {
        const btnIdx = parseInt(map.input.split("-")[1]);
        if (btnIdx >= gp.buttons.length) return;

        const btn = gp.buttons[btnIdx];
        const isPressed = btn.pressed;
        
        // 前フレームとの比較 (エッジ検出: 押し下げられた瞬間だけトリガーする)
        const prevPressed = state.prevButtons[btnIdx] || false;
        
        if (isPressed && !prevPressed) {
          // 押し下げられた瞬間！
          handleButtonPress(map);
        }

        // 状態の保存
        state.prevButtons[btnIdx] = isPressed;
      }
    });

    // キャッシュされたMDD目標値を一括でWebSocket送信 (オムニや2輪差動などの混合演算)
    for (const [modName, spd] of Object.entries(mddTargets)) {
      // Y軸（前後）とX軸（左右旋回）を結合して、各車輪の目標速度を計算
      // 簡易的な差動駆動または全車輪への均等割付
      // M1=左前, M2=左後, M3=右前, M4=右後 と仮定
      const leftSpd = spd.speed_y + spd.speed_x;
      const rightSpd = spd.speed_y - spd.speed_x;
      
      const targets = [leftSpd, leftSpd, rightSpd, rightSpd];

      // WebSocketで即座に送信
      const appWs = window.parent.WebSocket ? window.parent : window; // 親ウインドウのWSを共有可能
      // 実際にはメインの app.js 内の ws 接続を利用
      sendMddCommandViaApp(modName, targets);
    }
  }

  // ボタンが押された瞬間の処理 (トグル制御など)
  function handleButtonPress(map) {
    if (map.action === "valve_toggle") {
      // 対象チャネルのボタン要素を取得してトグル
      const btn = document.getElementById(`btn-${map.module}-v${map.channel}`);
      if (btn) {
        btn.click(); // GUIのクリックイベントをシミュレート
        console.log(`[Gamepad] ${map.module} バルブ ${map.channel}ch をトグルしました。`);
      }
    }
  }

  // app.jsと繋ぐためのブリッジ関数
  function sendMddCommandViaApp(modName, targets) {
    // グローバル状態を通じて送信できるように window オブジェクトなどにフックするか、
    // あるいは直接 window を介して WebSocket 送信を行う
    // 本UIは単一ウィンドウHTMLのため、親 app.js の関数を呼び出し可能です。
    // スライダーの値も同期させておくと親切
    for (let i = 1; i <= 4; i++) {
      const slider = document.getElementById(`range-${modName}-m${i}`);
      const valText = document.getElementById(`val-${modName}-m${i}`);
      if (slider) {
        slider.value = targets[i-1];
        if (valText) valText.textContent = `${targets[i-1].toFixed(1)} rps`;
      }
    }

    // メインのWebSocketを取得して送信
    const mainWs = getActiveWebSocket();
    if (mainWs && mainWs.readyState === WebSocket.OPEN) {
      mainWs.send(JSON.stringify({
        type: "mdd_cmd",
        name: modName,
        targets: targets
      }));
    }
  }

  function getActiveWebSocket() {
    // 簡易的にウィンドウ上のオブジェクトから取得
    // app.js内で window.appState = state などとフックしておけば容易に共有可能
    // 本コードではグローバルな通信を行うために index.html レベルでグローバル共有されている想定です。
    // window 経由で WebSocket 接続を特定
    // （app.js 側で `window.appWs = state.ws` を設定するコードに後で app.js を変更するか、
    //  またはローカルストレージやイベント連携する）
    // 最も簡単なのは、app.js 側で `window.appWs` に参照を渡しておくことです。
    return window.appWs || null;
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

  // app.js側で window.appWs = state.ws が設定されるため、それを利用
  // 初期レンダリング
  renderMappings();
});
