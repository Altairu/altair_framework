/* ==========================================================================
   Altair Web Controller v2 - フロントエンド メイン JavaScript
   機能: ビュー切り替え, REST API通信, WebSocket双方向通信, 動的カード描画, プロファイル管理
   ========================================================================== */

document.addEventListener("DOMContentLoaded", () => {
  // アプリケーションの状態管理
  const state = {
    ws: null,
    wsUrl: `ws://${window.location.host || (window.location.hostname + ":8000")}/ws`,
    config: { modules: [] },
    ports: [],
    profiles: [],
    canConnected: false,
    lastCanError: "",
    behaviorStatus: "IDLE",
    controlMode: "SETUP", // SETUP (送信待ち), SENDING (送信・応答待機中), CONTROL (制御中)
    isSendingParams: false,
    mddStatuses: {}, // 各MDDモジュールのマイコン側システム状態 (0=待機中, 1=制御実行中)
    moduleSendToggles: {}, // 各モジュールへのUI指令値の送信ON/OFFトグル状態
    gamepadMappings: [], // コントローラーのマッピングデータ
  };

  // --- 1. DOM要素の取得 ---
  const el = {
    menuItems: document.querySelectorAll(".menu-item"),
    views: document.querySelectorAll(".content-view"),
    pageTitle: document.getElementById("page-title"),

    // 接続関連
    canStatusIndicator: document.getElementById("can-status-indicator"),
    groupConnectionSlcan: document.getElementById("group-connection-slcan"),
    slcanConnectionStatus: document.getElementById("slcan-connection-status"),
    tabModeEth: document.getElementById("tab-mode-eth"),
    tabModeUsb: document.getElementById("tab-mode-usb"),
    panelConnEth: document.getElementById("panel-conn-eth"),
    panelConnUsb: document.getElementById("panel-conn-usb"),
    txtEthIp: document.getElementById("txt-eth-ip"),
    txtEthPort: document.getElementById("txt-eth-port"),
    selEthCanChannel: document.getElementById("sel-eth-can-channel"),
    btnConnectEth: document.getElementById("btn-connect-eth"),
    btnDisconnectEth: document.getElementById("btn-disconnect-eth"),
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
    canLogsTxTerminal: document.getElementById("can-logs-tx-terminal"),
    canLogsRxTerminal: document.getElementById("can-logs-rx-terminal"),
    canStreamContainer: document.getElementById("can-stream-container"),
    canStreamPanelTx: document.getElementById("can-stream-panel-tx"),
    canStreamPanelRx: document.getElementById("can-stream-panel-rx"),
    canStreamPanelAll: document.getElementById("can-stream-panel-all"),
    canSummaryTbody: document.getElementById("can-summary-tbody"),
    canStatTxCount: document.getElementById("can-stat-tx-count"),
    canStatRxCount: document.getElementById("can-stat-rx-count"),
    canStatIdCount: document.getElementById("can-stat-id-count"),
    canFilterDirGroup: document.getElementById("can-filter-dir-group"),
    canFilterIdSelect: document.getElementById("can-filter-id-select"),
    canFilterSearch: document.getElementById("can-filter-search"),
    canViewModeGroup: document.getElementById("can-view-mode-group"),
    btnPauseCanLogs: document.getElementById("btn-pause-can-logs"),
    btnClearCanLogs: document.getElementById("btn-clear-can-logs"),
    btnResetIdFilter: document.getElementById("btn-reset-id-filter"),

    // モジュール追加モーダル
    modal: document.getElementById("add-module-modal"),
    btnCloseModal: document.getElementById("btn-close-modal"),
    btnCancelModal: document.getElementById("btn-cancel-modal"),
    btnSaveModule: document.getElementById("btn-save-module"),
    modalModuleType: document.getElementById("modal-module-type"),
    modalRobomasGroup: document.getElementById("modal-robomas-group"),
    modalRobomasModel: document.getElementById("modal-robomas-model"),
    modalRobomasMode: document.getElementById("modal-robomas-mode"),
    modalIdLabel: document.getElementById("modal-id-label"),
    modalModuleName: document.getElementById("modal-module-name"),
    modalModuleId: document.getElementById("modal-module-id"),
    modalModuleChannel: document.getElementById("modal-module-channel"),
    modalModuleDesc: document.getElementById("modal-module-desc"),
  };

  // Blocklyワークスペース参照（タブ表示時の再レイアウトに使用）
  let blocklyWorkspace = null;

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

      // 非表示タブで初期化されたBlocklyを表示時に再レイアウトする
      if (targetId === "view-automation" && blocklyWorkspace && typeof Blockly !== "undefined") {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            Blockly.svgResize(blocklyWorkspace);
          });
        });
      }

      // CANログ画面を開いた際に最新の履歴・集計を即座に描画する
      if (targetId === "view-logs") {
        canLogState.pendingStreamEntries = [];
        if (el.canStatTxCount) el.canStatTxCount.textContent = canLogState.txTotal;
        if (el.canStatRxCount) el.canStatRxCount.textContent = canLogState.rxTotal;
        if (el.canStatIdCount) el.canStatIdCount.textContent = canLogState.knownIds.size;
        renderCanSummaryTable();
        rebuildCanStreamTerminals();
      }
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

      case "robomas_feedback":
        updateRobomasCardFeedback(msg.name, data);
        break;

      case "sim_state":
        handleSimStateUpdate(data);
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
      dot.className = data.error_message ? "status-dot warning" : "status-dot connected";
      text.textContent = `CAN: Connected (${data.active_port})`;
      if (el.btnConnectCan) el.btnConnectCan.disabled = true;
      if (el.btnDisconnectCan) el.btnDisconnectCan.disabled = false;
      if (el.btnConnectEth) el.btnConnectEth.disabled = true;
      if (el.btnDisconnectEth) el.btnDisconnectEth.disabled = false;

      // slcan接続グループのUI更新
      if (el.slcanConnectionStatus) {
        if (data.error_message) {
          el.slcanConnectionStatus.innerHTML = `状態: <span class="badge badge-warning" style="padding: 4px 8px; font-size: 11px;">${data.error_message}</span>`;
        } else {
          el.slcanConnectionStatus.innerHTML = `状態: <span class="badge badge-success" style="padding: 4px 8px; font-size: 11px;">接続完了 (${data.active_port})</span>`;
        }
      }
      if (el.groupConnectionSlcan) {
        el.groupConnectionSlcan.style.borderColor = data.error_message ? "var(--color-warning)" : "var(--color-success)";
        el.groupConnectionSlcan.style.boxShadow = "0 0 10px rgba(19, 115, 51, 0.1)";
      }
      if (data.error_message && data.error_message !== state.lastCanError) {
        state.lastCanError = data.error_message;
        appendTerminalLog(el.behaviorTerminal, `[CAN WARNING] ${data.error_message}`, "error-msg");
      } else if (!data.error_message) {
        state.lastCanError = "";
      }
    } else {
      dot.className = "status-dot disconnected";
      text.textContent = "CAN: Disconnected";
      if (el.btnConnectCan) el.btnConnectCan.disabled = false;
      if (el.btnDisconnectCan) el.btnDisconnectCan.disabled = true;
      if (el.btnConnectEth) el.btnConnectEth.disabled = false;
      if (el.btnDisconnectEth) el.btnDisconnectEth.disabled = true;

      // slcan接続グループのUI更新
      if (el.slcanConnectionStatus) {
        el.slcanConnectionStatus.innerHTML = `状態: <span class="badge badge-danger" style="padding: 4px 8px; font-size: 11px;">未接続</span>`;
      }
      if (el.groupConnectionSlcan) {
        el.groupConnectionSlcan.style.borderColor = "var(--border-light)";
        el.groupConnectionSlcan.style.boxShadow = "none";
      }

      if (data.error_message && data.error_message !== state.lastCanError) {
        state.lastCanError = data.error_message;
        appendTerminalLog(el.behaviorTerminal, `[CAN ERROR] ${data.error_message}`, "error-msg");
      } else if (!data.error_message) {
        state.lastCanError = "";
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

  // --- 6. コンソール ＆ CANアナライザ ロギングヘルパー ---
  const canLogState = {
    paused: false,
    filterDir: "ALL",     // ALL | TX | RX
    filterId: "ALL",      // ALL | 0x200 等 | モジュール名
    searchQuery: "",
    viewMode: "split",    // split | combined | table-only
    txTotal: 0,
    rxTotal: 0,
    summaryMap: new Map(), // key: `${dir}_${idHex}`
    knownIds: new Set(),
    knownIdsDirty: false,
    history: [],           // 直近フレーム履歴 (最大400件)
    pendingStreamEntries: [], // 次回描画フレームで追加する行キュー
    rafScheduled: false,
  };

  function formatTimeWithMs(now) {
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const ss = String(now.getSeconds()).padStart(2, "0");
    const ms = String(now.getMilliseconds()).padStart(3, "0");
    return `${hh}:${mm}:${ss}.${ms}`;
  }

  function readInt16LE(bytes, offset) {
    if (bytes.length < offset + 2) return 0;
    const val = (bytes[offset] & 0xFF) | ((bytes[offset + 1] & 0xFF) << 8);
    return val >= 0x8000 ? val - 0x10000 : val;
  }

  function resolveCanFrameInfo(idNum, bytes) {
    const modules = state.config?.modules || [];
    for (const m of modules) {
      const baseId = parseInt(m.base_id, 16);
      if (isNaN(baseId)) continue;

      if (m.type === "mdd") {
        if (idNum >= baseId && idNum <= baseId + 3) {
          const ch = idNum - baseId + 1;
          let decoded = "";
          if (bytes.length >= 8) {
            const p = (readInt16LE(bytes, 0) / 1000).toFixed(2);
            const i = (readInt16LE(bytes, 2) / 1000).toFixed(2);
            const d = (readInt16LE(bytes, 4) / 1000).toFixed(2);
            const diaRaw = readInt16LE(bytes, 6);
            const dirStr = diaRaw < 0 ? "Rev(-)" : "Fwd(+)";
            decoded = `P:${p} I:${i} D:${d} 径:${Math.abs(diaRaw)}mm ${dirStr}`;
          }
          return { moduleName: m.name, label: `${m.name} / PID設定(M${ch})`, decoded };
        }
        if (idNum === baseId + 0x10) {
          const modeNames = ["Speed", "Angle", "Pos"];
          const modes = bytes.slice(0, 4).map((b, idx) => `M${idx + 1}:${modeNames[b] || b}`).join(" ");
          return { moduleName: m.name, label: `${m.name} / モード・起動`, decoded: modes };
        }
        if (idNum === baseId + 0x20) {
          let decoded = "";
          if (bytes.length >= 8) {
            const vals = [0, 1, 2, 3].map(idx => `M${idx + 1}:${(readInt16LE(bytes, idx * 2) / 10).toFixed(1)}`);
            decoded = vals.join(" ");
          }
          return { moduleName: m.name, label: `${m.name} / 目標値指令`, decoded };
        }
        if (idNum === baseId + 0x30) {
          let decoded = "";
          if (bytes.length >= 6) {
            const st = bytes[5] === 1 ? "制御中(1)" : "待機中(0)";
            const err = `0x${bytes[4].toString(16).padStart(2, "0").toUpperCase()}`;
            const sw = `${bytes[0] ? 1 : 0}${bytes[1] ? 1 : 0}${bytes[2] ? 1 : 0}${bytes[3] ? 1 : 0}`;
            decoded = `状態:${st} Err:${err} SW:${sw}`;
          }
          return { moduleName: m.name, label: `${m.name} / ステータス返信`, decoded };
        }
        if (idNum === baseId + 0x40) {
          let decoded = "";
          if (bytes.length >= 8) {
            const angs = [0, 1, 2, 3].map(idx => `M${idx + 1}:${(readInt16LE(bytes, idx * 2) / 10).toFixed(1)}°`);
            decoded = angs.join(" ");
          }
          return { moduleName: m.name, label: `${m.name} / 現在角度FB`, decoded };
        }
        if (idNum === baseId + 0x50) {
          let decoded = "";
          if (bytes.length >= 8) {
            const spds = [0, 1, 2, 3].map(idx => `M${idx + 1}:${(readInt16LE(bytes, idx * 2) / 100).toFixed(2)}`);
            decoded = `${spds.join(" ")} rps`;
          }
          return { moduleName: m.name, label: `${m.name} / 現在速度FB`, decoded };
        }
      } else if (m.type === "servo" && idNum === baseId) {
        const angs = bytes.slice(0, 6).map((b, idx) => `S${idx + 1}:${b}°`).join(" ");
        return { moduleName: m.name, label: `${m.name} / サーボ指令`, decoded: angs };
      } else if (m.type === "solenoid" && idNum === baseId) {
        const bits = (bytes[0] || 0) | ((bytes[1] || 0) << 8);
        const onList = [];
        for (let i = 0; i < 12; i++) {
          if (bits & (1 << i)) onList.push(`V${i + 1}`);
        }
        return {
          moduleName: m.name,
          label: `${m.name} / 電磁弁指令`,
          decoded: onList.length > 0 ? `ON: ${onList.join(",")}` : "すべてOFF",
        };
      }
    }

    return { moduleName: "", label: "未登録ID", decoded: "" };
  }

  function parseRawCanLogLine(text) {
    const m = text.match(/^\[(TX|RX)\]\s*\(([^)]+)\)\s*ID:\s*(0x[0-9A-Fa-f]+)\s*\[(\d+)\]\s*(.*)$/);
    if (!m) return null;
    const dir = m[1];
    const channel = m[2];
    const idNum = parseInt(m[3], 16);
    const idHex = `0x${idNum.toString(16).toUpperCase().padStart(3, "0")}`;
    const dlc = parseInt(m[4], 10);
    const hexTokens = m[5].trim() ? m[5].trim().split(/\s+/) : [];
    const bytes = hexTokens.map(h => parseInt(h, 16) || 0);
    const timeStr = formatTimeWithMs(new Date());
    const info = resolveCanFrameInfo(idNum, bytes);

    return {
      dir,
      channel,
      idHex,
      idNum,
      dlc,
      hexTokens,
      bytes,
      timeStr,
      moduleName: info.moduleName,
      label: info.label,
      decoded: info.decoded,
    };
  }

  function matchesCanFilter(entry) {
    if (canLogState.filterDir !== "ALL" && entry.dir !== canLogState.filterDir) {
      return false;
    }
    if (canLogState.filterId !== "ALL") {
      if (canLogState.filterId.startsWith("MOD:")) {
        const targetMod = canLogState.filterId.slice(4);
        if (entry.moduleName !== targetMod) return false;
      } else if (entry.idHex !== canLogState.filterId) {
        return false;
      }
    }
    if (canLogState.searchQuery) {
      const q = canLogState.searchQuery.toLowerCase();
      const hay = `${entry.idHex} ${entry.label} ${entry.decoded} ${entry.hexTokens.join(" ")}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }

  function updateCanFilterSelectOptions() {
    if (!el.canFilterIdSelect) return;
    const currentVal = el.canFilterIdSelect.value;
    const modules = state.config?.modules || [];

    let html = '<option value="ALL">すべてのID / モジュール</option>';
    if (modules.length > 0) {
      html += '<optgroup label="モジュール別">';
      modules.forEach(m => {
        html += `<option value="MOD:${m.name}">${m.name} (${m.base_id})</option>`;
      });
      html += "</optgroup>";
    }

    const sortedIds = Array.from(canLogState.knownIds).sort((a, b) => parseInt(a, 16) - parseInt(b, 16));
    if (sortedIds.length > 0) {
      html += '<optgroup label="CAN ID別">';
      sortedIds.forEach(idHex => {
        const info = resolveCanFrameInfo(parseInt(idHex, 16), []);
        const suffix = info.label && info.label !== "未登録ID" ? ` - ${info.label}` : "";
        html += `<option value="${idHex}">${idHex}${suffix}</option>`;
      });
      html += "</optgroup>";
    }

    el.canFilterIdSelect.innerHTML = html;
    if ([...el.canFilterIdSelect.options].some(o => o.value === currentVal)) {
      el.canFilterIdSelect.value = currentVal;
    } else {
      el.canFilterIdSelect.value = "ALL";
    }
  }

  function renderCanStreamRow(entry) {
    const div = document.createElement("div");
    div.className = "can-log-row";
    const dirClass = entry.dir === "TX" ? "can-log-dir-tx" : "can-log-dir-rx";
    const hexStr = entry.hexTokens.join(" ");
    const decStr = entry.decoded ? ` | ${entry.decoded}` : "";
    div.innerHTML = `
      <span class="can-log-time">[${entry.timeStr}]</span>
      <span class="${dirClass}">${entry.dir}</span>
      <span class="can-log-id">${entry.idHex}</span>
      <span class="can-log-label" title="${entry.label}">${entry.label}</span>
      <span class="can-log-data">[${entry.dlc}] ${hexStr}${decStr}</span>
    `;
    return div;
  }

  function appendStreamBatchToTerminal(terminal, entries) {
    if (!terminal || entries.length === 0) return;
    const frag = document.createDocumentFragment();
    const slice = entries.length > 200 ? entries.slice(-200) : entries;
    for (const entry of slice) {
      frag.appendChild(renderCanStreamRow(entry));
    }
    terminal.appendChild(frag);
    while (terminal.childElementCount > 200) {
      terminal.removeChild(terminal.firstChild);
    }
    terminal.scrollTop = terminal.scrollHeight;
  }

  function rebuildCanStreamTerminals() {
    if (el.canLogsTerminal) el.canLogsTerminal.innerHTML = "";
    if (el.canLogsTxTerminal) el.canLogsTxTerminal.innerHTML = "";
    if (el.canLogsRxTerminal) el.canLogsRxTerminal.innerHTML = "";

    const filtered = canLogState.history.filter(matchesCanFilter);
    if (canLogState.viewMode === "combined") {
      appendStreamBatchToTerminal(el.canLogsTerminal, filtered);
    } else if (canLogState.viewMode === "split") {
      appendStreamBatchToTerminal(el.canLogsTxTerminal, filtered.filter(e => e.dir === "TX"));
      appendStreamBatchToTerminal(el.canLogsRxTerminal, filtered.filter(e => e.dir === "RX"));
    }
  }

  function renderCanSummaryTable() {
    if (!el.canSummaryTbody) return;
    const items = Array.from(canLogState.summaryMap.values())
      .filter(matchesCanFilter)
      .sort((a, b) => {
        if (a.idNum !== b.idNum) return a.idNum - b.idNum;
        return a.dir.localeCompare(b.dir);
      });

    if (items.length === 0) {
      el.canSummaryTbody.innerHTML = `
        <tr class="can-empty-row">
          <td colspan="7">条件に一致するCANフレームはまだありません。</td>
        </tr>`;
      return;
    }

    el.canSummaryTbody.innerHTML = items.map(item => {
      const dirBadge = item.dir === "TX"
        ? '<span class="can-dir-badge can-dir-tx">TX</span>'
        : '<span class="can-dir-badge can-dir-rx">RX</span>';
      const isSelected = canLogState.filterId === item.idHex ? "selected-id-row" : "";
      const bytesHtml = item.hexTokens.map((hx, idx) => {
        const changed = item.prevHexTokens && item.prevHexTokens[idx] !== undefined && item.prevHexTokens[idx] !== hx;
        return `<span class="can-hex-byte ${changed ? "changed" : ""}">${hx}</span>`;
      }).join("");

      return `
        <tr class="${isSelected}" data-can-id="${item.idHex}" title="クリックでこのCAN ID (${item.idHex}) を絞り込み">
          <td>${dirBadge}</td>
          <td><span class="can-id-badge">${item.idHex}</span></td>
          <td style="font-weight: 500;">${item.label}</td>
          <td style="text-align: center; font-family: 'Consolas', monospace;">${item.dlc}</td>
          <td><div class="can-hex-bytes">${bytesHtml}</div></td>
          <td><span class="can-decoded-text">${item.decoded || "-"}</span></td>
          <td style="text-align: right; font-family: 'Consolas', monospace; font-size: 11px; color: var(--text-muted);">
            <strong>${item.count}</strong>回<br>${item.timeStr}
          </td>
        </tr>`;
    }).join("");
  }

  function updateCanViewLayout() {
    if (!el.canStreamContainer) return;
    if (canLogState.viewMode === "table-only") {
      el.canStreamContainer.style.display = "none";
    } else if (canLogState.viewMode === "combined") {
      el.canStreamContainer.style.display = "block";
      el.canStreamContainer.className = "can-stream-combined mt-3";
      if (el.canStreamPanelTx) el.canStreamPanelTx.style.display = "none";
      if (el.canStreamPanelRx) el.canStreamPanelRx.style.display = "none";
      if (el.canStreamPanelAll) el.canStreamPanelAll.style.display = "block";
    } else {
      el.canStreamContainer.style.display = "grid";
      el.canStreamContainer.className = "can-stream-split mt-3";
      if (el.canStreamPanelTx) el.canStreamPanelTx.style.display = canLogState.filterDir === "RX" ? "none" : "block";
      if (el.canStreamPanelRx) el.canStreamPanelRx.style.display = canLogState.filterDir === "TX" ? "none" : "block";
      if (el.canStreamPanelAll) el.canStreamPanelAll.style.display = "none";
    }
  }

  function flushCanLogUI() {
    canLogState.rafScheduled = false;

    if (canLogState.knownIdsDirty) {
      canLogState.knownIdsDirty = false;
      updateCanFilterSelectOptions();
    }

    const viewLogsEl = document.getElementById("view-logs");
    const isLogsActive = viewLogsEl && viewLogsEl.classList.contains("active");

    if (!isLogsActive) {
      canLogState.pendingStreamEntries = [];
      return;
    }

    if (el.canStatTxCount) el.canStatTxCount.textContent = canLogState.txTotal;
    if (el.canStatRxCount) el.canStatRxCount.textContent = canLogState.rxTotal;
    if (el.canStatIdCount) el.canStatIdCount.textContent = canLogState.knownIds.size;

    renderCanSummaryTable();

    if (canLogState.pendingStreamEntries.length > 0) {
      const batch = canLogState.pendingStreamEntries;
      canLogState.pendingStreamEntries = [];

      if (canLogState.viewMode === "combined") {
        appendStreamBatchToTerminal(el.canLogsTerminal, batch);
      } else if (canLogState.viewMode === "split") {
        const txBatch = [];
        const rxBatch = [];
        for (const entry of batch) {
          if (entry.dir === "TX") txBatch.push(entry);
          else rxBatch.push(entry);
        }
        if (txBatch.length > 0 && canLogState.filterDir !== "RX") {
          appendStreamBatchToTerminal(el.canLogsTxTerminal, txBatch);
        }
        if (rxBatch.length > 0 && canLogState.filterDir !== "TX") {
          appendStreamBatchToTerminal(el.canLogsRxTerminal, rxBatch);
        }
      }
    }
  }

  function appendCanLog(text) {
    if (canLogState.paused) return;

    const entry = parseRawCanLogLine(text);
    if (!entry) {
      if (el.canLogsTerminal) appendTerminalLog(el.canLogsTerminal, text);
      return;
    }

    if (entry.dir === "TX") {
      canLogState.txTotal++;
    } else {
      canLogState.rxTotal++;
    }

    if (!canLogState.knownIds.has(entry.idHex)) {
      canLogState.knownIds.add(entry.idHex);
      canLogState.knownIdsDirty = true;
    }

    const key = `${entry.dir}_${entry.idHex}`;
    const prev = canLogState.summaryMap.get(key);
    canLogState.summaryMap.set(key, {
      ...entry,
      prevHexTokens: prev ? prev.hexTokens : null,
      count: prev ? prev.count + 1 : 1,
    });

    canLogState.history.push(entry);
    if (canLogState.history.length > 400) {
      canLogState.history.shift();
    }

    if (matchesCanFilter(entry)) {
      canLogState.pendingStreamEntries.push(entry);
      if (canLogState.pendingStreamEntries.length > 200) {
        canLogState.pendingStreamEntries.shift();
      }
    }

    if (!canLogState.rafScheduled) {
      canLogState.rafScheduled = true;
      requestAnimationFrame(flushCanLogUI);
    }
  }

  // 送受信フィルタ切替イベント
  if (el.canFilterDirGroup) {
    el.canFilterDirGroup.addEventListener("click", (e) => {
      const btn = e.target.closest(".can-seg-btn");
      if (!btn) return;
      el.canFilterDirGroup.querySelectorAll(".can-seg-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      canLogState.filterDir = btn.getAttribute("data-dir") || "ALL";
      canLogState.pendingStreamEntries = [];
      updateCanViewLayout();
      renderCanSummaryTable();
      rebuildCanStreamTerminals();
    });
  }

  // 表示モード切替イベント (送受信2分割 / 統合ストリーム / ID表のみ)
  if (el.canViewModeGroup) {
    el.canViewModeGroup.addEventListener("click", (e) => {
      const btn = e.target.closest(".can-seg-btn");
      if (!btn) return;
      el.canViewModeGroup.querySelectorAll(".can-seg-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      canLogState.viewMode = btn.getAttribute("data-mode") || "split";
      canLogState.pendingStreamEntries = [];
      updateCanViewLayout();
      rebuildCanStreamTerminals();
    });
  }

  // IDセレクト絞り込みイベント
  if (el.canFilterIdSelect) {
    el.canFilterIdSelect.addEventListener("change", () => {
      canLogState.filterId = el.canFilterIdSelect.value;
      if (el.btnResetIdFilter) {
        el.btnResetIdFilter.style.display = canLogState.filterId === "ALL" ? "none" : "inline";
      }
      renderCanSummaryTable();
      rebuildCanStreamTerminals();
    });
  }

  // テキスト検索絞り込みイベント
  if (el.canFilterSearch) {
    el.canFilterSearch.addEventListener("input", () => {
      canLogState.searchQuery = el.canFilterSearch.value.trim();
      renderCanSummaryTable();
      rebuildCanStreamTerminals();
    });
  }

  // ID別モニター表の行クリックで特定CAN IDの絞り込みトグル
  if (el.canSummaryTbody) {
    el.canSummaryTbody.addEventListener("click", (e) => {
      const tr = e.target.closest("tr[data-can-id]");
      if (!tr) return;
      const clickedId = tr.getAttribute("data-can-id");
      canLogState.filterId = canLogState.filterId === clickedId ? "ALL" : clickedId;
      if (el.canFilterIdSelect) el.canFilterIdSelect.value = canLogState.filterId;
      if (el.btnResetIdFilter) {
        el.btnResetIdFilter.style.display = canLogState.filterId === "ALL" ? "none" : "inline";
      }
      renderCanSummaryTable();
      rebuildCanStreamTerminals();
    });
  }

  if (el.btnResetIdFilter) {
    el.btnResetIdFilter.addEventListener("click", () => {
      canLogState.filterId = "ALL";
      if (el.canFilterIdSelect) el.canFilterIdSelect.value = "ALL";
      el.btnResetIdFilter.style.display = "none";
      renderCanSummaryTable();
      rebuildCanStreamTerminals();
    });
  }

  // 一時停止 / 再開ボタン
  if (el.btnPauseCanLogs) {
    el.btnPauseCanLogs.addEventListener("click", () => {
      canLogState.paused = !canLogState.paused;
      if (canLogState.paused) {
        el.btnPauseCanLogs.innerHTML = '<i class="fa-solid fa-play"></i> 再開';
        el.btnPauseCanLogs.classList.add("btn-primary");
        el.btnPauseCanLogs.classList.remove("btn-secondary");
      } else {
        el.btnPauseCanLogs.innerHTML = '<i class="fa-solid fa-pause"></i> 一時停止';
        el.btnPauseCanLogs.classList.remove("btn-primary");
        el.btnPauseCanLogs.classList.add("btn-secondary");
      }
    });
  }

  // クリアボタン
  if (el.btnClearCanLogs) {
    el.btnClearCanLogs.addEventListener("click", () => {
      canLogState.txTotal = 0;
      canLogState.rxTotal = 0;
      canLogState.summaryMap.clear();
      canLogState.knownIds.clear();
      canLogState.knownIdsDirty = false;
      canLogState.history = [];
      canLogState.pendingStreamEntries = [];
      if (el.canStatTxCount) el.canStatTxCount.textContent = "0";
      if (el.canStatRxCount) el.canStatRxCount.textContent = "0";
      if (el.canStatIdCount) el.canStatIdCount.textContent = "0";
      updateCanFilterSelectOptions();
      renderCanSummaryTable();
      rebuildCanStreamTerminals();
    });
  }

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
      updateCanFilterSelectOptions();
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
      } else if (mod.type === "robomas") {
        contentHtml = renderRobomasCardHtml(mod);
      }

      const chVal = (mod.can_channel || "").toLowerCase();
      const chBadge = chVal === "can1"
        ? '<span style="background: rgba(26,115,232,0.12); color: #1a73e8; padding: 1px 6px; border-radius: 4px; font-weight: 600;">CAN1</span>'
        : chVal === "can2"
          ? '<span style="background: rgba(227,116,0,0.14); color: #b06000; padding: 1px 6px; border-radius: 4px; font-weight: 600;">CAN2</span>'
          : chVal === "both"
            ? '<span style="background: rgba(19,115,51,0.12); color: #137333; padding: 1px 6px; border-radius: 4px; font-weight: 600;">CAN1+2</span>'
            : '<span>CH: 全体設定</span>';

      card.innerHTML = `
        <div class="card-header-row">
          <div class="module-title">
            <h2>${mod.name}</h2>
            <div class="module-meta-info" style="margin-bottom: 2px;">
              <span>ID: ${mod.base_id}</span>
              <span>Type: ${mod.type.toUpperCase()}</span>
              ${chBadge}
            </div>
            <!-- UI操作送信トグルスイッチ -->
            <div class="send-toggle-row" style="display: flex; align-items: center; gap: 6px; margin-top: 6px;">
              <label class="toggle-checkbox" style="display: flex; align-items: center; gap: 6px; cursor: pointer; margin-bottom: 0;">
                <input type="checkbox" class="toggle-send-cmd" data-module="${mod.name}" id="toggle-send-${mod.name}" ${state.moduleSendToggles[mod.name] ? "checked" : ""}>
                <span class="toggle-switch toggle-switch-sm"></span>
              </label>
              <span style="font-size: 11px; font-weight: 600; color: var(--text-muted); user-select: none;">UI操作送信</span>
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
      const motorParam = mod.parameters?.[`m${i}`] ?? { mode: 0, p: 10.0, i: 0.0, d: 0.0, diameter: 100.0, direction: 1 };
      const mode = motorParam.mode ?? 0;

      let min = -10;
      let max = 10;
      let step = 0.1;
      let unit = "rps";

      if (mode === 1) {
        min = -360;
        max = 360;
        step = 1;
        unit = "deg";
      } else if (mode === 2) {
        min = -1000;
        max = 1000;
        step = 1;
        unit = "mm";
      }

      slidersHtml += `
        <div class="control-slider-group mt-2">
          <div class="slider-label-row" style="display: flex; justify-content: space-between; align-items: center;">
            <span class="slider-name">Motor ${i} Goal</span>
            <div style="display: flex; align-items: center; gap: 4px;">
              <button class="btn btn-secondary btn-xs btn-target-adjust" data-module="${mod.name}" data-motor="${i}" data-action="minus" style="padding: 0; width: 16px; height: 16px; font-size: 10px; line-height: 1; font-weight: bold;">-</button>
              <span class="slider-val" id="val-${mod.name}-m${i}" style="min-width: 60px; text-align: center; font-weight: 500;">0.0 ${unit}</span>
              <button class="btn btn-secondary btn-xs btn-target-adjust" data-module="${mod.name}" data-motor="${i}" data-action="plus" style="padding: 0; width: 16px; height: 16px; font-size: 10px; line-height: 1; font-weight: bold;">+</button>
            </div>
          </div>
          <input type="range" class="custom-range range-mdd" data-module="${mod.name}" data-motor="${i}" 
                 min="${min}" max="${max}" step="${step}" value="0" id="range-${mod.name}-m${i}">
        </div>`;
    }

    // M1〜M4のパラメータ（モード, P, I, D, diameter, direction）設定リスト
    let paramsCardsHtml = "";
    for (let i = 1; i <= 4; i++) {
      const motorParam = mod.parameters?.[`m${i}`] ?? { mode: 0, p: 10.0, i: 0.0, d: 0.0, diameter: 100.0, direction: 1 };
      paramsCardsHtml += `
        <div class="mdd-motor-card">
          <!-- 上段: チャンネル, モード, 車輪径, 回転方向 -->
          <div class="mdd-motor-header">
            <span class="mdd-ch-badge">M${i}</span>
            <div class="mdd-header-field mdd-mode-field">
              <select class="form-input form-input-sm select-mdd-mode" data-module="${mod.name}" data-motor="${i}" title="制御モード">
                <option value="0" ${motorParam.mode === 0 ? "selected" : ""}>Speed</option>
                <option value="1" ${motorParam.mode === 1 ? "selected" : ""}>Angle</option>
                <option value="2" ${motorParam.mode === 2 ? "selected" : ""}>Pos</option>
              </select>
            </div>
            <div class="mdd-header-field mdd-wheel-field">
              <span class="mdd-field-label">径</span>
              <input type="number" class="form-input form-input-sm input-mdd-wheel" data-module="${mod.name}" data-motor="${i}" step="1" value="${motorParam.diameter ?? 100.0}" title="車輪直径(mm)">
              <span class="mdd-field-unit">mm</span>
            </div>
            <div class="mdd-header-field mdd-dir-field">
              <span class="mdd-field-label">Dir</span>
              <select class="form-input form-input-sm select-mdd-dir" data-module="${mod.name}" data-motor="${i}" title="回転方向">
                <option value="1" ${(motorParam.direction ?? 1) >= 0 ? "selected" : ""}>+</option>
                <option value="-1" ${(motorParam.direction ?? 1) < 0 ? "selected" : ""}>-</option>
              </select>
            </div>
          </div>

          <!-- 下段: PID設定ステッパー (P, I, D) -->
          <div class="mdd-motor-pid-row">
            <div class="mdd-pid-group">
              <span class="mdd-pid-tag">P</span>
              <div class="mdd-stepper">
                <button type="button" class="btn-stepper btn-pid-adjust" data-module="${mod.name}" data-motor="${i}" data-param="p" data-action="minus" title="P減少">-</button>
                <input type="number" class="stepper-input input-mdd-p" data-module="${mod.name}" data-motor="${i}" step="0.1" value="${motorParam.p}" title="Pゲイン">
                <button type="button" class="btn-stepper btn-pid-adjust" data-module="${mod.name}" data-motor="${i}" data-param="p" data-action="plus" title="P増加">+</button>
              </div>
            </div>
            <div class="mdd-pid-group">
              <span class="mdd-pid-tag">I</span>
              <div class="mdd-stepper">
                <button type="button" class="btn-stepper btn-pid-adjust" data-module="${mod.name}" data-motor="${i}" data-param="i" data-action="minus" title="I減少">-</button>
                <input type="number" class="stepper-input input-mdd-i" data-module="${mod.name}" data-motor="${i}" step="0.01" value="${motorParam.i}" title="Iゲイン">
                <button type="button" class="btn-stepper btn-pid-adjust" data-module="${mod.name}" data-motor="${i}" data-param="i" data-action="plus" title="I増加">+</button>
              </div>
            </div>
            <div class="mdd-pid-group">
              <span class="mdd-pid-tag">D</span>
              <div class="mdd-stepper">
                <button type="button" class="btn-stepper btn-pid-adjust" data-module="${mod.name}" data-motor="${i}" data-param="d" data-action="minus" title="D減少">-</button>
                <input type="number" class="stepper-input input-mdd-d" data-module="${mod.name}" data-motor="${i}" step="0.01" value="${motorParam.d}" title="Dゲイン">
                <button type="button" class="btn-stepper btn-pid-adjust" data-module="${mod.name}" data-motor="${i}" data-param="d" data-action="plus" title="D増加">+</button>
              </div>
            </div>
          </div>
        </div>`;
    }

    const paramTableHtml = `
      <div class="mdd-params-table-wrapper mt-3">
        <h4 style="font-size: 12px; margin-bottom: 8px; font-weight: 600;"><i class="fa-solid fa-gears"></i> PID & Mode Settings</h4>
        <div class="mdd-motors-list">
          ${paramsCardsHtml}
        </div>
      </div>`;

    return `
      <!-- モータ目標値スライダー -->
      <div class="mdd-sliders">
        ${slidersHtml}
      </div>
      
      <!-- PIDおよびモードの編集テーブル -->
      ${paramTableHtml}

      <!-- Limitスイッチインジケータ -->
      <div class="switches-section mt-3">
        <h4 style="font-size: 12px; margin-bottom: 6px; font-weight: 600;">Limit Switches</h4>
        <div class="switches-row">
          <div class="sw-indicator" id="sw-${mod.name}-1">SW 1</div>
          <div class="sw-indicator" id="sw-${mod.name}-2">SW 2</div>
          <div class="sw-indicator" id="sw-${mod.name}-3">SW 3</div>
          <div class="sw-indicator" id="sw-${mod.name}-4">SW 4</div>
        </div>
      </div>

      <!-- エンコーダ実測データ表示 -->
      <div class="mdd-params-grid mt-3">
        <div class="mdd-param-item">M1 FB: <span id="lbl-${mod.name}-m1-fb">0.0° / 0.0</span></div>
        <div class="mdd-param-item">M2 FB: <span id="lbl-${mod.name}-m2-fb">0.0° / 0.0</span></div>
        <div class="mdd-param-item">M3 FB: <span id="lbl-${mod.name}-m3-fb">0.0° / 0.0</span></div>
        <div class="mdd-param-item">M4 FB: <span id="lbl-${mod.name}-m4-fb">0.0° / 0.0</span></div>
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

  // --- RoboMasterカードレンダリングヘルパー ---
  function getRobomasModeMeta(mode, model) {
    if (mode === "voltage") {
      return { label: "電圧出力", unit: "cmd", min: -30000, max: 30000, step: 100 };
    }
    if (mode === "speed_pid") {
      const maxRpm = model === "gm6020" ? 320 : 550;
      return { label: "速度PID", unit: "rpm", min: -maxRpm, max: maxRpm, step: 1 };
    }
    if (mode === "position_pid") {
      return { label: "位置PID", unit: "deg", min: -720, max: 720, step: 1 };
    }
    return { label: "電流出力", unit: "cmd", min: -16384, max: 16384, step: 100 };
  }

  function getRobomasCanSummary(baseIdStr, model) {
    const raw = String(baseIdStr || "1").trim();
    let mid = parseInt(raw, 10);
    if (raw.toLowerCase().startsWith("0x")) {
      const hexVal = parseInt(raw, 16);
      mid = model === "gm6020" ? hexVal - 0x204 : hexVal - 0x200;
    }
    if (isNaN(mid) || mid < 1 || mid > (model === "gm6020" ? 7 : 8)) {
      return "ID不正";
    }
    let txId = 0x200;
    let rxId = 0x200 + mid;
    if (model === "gm6020") {
      txId = mid <= 4 ? 0x1FF : 0x2FF;
      rxId = 0x204 + mid;
    } else {
      txId = mid <= 4 ? 0x200 : 0x1FF;
    }
    return `ID:${mid} / TX:0x${txId.toString(16).toUpperCase()} / RX:0x${rxId.toString(16).toUpperCase()}`;
  }

  function renderRobomasCardHtml(mod) {
    const rm = mod.robomas || {};
    const model = rm.motor_model || "m3508";
    const mode = rm.control_mode || (model === "gm6020" ? "voltage" : "current");
    const meta = getRobomasModeMeta(mode, model);
    const velKp = rm.vel_kp ?? 20.0;
    const velKi = rm.vel_ki ?? 0.0;
    const velKd = rm.vel_kd ?? 0.0;
    const posKp = rm.pos_kp ?? 3.0;
    const posKi = rm.pos_ki ?? 0.0;
    const posKd = rm.pos_kd ?? 0.0;
    const maxSpd = rm.max_speed_rpm ?? 300.0;
    const maxOut = rm.max_output ?? (model === "gm6020" && mode !== "current" ? 25000 : 10000);
    const dir = rm.direction ?? 1;
    const canInfo = getRobomasCanSummary(mod.base_id, model);

    return `
      <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; margin-bottom:8px; font-size:12px;">
        <span class="badge" style="background:rgba(16,185,129,0.14); color:#047857;">${model.toUpperCase()} (${canInfo})</span>
        <select class="form-input rm-mode-select" data-module="${mod.name}" id="rm-mode-${mod.name}" style="width:auto; padding:3px 8px; font-size:12px;">
          <option value="current" ${mode === "current" ? "selected" : ""}>電流出力 (-16384〜16384)</option>
          <option value="voltage" ${mode === "voltage" ? "selected" : ""}>電圧出力 (-30000〜30000)</option>
          <option value="speed_pid" ${mode === "speed_pid" ? "selected" : ""}>速度PID (rpm)</option>
          <option value="position_pid" ${mode === "position_pid" ? "selected" : ""}>位置PID (deg)</option>
        </select>
      </div>

      <div class="motor-control-row" style="margin-bottom:8px;">
        <div class="motor-header-row" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
          <span class="motor-label">目標値 (${meta.label})</span>
          <div style="display:flex; align-items:center; gap:4px;">
            <input type="number" class="form-input rm-target-num" data-module="${mod.name}" id="num-${mod.name}-rm" value="0" step="${meta.step}" style="width:90px; padding:2px 6px; font-size:12px; text-align:right;">
            <span class="motor-val" id="val-${mod.name}-rm" style="min-width:54px;">0 ${meta.unit}</span>
          </div>
        </div>
        <div class="slider-wrapper" style="display:flex; align-items:center; gap:6px;">
          <input type="range" class="range-robomas" data-module="${mod.name}" id="range-${mod.name}-rm" min="${meta.min}" max="${meta.max}" step="${meta.step}" value="0" style="flex:1;">
          <button class="btn btn-secondary btn-xs btn-rm-zero" data-module="${mod.name}" title="目標値を0にリセット">0</button>
        </div>
      </div>

      <div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:6px; padding:8px; border-radius:8px; background:rgba(0,0,0,0.04); font-size:11px; margin-bottom:8px;">
        <div><span style="color:var(--text-muted);">角度</span><br><strong id="rm-fb-angle-${mod.name}">0.0°</strong></div>
        <div><span style="color:var(--text-muted);">速度</span><br><strong id="rm-fb-speed-${mod.name}">0 rpm</strong></div>
        <div><span style="color:var(--text-muted);">電流</span><br><strong id="rm-fb-curr-${mod.name}">0.00 A</strong></div>
        <div><span style="color:var(--text-muted);">温度 / 出力</span><br><strong id="rm-fb-temp-${mod.name}">0°C / 0</strong></div>
      </div>

      <div style="display:flex; justify-content:space-between; align-items:center; gap:6px;">
        <button class="btn btn-secondary btn-xs btn-rm-reset-origin" data-module="${mod.name}">角度原点リセット (0°)</button>
        <button class="btn btn-secondary btn-xs btn-toggle-rm-params" data-module="${mod.name}">PID・詳細設定</button>
      </div>

      <div class="mdd-params-panel" id="rm-params-panel-${mod.name}" style="display:none; margin-top:8px; padding:8px; border-radius:8px; background:rgba(0,0,0,0.03); font-size:12px;">
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-bottom:6px;">
          <label>型番:
            <select class="form-input rm-param-model" data-module="${mod.name}" style="padding:2px 6px; font-size:12px;">
              <option value="m3508" ${model === "m3508" ? "selected" : ""}>M3508 P19</option>
              <option value="m2006" ${model === "m2006" ? "selected" : ""}>M2006 P36</option>
              <option value="gm6020" ${model === "gm6020" ? "selected" : ""}>GM6020</option>
            </select>
          </label>
          <label>回転方向:
            <select class="form-input rm-param-dir" data-module="${mod.name}" style="padding:2px 6px; font-size:12px;">
              <option value="1" ${dir >= 0 ? "selected" : ""}>正転 (+1)</option>
              <option value="-1" ${dir < 0 ? "selected" : ""}>反転 (-1)</option>
            </select>
          </label>
        </div>
        <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:6px; margin-bottom:6px;">
          <label>速度Kp <input type="number" step="0.1" class="form-input rm-param-vkp" data-module="${mod.name}" value="${velKp}" style="padding:2px 6px; font-size:12px;"></label>
          <label>速度Ki <input type="number" step="0.05" class="form-input rm-param-vki" data-module="${mod.name}" value="${velKi}" style="padding:2px 6px; font-size:12px;"></label>
          <label>速度Kd <input type="number" step="0.05" class="form-input rm-param-vkd" data-module="${mod.name}" value="${velKd}" style="padding:2px 6px; font-size:12px;"></label>
        </div>
        <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:6px; margin-bottom:6px;">
          <label>位置Kp <input type="number" step="0.1" class="form-input rm-param-pkp" data-module="${mod.name}" value="${posKp}" style="padding:2px 6px; font-size:12px;"></label>
          <label>位置Ki <input type="number" step="0.01" class="form-input rm-param-pki" data-module="${mod.name}" value="${posKi}" style="padding:2px 6px; font-size:12px;"></label>
          <label>位置Kd <input type="number" step="0.05" class="form-input rm-param-pkd" data-module="${mod.name}" value="${posKd}" style="padding:2px 6px; font-size:12px;"></label>
        </div>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-bottom:8px;">
          <label>位置PID最大速度 (rpm) <input type="number" step="10" class="form-input rm-param-maxspd" data-module="${mod.name}" value="${maxSpd}" style="padding:2px 6px; font-size:12px;"></label>
          <label>最大出力制限 (cmd) <input type="number" step="500" class="form-input rm-param-maxout" data-module="${mod.name}" value="${maxOut}" style="padding:2px 6px; font-size:12px;"></label>
        </div>
        <button class="btn btn-primary btn-xs btn-save-rm-params" data-module="${mod.name}" style="width:100%;">設定を保存・反映</button>
      </div>
    `;
  }

  // --- モジュール操作イベントのバインディング ---
  function bindCardEvents(mod) {
    // UI操作送信トグルの状態変更イベント
    const toggleSend = document.getElementById(`toggle-send-${mod.name}`);
    if (toggleSend) {
      if (state.moduleSendToggles[mod.name] === undefined) {
        state.moduleSendToggles[mod.name] = false;
      }
      toggleSend.checked = state.moduleSendToggles[mod.name];

      toggleSend.addEventListener("change", (e) => {
        const isChecked = e.target.checked;
        state.moduleSendToggles[mod.name] = isChecked;

        if (isChecked) {
          appendTerminalLog(el.behaviorTerminal, `[SYSTEM] ${mod.name} へのリアルタイムUI操作送信を有効にしました。`, "system-msg");
        } else {
          appendTerminalLog(el.behaviorTerminal, `[SYSTEM] ${mod.name} へのリアルタイムUI操作送信を無効にしました（目標値をゼロに安全停止します）。`, "system-msg");

          // トグルOFF時は安全のために目標値を0に戻す
          if (mod.type === "mdd") {
            for (let i = 1; i <= 4; i++) {
              const slider = document.getElementById(`range-${mod.name}-m${i}`);
              const valEl = document.getElementById(`val-${mod.name}-m${i}`);
              if (slider) slider.value = 0;
              if (valEl) {
                const mode = mod.parameters?.[`m${i}`]?.mode ?? 0;
                const unit = mode === 0 ? "rps" : mode === 1 ? "deg" : "mm";
                valEl.textContent = `0.0 ${unit}`;
              }
            }
            if (state.ws && state.ws.readyState === WebSocket.OPEN) {
              state.ws.send(JSON.stringify({
                type: "mdd_cmd",
                name: mod.name,
                targets: [0, 0, 0, 0]
              }));
            }
          } else if (mod.type === "servo") {
            // サーボは中央（90度）にリセット
            for (let i = 1; i <= 6; i++) {
              const slider = document.getElementById(`range-${mod.name}-s${i}`);
              const valEl = document.getElementById(`val-${mod.name}-s${i}`);
              if (slider) slider.value = 90;
              if (valEl) valEl.textContent = `90°`;
            }
            if (state.ws && state.ws.readyState === WebSocket.OPEN) {
              state.ws.send(JSON.stringify({
                type: "servo_cmd",
                name: mod.name,
                angles: [90, 90, 90, 90, 90, 90]
              }));
            }
          } else if (mod.type === "robomas") {
            const slider = document.getElementById(`range-${mod.name}-rm`);
            const numInput = document.getElementById(`num-${mod.name}-rm`);
            const valEl = document.getElementById(`val-${mod.name}-rm`);
            const mode = mod.robomas?.control_mode || "current";
            const meta = getRobomasModeMeta(mode, mod.robomas?.motor_model || "m3508");
            if (slider) slider.value = 0;
            if (numInput) numInput.value = 0;
            if (valEl) valEl.textContent = `0 ${meta.unit}`;
            if (state.ws && state.ws.readyState === WebSocket.OPEN) {
              state.ws.send(JSON.stringify({
                type: "robomas_cmd",
                name: mod.name,
                target: 0,
                mode: "current"
              }));
            }
          }
        }
      });
    }

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

          // WebSocket経由で指令送信 (送信トグルがONのときのみ)
          if (state.moduleSendToggles[mod.name]) {
            sendMddTargetCommand(mod.name);
          }
        });
      });

      // モード変更イベントリスナーの追加
      const modeSelects = document.querySelectorAll(`.select-mdd-mode[data-module="${mod.name}"]`);
      modeSelects.forEach(sel => {
        sel.addEventListener("change", async (e) => {
          const motorIdx = e.target.getAttribute("data-motor");
          const modeVal = parseInt(e.target.value);

          const moduleObj = state.config.modules.find(m => m.name === mod.name);
          if (moduleObj) {
            if (!moduleObj.parameters) moduleObj.parameters = {};
            if (!moduleObj.parameters[`m${motorIdx}`]) {
              moduleObj.parameters[`m${motorIdx}`] = { p: 10.0, i: 0.0, d: 0.0, diameter: 100.0, direction: 1, mode: 0 };
            }
            moduleObj.parameters[`m${motorIdx}`].mode = modeVal;

            // スライダーおよび単位の動的更新
            const valEl = document.getElementById(`val-${mod.name}-m${motorIdx}`);
            const slider = document.getElementById(`range-${mod.name}-m${motorIdx}`);

            let min = -10;
            let max = 10;
            let step = 0.1;
            let unit = "rps";

            if (modeVal === 1) {
              min = -360;
              max = 360;
              step = 1;
              unit = "deg";
            } else if (modeVal === 2) {
              min = -1000;
              max = 1000;
              step = 1;
              unit = "mm";
            }

            if (slider) {
              slider.min = min;
              slider.max = max;
              slider.step = step;
              slider.value = 0; // モード切替時にリセット
            }
            if (valEl) valEl.textContent = `0.0 ${unit}`;

            // 設定ファイルを自動保存
            await saveConfigToServer();
          }
        });
      });

      // 目標値（スライダー値）の微調整ボタンイベントリスナー
      const adjustBtns = document.querySelectorAll(`.btn-target-adjust[data-module="${mod.name}"]`);
      adjustBtns.forEach(btn => {
        btn.addEventListener("click", (e) => {
          const motorIdx = btn.getAttribute("data-motor");
          const action = btn.getAttribute("data-action");

          const slider = document.getElementById(`range-${mod.name}-m${motorIdx}`);
          const valEl = document.getElementById(`val-${mod.name}-m${motorIdx}`);
          if (!slider) return;

          let curVal = parseFloat(slider.value) || 0.0;
          let step = parseFloat(slider.step) || 0.1;

          if (action === "plus") {
            curVal = Math.min(parseFloat(slider.max), curVal + step);
          } else {
            curVal = Math.max(parseFloat(slider.min), curVal - step);
          }

          slider.value = curVal;

          // モード表示の読み込み
          const mode = mod.parameters?.[`m${motorIdx}`]?.mode ?? 0;
          const unit = mode === 0 ? "rps" : mode === 1 ? "deg" : "mm";
          if (valEl) {
            valEl.textContent = `${curVal.toFixed(mode === 0 ? 1 : 0)} ${unit}`;
          }

          // WebSocket経由で指令送信 (送信トグルがONのときのみ)
          if (state.moduleSendToggles[mod.name]) {
            sendMddTargetCommand(mod.name);
          }
        });
      });

      // PIDの向き (direction) 変更イベントリスナーの追加
      const dirSelects = document.querySelectorAll(`.select-mdd-dir[data-module="${mod.name}"]`);
      dirSelects.forEach(sel => {
        sel.addEventListener("change", async (e) => {
          const motorIdx = e.target.getAttribute("data-motor");
          const dirVal = parseInt(e.target.value) || 1;

          const moduleObj = state.config.modules.find(m => m.name === mod.name);
          if (moduleObj) {
            if (!moduleObj.parameters) moduleObj.parameters = {};
            if (!moduleObj.parameters[`m${motorIdx}`]) {
              moduleObj.parameters[`m${motorIdx}`] = { p: 10.0, i: 0.0, d: 0.0, diameter: 100.0, direction: 1, mode: 0 };
            }
            moduleObj.parameters[`m${motorIdx}`].direction = dirVal;

            // 設定ファイルを自動保存
            await saveConfigToServer();
          }
        });
      });

      // 車輪直径 (diameter) 変更イベントリスナーの追加
      const wheelInputs = document.querySelectorAll(`.input-mdd-wheel[data-module="${mod.name}"]`);
      wheelInputs.forEach(input => {
        input.addEventListener("change", async (e) => {
          const motorIdx = e.target.getAttribute("data-motor");
          const wheelVal = parseFloat(e.target.value) || 100.0;

          const moduleObj = state.config.modules.find(m => m.name === mod.name);
          if (moduleObj) {
            if (!moduleObj.parameters) moduleObj.parameters = {};
            if (!moduleObj.parameters[`m${motorIdx}`]) {
              moduleObj.parameters[`m${motorIdx}`] = { p: 10.0, i: 0.0, d: 0.0, diameter: 100.0, direction: 1, mode: 0 };
            }
            moduleObj.parameters[`m${motorIdx}`].diameter = wheelVal;

            // 設定ファイルを自動保存
            await saveConfigToServer();
          }
        });
      });

      // PID値変更イベントリスナーの追加
      const pidInputs = document.querySelectorAll(`.input-mdd-p[data-module="${mod.name}"], .input-mdd-i[data-module="${mod.name}"], .input-mdd-d[data-module="${mod.name}"]`);
      pidInputs.forEach(input => {
        input.addEventListener("change", async (e) => {
          const motorIdx = e.target.getAttribute("data-motor");
          const moduleObj = state.config.modules.find(m => m.name === mod.name);
          if (moduleObj) {
            if (!moduleObj.parameters) moduleObj.parameters = {};
            if (!moduleObj.parameters[`m${motorIdx}`]) {
              moduleObj.parameters[`m${motorIdx}`] = { p: 10.0, i: 0.0, d: 0.0, diameter: 100.0, direction: 1, mode: 0 };
            }

            const val = parseFloat(e.target.value) || 0.0;
            if (e.target.classList.contains("input-mdd-p")) {
              moduleObj.parameters[`m${motorIdx}`].p = val;
            } else if (e.target.classList.contains("input-mdd-i")) {
              moduleObj.parameters[`m${motorIdx}`].i = val;
            } else if (e.target.classList.contains("input-mdd-d")) {
              moduleObj.parameters[`m${motorIdx}`].d = val;
            }

            // 設定ファイルを自動保存
            await saveConfigToServer();
          }
        });
      });

      // PIDゲインの微調整ボタン (+ / -) イベントリスナーの追加
      const pidAdjustBtns = document.querySelectorAll(`.btn-pid-adjust[data-module="${mod.name}"]`);
      pidAdjustBtns.forEach(btn => {
        btn.addEventListener("click", async () => {
          const motorIdx = btn.getAttribute("data-motor");
          const param = btn.getAttribute("data-param");
          const action = btn.getAttribute("data-action");
          const inputEl = document.querySelector(`.input-mdd-${param}[data-module="${mod.name}"][data-motor="${motorIdx}"]`);
          if (!inputEl) return;

          const step = parseFloat(inputEl.step) || (param === "p" ? 0.1 : 0.01);
          const curVal = parseFloat(inputEl.value) || 0.0;
          const nextVal = Math.max(0, parseFloat((curVal + (action === "plus" ? step : -step)).toFixed(3)));
          inputEl.value = nextVal;

          const moduleObj = state.config.modules.find(m => m.name === mod.name);
          if (moduleObj) {
            if (!moduleObj.parameters) moduleObj.parameters = {};
            if (!moduleObj.parameters[`m${motorIdx}`]) {
              moduleObj.parameters[`m${motorIdx}`] = { p: 10.0, i: 0.0, d: 0.0, diameter: 100.0, direction: 1, mode: 0 };
            }
            moduleObj.parameters[`m${motorIdx}`][param] = nextVal;
            await saveConfigToServer();
          }
        });
      });

    } else if (mod.type === "servo") {
      // サーボスライダーのドラッグイベント
      const sliders = document.querySelectorAll(`.range-servo[data-module="${mod.name}"]`);
      sliders.forEach(slider => {
        slider.addEventListener("input", (e) => {
          const servoIdx = e.target.getAttribute("data-servo");
          const valEl = document.getElementById(`val-${mod.name}-s${servoIdx}`);
          valEl.textContent = `${e.target.value}°`;

          // 即時送信 (送信トグルがONのときのみ)
          if (state.moduleSendToggles[mod.name]) {
            sendServoAngleCommand(mod.name);
          }
        });
      });

    } else if (mod.type === "solenoid") {
      // ソレノイドバルブのON/OFFトグルイベント
      const btns = document.querySelectorAll(`.btn-solenoid[data-module="${mod.name}"]`);
      btns.forEach(btn => {
        btn.addEventListener("click", (e) => {
          btn.classList.toggle("active");

          // 即時送信 (送信トグルがONのときのみ)
          if (state.moduleSendToggles[mod.name]) {
            sendSolenoidCommand(mod.name);
          } else {
            // トグルOFFの場合はクリックされてもスタイルをもとに戻す
            btn.classList.toggle("active");
            appendTerminalLog(el.behaviorTerminal, `[WARNING] ${mod.name} の「UI操作送信」がOFFのためバルブ制御は送信されません。`, "error-msg");
          }
        });
      });

    } else if (mod.type === "robomas") {
      const slider = document.getElementById(`range-${mod.name}-rm`);
      const numInput = document.getElementById(`num-${mod.name}-rm`);
      const valEl = document.getElementById(`val-${mod.name}-rm`);
      const modeSel = document.getElementById(`rm-mode-${mod.name}`);

      const syncTargetUi = (val) => {
        const mode = modeSel ? modeSel.value : (mod.robomas?.control_mode || "current");
        const meta = getRobomasModeMeta(mode, mod.robomas?.motor_model || "m3508");
        const numVal = parseFloat(val) || 0;
        if (slider) slider.value = Math.max(meta.min, Math.min(meta.max, numVal));
        if (numInput) numInput.value = numVal;
        if (valEl) valEl.textContent = `${numVal} ${meta.unit}`;
        if (state.moduleSendToggles[mod.name]) {
          sendRobomasCommand(mod.name);
        }
      };

      if (slider) {
        slider.addEventListener("input", (e) => syncTargetUi(e.target.value));
      }
      if (numInput) {
        numInput.addEventListener("change", (e) => syncTargetUi(e.target.value));
      }

      const btnZero = document.querySelector(`.btn-rm-zero[data-module="${mod.name}"]`);
      if (btnZero) {
        btnZero.addEventListener("click", () => syncTargetUi(0));
      }

      const btnResetOrigin = document.querySelector(`.btn-rm-reset-origin[data-module="${mod.name}"]`);
      if (btnResetOrigin) {
        btnResetOrigin.addEventListener("click", () => {
          if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            state.ws.send(JSON.stringify({ type: "robomas_reset_zero", name: mod.name }));
          }
        });
      }

      if (modeSel) {
        modeSel.addEventListener("change", async (e) => {
          const newMode = e.target.value;
          if (!mod.robomas) mod.robomas = {};
          mod.robomas.control_mode = newMode;
          const meta = getRobomasModeMeta(newMode, mod.robomas.motor_model || "m3508");
          if (slider) {
            slider.min = meta.min;
            slider.max = meta.max;
            slider.step = meta.step;
            slider.value = 0;
          }
          if (numInput) {
            numInput.step = meta.step;
            numInput.value = 0;
          }
          if (valEl) valEl.textContent = `0 ${meta.unit}`;
          await fetch("/api/config/update", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(state.config)
          }).catch(() => {});
          if (state.moduleSendToggles[mod.name]) {
            sendRobomasCommand(mod.name);
          }
        });
      }

      const btnToggle = document.querySelector(`.btn-toggle-rm-params[data-module="${mod.name}"]`);
      const panel = document.getElementById(`rm-params-panel-${mod.name}`);
      if (btnToggle && panel) {
        btnToggle.addEventListener("click", () => {
          panel.style.display = panel.style.display === "none" ? "block" : "none";
        });
      }

      const btnSave = document.querySelector(`.btn-save-rm-params[data-module="${mod.name}"]`);
      if (btnSave) {
        btnSave.addEventListener("click", async () => {
          if (!mod.robomas) mod.robomas = {};
          mod.robomas.motor_model = document.querySelector(`.rm-param-model[data-module="${mod.name}"]`).value;
          mod.robomas.direction = parseInt(document.querySelector(`.rm-param-dir[data-module="${mod.name}"]`).value, 10) || 1;
          mod.robomas.control_mode = modeSel ? modeSel.value : (mod.robomas.control_mode || "current");
          mod.robomas.vel_kp = parseFloat(document.querySelector(`.rm-param-vkp[data-module="${mod.name}"]`).value) || 0;
          mod.robomas.vel_ki = parseFloat(document.querySelector(`.rm-param-vki[data-module="${mod.name}"]`).value) || 0;
          mod.robomas.vel_kd = parseFloat(document.querySelector(`.rm-param-vkd[data-module="${mod.name}"]`).value) || 0;
          mod.robomas.pos_kp = parseFloat(document.querySelector(`.rm-param-pkp[data-module="${mod.name}"]`).value) || 0;
          mod.robomas.pos_ki = parseFloat(document.querySelector(`.rm-param-pki[data-module="${mod.name}"]`).value) || 0;
          mod.robomas.pos_kd = parseFloat(document.querySelector(`.rm-param-pkd[data-module="${mod.name}"]`).value) || 0;
          mod.robomas.max_speed_rpm = parseFloat(document.querySelector(`.rm-param-maxspd[data-module="${mod.name}"]`).value) || 300;
          mod.robomas.max_output = parseFloat(document.querySelector(`.rm-param-maxout[data-module="${mod.name}"]`).value) || 10000;

          try {
            const res = await fetch("/api/config/update", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(state.config)
            });
            const data = await res.json();
            appendTerminalLog(el.behaviorTerminal, `[SYSTEM] ${mod.name} のRoboMaster設定を保存しました: ${data.message}`);
            await loadConfigAndRender();
          } catch (err) {
            appendTerminalLog(el.behaviorTerminal, `[ERROR] 設定保存失敗: ${err}`, "error-msg");
          }
        });
      }
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

  function sendRobomasCommand(moduleName) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
    const numInput = document.getElementById(`num-${moduleName}-rm`);
    const slider = document.getElementById(`range-${moduleName}-rm`);
    const modeSel = document.getElementById(`rm-mode-${moduleName}`);
    const target = numInput ? parseFloat(numInput.value) || 0 : (slider ? parseFloat(slider.value) || 0 : 0);
    const payload = {
      type: "robomas_cmd",
      name: moduleName,
      target: target
    };
    if (modeSel && modeSel.value) {
      payload.mode = modeSel.value;
    }
    state.ws.send(JSON.stringify(payload));
  }

  function updateRobomasCardFeedback(name, data) {
    const angleEl = document.getElementById(`rm-fb-angle-${name}`);
    const speedEl = document.getElementById(`rm-fb-speed-${name}`);
    const currEl = document.getElementById(`rm-fb-curr-${name}`);
    const tempEl = document.getElementById(`rm-fb-temp-${name}`);
    if (angleEl) angleEl.textContent = `${Number(data.angle_deg || 0).toFixed(1)}°`;
    if (speedEl) speedEl.textContent = `${data.speed_rpm ?? 0} rpm`;
    if (currEl) currEl.textContent = `${Number(data.current_a || 0).toFixed(2)} A`;
    if (tempEl) tempEl.textContent = `${data.temperature ?? 0}°C / ${data.output_cmd ?? 0}`;
  }

  // --- 8. WebSocket テレメトリ（フィードバック）のカード反映 ---
  const pendingMddFeedback = new Map();
  let mddFeedbackRafScheduled = false;

  function flushMddCardFeedbackDOM() {
    mddFeedbackRafScheduled = false;
    for (const [name, data] of pendingMddFeedback.entries()) {
      // Limitスイッチ
      for (let i = 0; i < 4; i++) {
        const swEl = document.getElementById(`sw-${name}-${i + 1}`);
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
        const fbEl = document.getElementById(`lbl-${name}-m${i + 1}-fb`);
        if (fbEl) {
          const ang = data.angles[i].toFixed(1);
          const spd = data.speeds[i].toFixed(2);
          fbEl.textContent = `${ang}° / ${spd} rps`;
        }
      }

      // エラー状態のチェック
      const card = document.getElementById(`module-card-${name}`);
      if (card) {
        card.style.borderColor = data.error_code > 0 ? "var(--color-danger)" : "var(--border-light)";
      }
    }
    pendingMddFeedback.clear();
  }

  function updateMddCardFeedback(name, data) {
    pendingMddFeedback.set(name, data);
    if (!mddFeedbackRafScheduled) {
      mddFeedbackRafScheduled = true;
      requestAnimationFrame(flushMddCardFeedbackDOM);
    }

    // マイコン側のモード判定による自動リセット検知（全MDDの状態を個別に管理しピンポン発振を防止）
    if (typeof data.system_status !== 'undefined') {
      const prevStatus = state.mddStatuses[name];
      state.mddStatuses[name] = data.system_status;

      if (!state.isSendingParams) {
        const mddModules = (state.config?.modules || []).filter(m => m.type === "mdd");
        const allRunning = mddModules.length > 0 && mddModules.every(m => state.mddStatuses[m.name] === 1);

        if (allRunning && state.controlMode !== "CONTROL") {
          state.controlMode = "CONTROL";
          if (el.lblControlModeStatus) {
            el.lblControlModeStatus.innerHTML = 'ステータス: <span class="badge badge-success">制御実行中 (Control Mode)</span>';
          }
        } else if (data.system_status === 0 && (state.controlMode === "CONTROL" || prevStatus === 1)) {
          state.controlMode = "SETUP";
          if (el.lblControlModeStatus) {
            el.lblControlModeStatus.innerHTML = 'ステータス: <span class="badge badge-warning">パラメータ未送信 (待機中)</span>';
          }
          appendTerminalLog(el.behaviorTerminal, `[SYSTEM] マイコン '${name}' の待機状態（パラメータ設定モード）へのリセットを検知しました。パラメータを再送信してください。`, "system-msg");
        }
      }
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

  // Ethernet / USB 接続モードタブ切り替え
  if (el.tabModeEth && el.tabModeUsb) {
    el.tabModeEth.addEventListener("click", () => {
      el.tabModeEth.className = "btn btn-sm btn-primary";
      el.tabModeUsb.className = "btn btn-sm btn-secondary";
      el.panelConnEth.style.display = "block";
      el.panelConnUsb.style.display = "none";
    });

    el.tabModeUsb.addEventListener("click", () => {
      el.tabModeUsb.className = "btn btn-sm btn-primary";
      el.tabModeEth.className = "btn btn-sm btn-secondary";
      el.panelConnUsb.style.display = "block";
      el.panelConnEth.style.display = "none";
    });
  }

  // Ethernet-CAN 設定の初期ロード
  async function loadEthCanConfig() {
    try {
      const res = await fetch("/api/eth_can/config");
      const cfg = await res.json();
      if (cfg.target_ip && el.txtEthIp) el.txtEthIp.value = cfg.target_ip;
      if (cfg.target_port && el.txtEthPort) el.txtEthPort.value = cfg.target_port;
      if (cfg.can_channel && el.selEthCanChannel) el.selEthCanChannel.value = cfg.can_channel;
    } catch (e) {
      // 読み込み失敗時は初期値を維持
    }
  }
  loadEthCanConfig();

  // Ethernet-CAN チャンネル切り替え (接続中も即座に反映)
  if (el.selEthCanChannel) {
    el.selEthCanChannel.addEventListener("change", async () => {
      const ch = el.selEthCanChannel.value;
      try {
        const res = await fetch("/api/eth_can/channel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ can_channel: ch })
        });
        const data = await res.json();
        if (data.success) {
          appendTerminalLog(el.behaviorTerminal, `[SYSTEM] ${data.message}`, "system-msg");
        }
      } catch (err) {
        appendTerminalLog(el.behaviorTerminal, `[ERROR] チャンネル切替に失敗しました: ${err}`, "error-msg");
      }
    });
  }

  // Ethernet-CAN 接続ボタン
  if (el.btnConnectEth) {
    el.btnConnectEth.addEventListener("click", async () => {
      const ip = el.txtEthIp.value.trim();
      const port = parseInt(el.txtEthPort.value.trim(), 10) || 5000;
      const canChannel = el.selEthCanChannel ? el.selEthCanChannel.value : "can1";

      appendTerminalLog(el.behaviorTerminal, `Ethernet-CAN (${ip}:${port} / ${canChannel.toUpperCase()}) への接続要求を送信中...`);

      try {
        const res = await fetch("/api/eth_can/connect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target_ip: ip, target_port: port, can_channel: canChannel })
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
  }

  // Ethernet-CAN 切断ボタン
  if (el.btnDisconnectEth) {
    el.btnDisconnectEth.addEventListener("click", async () => {
      appendTerminalLog(el.behaviorTerminal, "Ethernet-CAN 切断要求を送信中...");
      try {
        const res = await fetch("/api/eth_can/disconnect", { method: "POST" });
        const data = await res.json();
        appendTerminalLog(el.behaviorTerminal, `[SYSTEM] ${data.message}`, "system-msg");
      } catch (err) {
        appendTerminalLog(el.behaviorTerminal, `[ERROR] 通信失敗: ${err}`, "error-msg");
      }
    });
  }

  // 自動探索チェックボックスの挙動
  if (el.chkAutoConnect) {
    const syncAutoConnectUI = () => {
      const isAuto = el.chkAutoConnect.checked;
      if (el.selCanPort) el.selCanPort.disabled = isAuto;
      if (el.btnRefreshPorts) el.btnRefreshPorts.disabled = isAuto;
    };
    el.chkAutoConnect.addEventListener("change", syncAutoConnectUI);
    syncAutoConnectUI();
  }

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

  // パラメータ送信 ＆ 全マイコン応答待機 ＆ 制御開始
  el.btnSendParams.addEventListener("click", async () => {
    state.isSendingParams = true;
    state.controlMode = "SENDING";
    if (el.lblControlModeStatus) {
      el.lblControlModeStatus.innerHTML = 'ステータス: <span class="badge badge-warning">パラメータ送信・応答待機中...</span>';
    }
    appendTerminalLog(el.behaviorTerminal, "制御パラメータを送信し、全マイコンからの設定完了応答を待機しています...");
    try {
      const res = await fetch("/api/start_control", { method: "POST" });
      const data = await res.json();
      state.isSendingParams = false;

      if (data.success) {
        (state.config?.modules || []).forEach(m => {
          if (m.type === "mdd") state.mddStatuses[m.name] = 1;
        });
        appendTerminalLog(el.behaviorTerminal, `[SYSTEM] ${data.message}`, "system-msg");
        if (el.lblControlModeStatus) {
          el.lblControlModeStatus.innerHTML = 'ステータス: <span class="badge badge-success">制御実行中 (Control Mode)</span>';
        }
        state.controlMode = "CONTROL";
      } else {
        state.controlMode = "SETUP";
        if (el.lblControlModeStatus) {
          el.lblControlModeStatus.innerHTML = 'ステータス: <span class="badge badge-warning">パラメータ未送信 (待機中)</span>';
        }
        appendTerminalLog(el.behaviorTerminal, `[ERROR] 送信失敗: ${data.message}`, "error-msg");
      }
    } catch (err) {
      state.isSendingParams = false;
      state.controlMode = "SETUP";
      if (el.lblControlModeStatus) {
        el.lblControlModeStatus.innerHTML = 'ステータス: <span class="badge badge-warning">パラメータ未送信 (待機中)</span>';
      }
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

  // --- 動作プログラムファイル一覧の動的取得とフォルダー連携 ---
  const btnRefreshBehaviorList = document.getElementById("btn-refresh-behavior-list");
  const btnDeleteBehavior = document.getElementById("btn-delete-behavior");
  const txtNewBehaviorName = document.getElementById("txt-new-behavior-name");
  const btnCreateBehavior = document.getElementById("btn-create-behavior");
  const btnOpenBehaviorFolder = document.getElementById("btn-open-behavior-folder");

  if (btnOpenBehaviorFolder) {
    btnOpenBehaviorFolder.addEventListener("click", async () => {
      try {
        const res = await fetch("/api/behavior/open_folder", { method: "POST" });
        const data = await res.json();
        if (data.success) {
          appendTerminalLog(el.behaviorTerminal, `[SYSTEM] ${data.message}`, "system-msg");
        } else {
          appendTerminalLog(el.behaviorTerminal, `[ERROR] ${data.message}`, "error-msg");
        }
      } catch (err) {
        appendTerminalLog(el.behaviorTerminal, `[ERROR] フォルダーを開けませんでした: ${err}`, "error-msg");
      }
    });
  }

  async function refreshBehaviors(preferredSelect = "") {
    try {
      const prevSelect = preferredSelect || el.selBehaviorScript.value;
      const res = await fetch("/api/behavior/list");
      const data = await res.json();

      if (!data.success || !data.behaviors) {
        console.error("プログラムファイル取得失敗:", data.error || "不明なエラー");
        el.selBehaviorScript.innerHTML = '<option value="">ファイルが見つかりません</option>';
        return;
      }

      // ドロップダウンをクリア
      el.selBehaviorScript.innerHTML = '';

      // 取得したファイル一覧をオプションとして追加
      if (data.behaviors.length === 0) {
        el.selBehaviorScript.innerHTML = '<option value="">プログラムファイルがありません</option>';
      } else {
        data.behaviors.forEach(filename => {
          const option = document.createElement("option");
          option.value = filename;
          option.textContent = filename;
          el.selBehaviorScript.appendChild(option);
        });
        if (prevSelect && data.behaviors.includes(prevSelect)) {
          el.selBehaviorScript.value = prevSelect;
        }
      }
    } catch (err) {
      console.error("プログラムファイル取得失敗:", err);
      el.selBehaviorScript.innerHTML = '<option value="">通信エラー</option>';
    }
  }

  if (btnRefreshBehaviorList) {
    btnRefreshBehaviorList.addEventListener("click", () => refreshBehaviors());
  }

  if (btnCreateBehavior && txtNewBehaviorName) {
    btnCreateBehavior.addEventListener("click", async () => {
      const name = txtNewBehaviorName.value.trim();
      if (!name) {
        alert("新しいスクリプトのファイル名を入力してください (例: my_robot.py)");
        return;
      }
      try {
        const res = await fetch("/api/behavior/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name })
        });
        const data = await res.json();
        if (data.success) {
          txtNewBehaviorName.value = "";
          appendTerminalLog(el.behaviorTerminal, `[SYSTEM] ${data.message}`, "system-msg");
          await refreshBehaviors(data.name);
        } else {
          appendTerminalLog(el.behaviorTerminal, `[ERROR] ${data.message}`, "error-msg");
          alert(data.message);
        }
      } catch (err) {
        appendTerminalLog(el.behaviorTerminal, `[ERROR] 作成エラー: ${err}`, "error-msg");
      }
    });
  }

  if (btnDeleteBehavior) {
    btnDeleteBehavior.addEventListener("click", async () => {
      const target = el.selBehaviorScript.value;
      if (!target) return;
      if (!confirm(`スクリプト '${target}' を本当に削除しますか？`)) return;
      try {
        const res = await fetch("/api/behavior/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: target })
        });
        const data = await res.json();
        if (data.success) {
          appendTerminalLog(el.behaviorTerminal, `[SYSTEM] ${data.message}`, "system-msg");
          await refreshBehaviors();
        } else {
          appendTerminalLog(el.behaviorTerminal, `[ERROR] ${data.message}`, "error-msg");
          alert(data.message);
        }
      } catch (err) {
        appendTerminalLog(el.behaviorTerminal, `[ERROR] 削除エラー: ${err}`, "error-msg");
      }
    });
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

  // プロファイルの削除（グローバル関数化）
  window.deleteProfileFile = async (name) => {
    if (!confirm(`プロファイル '${name}' を本当に削除しますか？`)) {
      return;
    }
    appendTerminalLog(el.behaviorTerminal, `プロファイル '${name}' を削除中...`);
    try {
      const res = await fetch(`/api/profiles/delete?name=${name}`, { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        appendTerminalLog(el.behaviorTerminal, `[SYSTEM] ${data.message}`, "system-msg");
        refreshProfiles();
      } else {
        appendTerminalLog(el.behaviorTerminal, `[ERROR] 削除失敗: ${data.detail || data.message}`, "error-msg");
      }
    } catch (err) {
      appendTerminalLog(el.behaviorTerminal, `[ERROR] 削除失敗: ${err}`, "error-msg");
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
    if (!script) {
      alert("実行するスクリプトを選択してください。");
      return;
    }
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

  let editingModuleOriginalName = null;

  // モジュール種類ごとの初期値定義
  const MODULE_TYPE_DEFAULTS = {
    mdd: { name: "MDD1", base_id: "0x200" },
    servo: { name: "Servo1", base_id: "0x100" },
    solenoid: { name: "SV1", base_id: "0x300" },
    robomas: { name: "RM1", base_id: "1" }
  };
  const DEFAULT_MODULE_NAMES = new Set(Object.values(MODULE_TYPE_DEFAULTS).map(d => d.name));
  const DEFAULT_MODULE_IDS = new Set(Object.values(MODULE_TYPE_DEFAULTS).map(d => d.base_id));

  function updateModalTypeUi(type) {
    const isRobomas = type === "robomas";
    if (el.modalRobomasGroup) {
      el.modalRobomasGroup.style.display = isRobomas ? "block" : "none";
    }
    if (el.modalIdLabel) {
      el.modalIdLabel.textContent = isRobomas
        ? "Motor ID (1〜8, GM6020は1〜7)"
        : "Base CAN ID (Hex形式)";
    }
    if (el.modalModuleId) {
      el.modalModuleId.placeholder = isRobomas ? "例: 1" : "例: 0x200";
    }
  }

  // 新規追加時に種類に応じた初期値を適用する（手入力済みの項目は上書きしない）
  function applyDefaultModuleInputs(type, force = false) {
    const defaults = MODULE_TYPE_DEFAULTS[type];
    if (!defaults) return;
    const currentName = el.modalModuleName.value.trim();
    const currentId = el.modalModuleId.value.trim();
    if (force || !currentName || DEFAULT_MODULE_NAMES.has(currentName)) {
      el.modalModuleName.value = defaults.name;
    }
    if (force || !currentId || DEFAULT_MODULE_IDS.has(currentId)) {
      el.modalModuleId.value = defaults.base_id;
    }
  }

  window.editModule = (name) => {
    const mod = state.config.modules.find(m => m.name === name);
    if (!mod) return;
    editingModuleOriginalName = mod.name;
    el.modalModuleType.value = mod.type;
    el.modalModuleName.value = mod.name;
    el.modalModuleId.value = mod.base_id;
    if (el.modalModuleChannel) {
      el.modalModuleChannel.value = (mod.can_channel && ["can1", "can2", "both"].includes(mod.can_channel))
        ? mod.can_channel
        : "default";
    }
    if (el.modalRobomasModel && el.modalRobomasMode) {
      const rm = mod.robomas || {};
      el.modalRobomasModel.value = rm.motor_model || "m3508";
      el.modalRobomasMode.value = rm.control_mode || "current";
    }
    updateModalTypeUi(mod.type);
    el.modalModuleDesc.value = mod.description || "";
    el.modal.classList.add("active");
  };

  // モーダル制御
  el.btnAddModuleModal.addEventListener("click", () => {
    editingModuleOriginalName = null;
    el.modalModuleType.value = "mdd";
    updateModalTypeUi("mdd");
    applyDefaultModuleInputs("mdd", true);
    if (el.modalRobomasModel) el.modalRobomasModel.value = "m3508";
    if (el.modalRobomasMode) el.modalRobomasMode.value = "current";
    if (el.modalModuleChannel) el.modalModuleChannel.value = "default";
    el.modalModuleDesc.value = "";
    el.modal.classList.add("active");
  });

  el.modalModuleType.addEventListener("change", () => {
    updateModalTypeUi(el.modalModuleType.value);
    if (editingModuleOriginalName) return;
    applyDefaultModuleInputs(el.modalModuleType.value, false);
  });

  if (el.modalRobomasModel) {
    el.modalRobomasModel.addEventListener("change", () => {
      if (editingModuleOriginalName || !el.modalRobomasMode) return;
      el.modalRobomasMode.value = el.modalRobomasModel.value === "gm6020" ? "voltage" : "current";
    });
  }

  el.btnCloseModal.addEventListener("click", closeModal);
  el.btnCancelModal.addEventListener("click", closeModal);

  function closeModal() {
    el.modal.classList.remove("active");
    editingModuleOriginalName = null;
    // フォームクリア
    el.modalModuleName.value = "";
    el.modalModuleId.value = "";
    if (el.modalModuleChannel) el.modalModuleChannel.value = "default";
    el.modalModuleDesc.value = "";
  }

  el.btnSaveModule.addEventListener("click", async () => {
    const type = el.modalModuleType.value;
    const name = el.modalModuleName.value.trim();
    const id = el.modalModuleId.value.trim();
    const ch = el.modalModuleChannel ? el.modalModuleChannel.value : "default";
    const desc = el.modalModuleDesc.value.trim();

    if (!name || !id) {
      alert("名前とBase CAN IDは必須です。");
      return;
    }

    if (editingModuleOriginalName) {
      if (name !== editingModuleOriginalName && state.config.modules.some(m => m.name === name)) {
        alert("すでに同じ名前のモジュールが存在します。");
        return;
      }
      const mod = state.config.modules.find(m => m.name === editingModuleOriginalName);
      if (mod) {
        mod.name = name;
        mod.type = type;
        mod.base_id = id;
        mod.description = desc;
        if (ch === "can1" || ch === "can2" || ch === "both") {
          mod.can_channel = ch;
        } else {
          delete mod.can_channel;
        }
        if (type === "mdd" && !mod.parameters) {
          mod.parameters = {
            m1: { p: 10.0, i: 0.0, d: 0.0, diameter: 100.0, direction: 1, mode: 0 },
            m2: { p: 10.0, i: 0.0, d: 0.0, diameter: 100.0, direction: 1, mode: 0 },
            m3: { p: 10.0, i: 0.0, d: 0.0, diameter: 100.0, direction: 1, mode: 0 },
            m4: { p: 10.0, i: 0.0, d: 0.0, diameter: 100.0, direction: 1, mode: 0 }
          };
        }
        if (type === "robomas") {
          const rmModel = el.modalRobomasModel ? el.modalRobomasModel.value : "m3508";
          const rmMode = el.modalRobomasMode ? el.modalRobomasMode.value : "current";
          if (!mod.robomas) {
            mod.robomas = {
              motor_model: rmModel,
              control_mode: rmMode,
              vel_kp: 20.0, vel_ki: 0.0, vel_kd: 0.0,
              pos_kp: 3.0, pos_ki: 0.0, pos_kd: 0.0,
              max_speed_rpm: 300.0,
              max_output: rmModel === "gm6020" && rmMode !== "current" ? 25000.0 : 10000.0,
              direction: 1
            };
          } else {
            mod.robomas.motor_model = rmModel;
            mod.robomas.control_mode = rmMode;
          }
        }
      }
    } else {
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
      if (ch === "can1" || ch === "can2" || ch === "both") {
        newMod.can_channel = ch;
      }
      if (type === "robomas") {
        const rmModel = el.modalRobomasModel ? el.modalRobomasModel.value : "m3508";
        const rmMode = el.modalRobomasMode ? el.modalRobomasMode.value : "current";
        newMod.robomas = {
          motor_model: rmModel,
          control_mode: rmMode,
          vel_kp: 20.0, vel_ki: 0.0, vel_kd: 0.0,
          pos_kp: 3.0, pos_ki: 0.0, pos_kd: 0.0,
          max_speed_rpm: 300.0,
          max_output: rmModel === "gm6020" && rmMode !== "current" ? 25000.0 : 10000.0,
          direction: 1
        };
      }

      // MDD特有の初期パラメータ構造を追加
      if (type === "mdd") {
        newMod.parameters = {
          m1: { p: 10.0, i: 0.0, d: 0.0, diameter: 100.0, direction: 1, mode: 0 },
          m2: { p: 10.0, i: 0.0, d: 0.0, diameter: 100.0, direction: 1, mode: 0 },
          m3: { p: 10.0, i: 0.0, d: 0.0, diameter: 100.0, direction: 1, mode: 0 },
          m4: { p: 10.0, i: 0.0, d: 0.0, diameter: 100.0, direction: 1, mode: 0 }
        };
      }

      state.config.modules.push(newMod);
    }

    try {
      const res = await fetch("/api/config/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state.config)
      });
      const data = await res.json();
      appendTerminalLog(el.behaviorTerminal, `モジュール設定を保存しました: ${data.message}`);

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
          state.ws.send(JSON.stringify({ type: "solenoid_cmd", name: mod.name, valves: new Array(12).fill(false) }));
        }
      } else if (mod.type === "robomas") {
        const slider = document.getElementById(`range-${mod.name}-rm`);
        const numInput = document.getElementById(`num-${mod.name}-rm`);
        if (slider) slider.value = 0;
        if (numInput) numInput.value = 0;
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
          state.ws.send(JSON.stringify({ type: "robomas_cmd", name: mod.name, target: 0, mode: "current" }));
        }
      }
    });

    // 動作プログラムの強制終了
    await fetch("/api/behavior/stop", { method: "POST" });
  });

  // 設定保存用APIの呼び出し
  async function saveConfigToServer() {
    try {
      await fetch("/api/config/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state.config)
      });
    } catch (err) {
      console.error("設定の自動保存に失敗しました:", err);
    }
  }

  // --- 13. 初期化処理の実行 ---
  connectWebSocket();
  loadConfigAndRender();
  refreshPorts();
  refreshProfiles();
  refreshBehaviors();

  // 全画面表示の切り替え
  const btnFullscreen = document.getElementById("btn-fullscreen-toggle");
  if (btnFullscreen) {
    btnFullscreen.addEventListener("click", () => {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(err => {
          console.error(`全画面表示への切り替えに失敗しました: ${err.message}`);
        });
        btnFullscreen.innerHTML = '<i class="fa-solid fa-compress"></i> 画面縮小';
      } else {
        document.exitFullscreen();
        btnFullscreen.innerHTML = '<i class="fa-solid fa-expand"></i> 全画面表示';
      }
    });
  }

  // ==========================================================================
  // --- 14. Blockly ビジュアルマクロ統合 ＆ Pythonコードリアルタイム生成 ---
  // ==========================================================================

  // 登録済みモジュールの一覧を動的に取得するドロップダウン生成ヘルパー
  const getModuleOptionsDropdown = function (type) {
    return function () {
      if (!state.config || !state.config.modules) {
        return [["未選択", "none"]];
      }
      const mods = state.config.modules.filter(m => m.type === type);
      let options = mods.map(m => [m.name, m.name]);
      if (options.length === 0) {
        options.push(["登録なし", "none"]);
      }
      return options;
    };
  };

  // Blockly カスタムブロック定義
  Blockly.Blocks['mdd_move'] = {
    init: function () {
      this.appendDummyInput()
        .appendField("MDD モータ制御")
        .appendField(new Blockly.FieldDropdown(getModuleOptionsDropdown('mdd')), "NAME");
      this.appendValueInput("M1")
        .setCheck("Number")
        .appendField("M1");
      this.appendValueInput("M2")
        .setCheck("Number")
        .appendField("M2");
      this.appendValueInput("M3")
        .setCheck("Number")
        .appendField("M3");
      this.appendValueInput("M4")
        .setCheck("Number")
        .appendField("M4");
      this.setPreviousStatement(true, null);
      this.setNextStatement(true, null);
      this.setColour(230);
      this.setTooltip("MDDモータの目標速度/目標角度/目標位置を一括指示します。");
      this.setHelpUrl("");
    }
  };

  Blockly.Blocks['servo_move'] = {
    init: function () {
      this.appendDummyInput()
        .appendField("Servo 角度制御")
        .appendField(new Blockly.FieldDropdown(getModuleOptionsDropdown('servo')), "NAME");
      this.appendValueInput("S1")
        .setCheck("Number")
        .appendField("S1 (0-180°)");
      this.appendValueInput("S2")
        .setCheck("Number")
        .appendField("S2 (0-180°)");
      this.appendValueInput("S3")
        .setCheck("Number")
        .appendField("S3 (0-180°)");
      this.appendValueInput("S4")
        .setCheck("Number")
        .appendField("S4 (0-180°)");
      this.appendValueInput("S5")
        .setCheck("Number")
        .appendField("S5 (0-180°)");
      this.appendValueInput("S6")
        .setCheck("Number")
        .appendField("S6 (0-180°)");
      this.setPreviousStatement(true, null);
      this.setNextStatement(true, null);
      this.setColour(60);
      this.setTooltip("サーボの目標角度を6ch一括指示します。");
      this.setHelpUrl("");
    }
  };

  Blockly.Blocks['valve_control'] = {
    init: function () {
      this.appendDummyInput()
        .appendField("Solenoid 電磁弁制御")
        .appendField(new Blockly.FieldDropdown(getModuleOptionsDropdown('solenoid')), "NAME")
        .appendField("Ch")
        .appendField(new Blockly.FieldNumber(1, 1, 12, 1), "CHANNEL")
        .appendField("状態")
        .appendField(new Blockly.FieldDropdown([["ON", "True"], ["OFF", "False"]]), "STATE");
      this.setPreviousStatement(true, null);
      this.setNextStatement(true, null);
      this.setColour(0);
      this.setTooltip("特定の電磁弁をON/OFF制御します。");
      this.setHelpUrl("");
    }
  };

  Blockly.Blocks['mdd_sw_val'] = {
    init: function () {
      this.appendDummyInput()
        .appendField("MDD SW:")
        .appendField(new Blockly.FieldDropdown(getModuleOptionsDropdown('mdd')), "NAME")
        .appendField("の リミットSW")
        .appendField(new Blockly.FieldDropdown([["SW1", "0"], ["SW2", "1"], ["SW3", "2"], ["SW4", "3"]]), "SW_IDX")
        .appendField("状態 (ON/OFF)");
      this.setOutput(true, "Boolean");
      this.setColour(80);
      this.setTooltip("対象MDDのリミットスイッチ状態(True=ON / 押されている, False=OFF)を取得します。");
      this.setHelpUrl("");
    }
  };

  Blockly.Blocks['mdd_enc_deg_val'] = {
    init: function () {
      this.appendDummyInput()
        .appendField("MDD エンコーダー:")
        .appendField(new Blockly.FieldDropdown(getModuleOptionsDropdown('mdd')), "NAME")
        .appendField("の モータ")
        .appendField(new Blockly.FieldDropdown([["M1", "0"], ["M2", "1"], ["M3", "2"], ["M4", "3"]]), "MOTOR_IDX")
        .appendField("の現在角度 (度)");
      this.setOutput(true, "Number");
      this.setColour(80);
      this.setTooltip("対象MDDのモータの現在角度(度)を取得します。");
      this.setHelpUrl("");
    }
  };

  Blockly.Blocks['mdd_enc_rps_val'] = {
    init: function () {
      this.appendDummyInput()
        .appendField("MDD エンコーダー:")
        .appendField(new Blockly.FieldDropdown(getModuleOptionsDropdown('mdd')), "NAME")
        .appendField("の モータ")
        .appendField(new Blockly.FieldDropdown([["M1", "0"], ["M2", "1"], ["M3", "2"], ["M4", "3"]]), "MOTOR_IDX")
        .appendField("の現在速度 (rps)");
      this.setOutput(true, "Number");
      this.setColour(80);
      this.setTooltip("対象MDDのモータの現在回転速度(rps)を取得します。");
      this.setHelpUrl("");
    }
  };

  Blockly.Blocks['robomas_move'] = {
    init: function () {
      this.appendValueInput("TARGET")
        .setCheck("Number")
        .appendField("RoboMaster:")
        .appendField(new Blockly.FieldDropdown(getModuleOptionsDropdown('robomas')), "NAME")
        .appendField("モード")
        .appendField(new Blockly.FieldDropdown([
          ["設定値に従う", "default"],
          ["電流出力 (cmd)", "current"],
          ["電圧出力 (cmd)", "voltage"],
          ["速度PID (rpm)", "speed_pid"],
          ["位置PID (deg)", "position_pid"]
        ]), "MODE")
        .appendField("目標値");
      this.setPreviousStatement(true, null);
      this.setNextStatement(true, null);
      this.setColour(160);
      this.setTooltip("RoboMasterモーターに目標値(電流/電圧/速度rpm/位置deg)を送信します。");
      this.setHelpUrl("");
    }
  };

  Blockly.Blocks['robomas_reset_zero'] = {
    init: function () {
      this.appendDummyInput()
        .appendField("RoboMaster:")
        .appendField(new Blockly.FieldDropdown(getModuleOptionsDropdown('robomas')), "NAME")
        .appendField("の角度原点を0°にリセット");
      this.setPreviousStatement(true, null);
      this.setNextStatement(true, null);
      this.setColour(160);
      this.setTooltip("RoboMasterモーターの累積角度を0°にリセットします。");
      this.setHelpUrl("");
    }
  };

  Blockly.Blocks['robomas_feedback_val'] = {
    init: function () {
      this.appendDummyInput()
        .appendField("RoboMaster:")
        .appendField(new Blockly.FieldDropdown(getModuleOptionsDropdown('robomas')), "NAME")
        .appendField("の")
        .appendField(new Blockly.FieldDropdown([
          ["累積角度 (deg)", "angle_deg"],
          ["回転速度 (rpm)", "speed_rpm"],
          ["トルク電流 (A)", "current_a"],
          ["温度 (℃)", "temperature"]
        ]), "FIELD");
      this.setOutput(true, "Number");
      this.setColour(160);
      this.setTooltip("RoboMasterモーターのフィードバック値を取得します。");
      this.setHelpUrl("");
    }
  };

  Blockly.Blocks['event_macro'] = {
    init: function () {
      this.appendDummyInput()
        .appendField("🏁 マクロ実行時 (エントリポイント)");
      this.appendStatementInput("DO")
        .setCheck(null);
      this.setColour('#f59e0b');
      this.setTooltip("「マクロを実行」ボタンを押した時に、この中に接続されたブロックが上から順に実行されます。");
    }
  };

  Blockly.Blocks['delay_wait'] = {
    init: function () {
      this.appendDummyInput()
        .appendField("遅延ウェイト")
        .appendField(new Blockly.FieldNumber(500, 0, 60000, 10), "MS")
        .appendField("ミリ秒 (ms)");
      this.setPreviousStatement(true, null);
      this.setNextStatement(true, null);
      this.setColour(120);
      this.setTooltip("指定されたミリ秒数処理を一時停止します。1000ミリ秒＝1秒です。");
      this.setHelpUrl("");
    }
  };

  Blockly.Blocks['print_log'] = {
    init: function () {
      this.appendDummyInput()
        .appendField("ログ出力");
      this.appendValueInput("TEXT")
        .setCheck(null);
      this.setPreviousStatement(true, null);
      this.setNextStatement(true, null);
      this.setColour(180);
      this.setTooltip("ROS2ログ出力画面に変数の値や文字列を出力します。");
      this.setHelpUrl("");
    }
  };

  // コントローラー用カスタムブロック
  Blockly.Blocks['gamepad_button'] = {
    init: function () {
      this.appendDummyInput()
        .appendField("コントローラー ボタン")
        .appendField(new Blockly.FieldDropdown([
          ["Button A / ×", "0"],
          ["Button B / ○", "1"],
          ["Button X / □", "2"],
          ["Button Y / △", "3"],
          ["L1", "4"],
          ["R1", "5"],
          ["L2 (デジタル)", "6"],
          ["R2 (デジタル)", "7"],
          ["Share / Select", "8"],
          ["Options / Start", "9"],
          ["L-Stick クリック", "10"],
          ["R-Stick クリック", "11"],
          ["D-Pad Up", "12"],
          ["D-Pad Down", "13"],
          ["D-Pad Left", "14"],
          ["D-Pad Right", "15"]
        ]), "BUTTON");
      this.setOutput(true, "Boolean");
      this.setColour(290);
      this.setTooltip("ゲームコントローラーの特定のボタンが押されているか(True/False)を取得します。");
      this.setHelpUrl("");
    }
  };

  Blockly.Blocks['gamepad_axis'] = {
    init: function () {
      this.appendDummyInput()
        .appendField("コントローラー ")
        .appendField(new Blockly.FieldDropdown([
          ["L-Stick 左右 (X)", "0"],
          ["L-Stick 上下 (Y)", "1"],
          ["R-Stick 左右 (X)", "2"],
          ["R-Stick 上下 (Y)", "3"]
        ]), "AXIS")
        .appendField("傾き");
      this.setOutput(true, "Number");
      this.setColour(290);
      this.setTooltip("ゲームコントローラーの指定されたスティックの傾き値(-1.0〜1.0)を取得します。");
      this.setHelpUrl("");
    }
  };

  Blockly.Blocks['gamepad_axis_scaled'] = {
    init: function () {
      this.appendDummyInput()
        .appendField("コントローラー ")
        .appendField(new Blockly.FieldDropdown([
          ["L-Stick 左右 (X)", "0"],
          ["L-Stick 上下 (Y)", "1"],
          ["R-Stick 左右 (X)", "2"],
          ["R-Stick 上下 (Y)", "3"]
        ]), "AXIS")
        .appendField("の傾き × 係数")
        .appendField(new Blockly.FieldNumber(1000, -10000, 10000, 1), "SCALE");
      this.setOutput(true, "Number");
      this.setColour(290);
      this.setTooltip("コントローラーの指定されたスティックの傾き値(-1.0〜1.0)に指定した係数を掛けた値を取得します。");
      this.setHelpUrl("");
    }
  };

  Blockly.Blocks['robot_kinematics'] = {
    init: function () {
      this.appendDummyInput()
        .appendField("🤖 ロボット運動学制御")
        .appendField(new Blockly.FieldDropdown([
          ["3輪オムニ", "3_OMNI"],
          ["4輪オムニ", "4_OMNI"],
          ["4輪メカナム", "4_MECANUM"],
          ["差動2輪", "2_DIFF"]
        ]), "TYPE");
      this.appendDummyInput()
        .appendField("モータドライバ:")
        .appendField(new Blockly.FieldDropdown(getModuleOptionsDropdown('mdd')), "MDD")
        .appendField("  旋回直径:")
        .appendField(new Blockly.FieldNumber(300, 10, 2000, 1), "L")
        .appendField("mm");
      this.appendDummyInput()
        .appendField("モータ割当: LF/左前/左輪:")
        .appendField(new Blockly.FieldDropdown([["M1", "m1"], ["M2", "m2"], ["M3", "m3"], ["M4", "m4"], ["なし", "none"]]), "M_LF")
        .appendField(" 反転:")
        .appendField(new Blockly.FieldCheckbox("FALSE"), "INV_LF");
      this.appendDummyInput()
        .appendField("            RF/右前/右輪:")
        .appendField(new Blockly.FieldDropdown([["M1", "m1"], ["M2", "m2"], ["M3", "m3"], ["M4", "m4"], ["なし", "none"]]), "M_RF")
        .appendField(" 反転:")
        .appendField(new Blockly.FieldCheckbox("FALSE"), "INV_RF");
      this.appendDummyInput()
        .appendField("            LR/左後/左輪:")
        .appendField(new Blockly.FieldDropdown([["M1", "m1"], ["M2", "m2"], ["M3", "m3"], ["M4", "m4"], ["なし", "none"]]), "M_LR")
        .appendField(" 反転:")
        .appendField(new Blockly.FieldCheckbox("FALSE"), "INV_LR");
      this.appendDummyInput()
        .appendField("            RR/右後/右輪:")
        .appendField(new Blockly.FieldDropdown([["M1", "m1"], ["M2", "m2"], ["M3", "m3"], ["M4", "m4"], ["なし", "none"]]), "M_RR")
        .appendField(" 反転:")
        .appendField(new Blockly.FieldCheckbox("FALSE"), "INV_RR");
      this.appendValueInput("VX")
        .setCheck("Number")
        .appendField("入力 Vx (左右速度 mm/s)");
      this.appendValueInput("VY")
        .setCheck("Number")
        .appendField("入力 Vy (前後速度 mm/s)");
      this.appendValueInput("OMEGA")
        .setCheck("Number")
        .appendField("入力 ω (旋回角速度 rad/s)");
      this.setPreviousStatement(true, null);
      this.setNextStatement(true, null);
      this.setColour(260);
      this.setTooltip("Vx, Vy, ω から足回りの逆運動学を計算し、指定したMDDモータの目標値へ指示します。各タイヤ直径はパラメータ設定の値が自動使用されます。");
      this.setHelpUrl("");
    }
  };

  // Blockly.Python ジェネレーターの定義と互換性ポリフィル
  let pyGen = null;
  if (typeof python !== 'undefined' && python.pythonGenerator) {
    pyGen = python.pythonGenerator;
    // 古いコードへの互換マッピングを安全に行う
    if (typeof Blockly !== 'undefined') {
      Blockly.Python = pyGen;
    }
  } else if (typeof Blockly !== 'undefined' && Blockly.Python) {
    pyGen = Blockly.Python;
  }
  if (pyGen) {
    pyGen.INDENT = "    "; // Pythonの標準インデント幅を4スペースに統一
  }
  if (typeof Blockly !== 'undefined' && Blockly.Python) {
    Blockly.Python.INDENT = "    ";
  }

  // ジェネレーター登録ヘルパー（最新・旧バージョン両対応）
  const registerGenerator = function (blockName, generatorFunc) {
    if (!pyGen) return;
    if (pyGen.forBlock) {
      pyGen.forBlock[blockName] = generatorFunc;
    } else {
      pyGen[blockName] = generatorFunc;
    }
  };

  // アトミックオーダー取得ヘルパー
  const getAtomicOrder = function () {
    if (pyGen && pyGen.Order) return pyGen.Order.ATOMIC;
    if (Blockly.Python && typeof Blockly.Python.ORDER_ATOMIC !== 'undefined') return Blockly.Python.ORDER_ATOMIC;
    return 99; // fallback
  };

  registerGenerator('event_macro', function (block, generator) {
    const gen = generator || pyGen;
    const branch = gen.statementToCode(block, 'DO');
    // statementToCode が自動付与する先頭のインデントを1レベル分削除する
    const indent = gen.INDENT || '    ';
    const cleanedBranch = branch.split('\n').map(line => {
      if (line.startsWith(indent)) {
        return line.substring(indent.length);
      }
      return line;
    }).join('\n');
    return cleanedBranch;
  });

  registerGenerator('mdd_move', function (block, generator) {
    const root = block.getRootBlock();
    if (!root || root.type !== 'event_macro') return '';
    const name = block.getFieldValue('NAME');
    if (name === 'none') return '';
    const gen = generator || pyGen;
    const order = getAtomicOrder();
    const m1 = gen.valueToCode(block, 'M1', order) || '0.0';
    const m2 = gen.valueToCode(block, 'M2', order) || '0.0';
    const m3 = gen.valueToCode(block, 'M3', order) || '0.0';
    const m4 = gen.valueToCode(block, 'M4', order) || '0.0';
    return `self.get_module("${name}").set_targets([${m1}, ${m2}, ${m3}, ${m4}])\n`;
  });

  registerGenerator('servo_move', function (block, generator) {
    const root = block.getRootBlock();
    if (!root || root.type !== 'event_macro') return '';
    const name = block.getFieldValue('NAME');
    if (name === 'none') return '';
    const gen = generator || pyGen;
    const order = getAtomicOrder();
    const s1 = gen.valueToCode(block, 'S1', order) || '90';
    const s2 = gen.valueToCode(block, 'S2', order) || '90';
    const s3 = gen.valueToCode(block, 'S3', order) || '90';
    const s4 = gen.valueToCode(block, 'S4', order) || '90';
    const s5 = gen.valueToCode(block, 'S5', order) || '90';
    const s6 = gen.valueToCode(block, 'S6', order) || '90';
    return `self.get_module("${name}").set_angles([${s1}, ${s2}, ${s3}, ${s4}, ${s5}, ${s6}])\n`;
  });

  registerGenerator('valve_control', function (block, generator) {
    const root = block.getRootBlock();
    if (!root || root.type !== 'event_macro') return '';
    const name = block.getFieldValue('NAME');
    if (name === 'none') return '';
    const channel = block.getFieldValue('CHANNEL');
    const state = block.getFieldValue('STATE');
    return `self.get_module("${name}").set_valve(${channel}, ${state})\n`;
  });

  registerGenerator('delay_wait', function (block, generator) {
    const root = block.getRootBlock();
    if (!root || root.type !== 'event_macro') return '';
    const ms = block.getFieldValue('MS');
    return `time.sleep(${ms} / 1000.0)\n`;
  });

  registerGenerator('print_log', function (block, generator) {
    const root = block.getRootBlock();
    if (!root || root.type !== 'event_macro') return '';
    const gen = generator || pyGen;
    const val = gen.valueToCode(block, 'TEXT', getAtomicOrder()) || '"マクロを実行中..."';
    return `self.get_logger().info(f"[BLOCKLY] {${val}}")\n`;
  });

  registerGenerator('gamepad_button', function (block, generator) {
    const buttonIdx = block.getFieldValue('BUTTON');
    const code = `self.gamepad.get_button(${buttonIdx})`;
    return [code, getAtomicOrder()];
  });

  registerGenerator('gamepad_axis', function (block, generator) {
    const axisIdx = block.getFieldValue('AXIS');
    const code = `self.gamepad.get_axis(${axisIdx})`;
    return [code, getAtomicOrder()];
  });

  registerGenerator('mdd_sw_val', function (block, generator) {
    const name = block.getFieldValue('NAME');
    if (name === 'none') return ['False', getAtomicOrder()];
    const swIdx = block.getFieldValue('SW_IDX');
    const code = `self.get_module("${name}").get_feedback().limit_switches[${swIdx}]`;
    return [code, getAtomicOrder()];
  });

  registerGenerator('mdd_enc_deg_val', function (block, generator) {
    const name = block.getFieldValue('NAME');
    if (name === 'none') return ['0.0', getAtomicOrder()];
    const motorIdx = block.getFieldValue('MOTOR_IDX');
    const code = `self.get_module("${name}").get_feedback().angles[${motorIdx}]`;
    return [code, getAtomicOrder()];
  });

  registerGenerator('mdd_enc_rps_val', function (block, generator) {
    const name = block.getFieldValue('NAME');
    if (name === 'none') return ['0.0', getAtomicOrder()];
    const motorIdx = block.getFieldValue('MOTOR_IDX');
    const code = `self.get_module("${name}").get_feedback().speeds[${motorIdx}]`;
    return [code, getAtomicOrder()];
  });

  registerGenerator('robomas_move', function (block, generator) {
    const root = block.getRootBlock();
    if (!root || root.type !== 'event_macro') return '';
    const name = block.getFieldValue('NAME');
    if (name === 'none') return '';
    const mode = block.getFieldValue('MODE');
    const gen = generator || pyGen;
    const target = gen.valueToCode(block, 'TARGET', getAtomicOrder()) || '0.0';
    if (mode && mode !== 'default') {
      return `self.get_module("${name}").set_target(${target}, mode="${mode}")\n`;
    }
    return `self.get_module("${name}").set_target(${target})\n`;
  });

  registerGenerator('robomas_reset_zero', function (block) {
    const root = block.getRootBlock();
    if (!root || root.type !== 'event_macro') return '';
    const name = block.getFieldValue('NAME');
    if (name === 'none') return '';
    return `self.get_module("${name}").reset_zero()\n`;
  });

  registerGenerator('robomas_feedback_val', function (block) {
    const name = block.getFieldValue('NAME');
    if (name === 'none') return ['0.0', getAtomicOrder()];
    const field = block.getFieldValue('FIELD') || 'angle_deg';
    return [`self.get_module("${name}").get_feedback().${field}`, getAtomicOrder()];
  });

  registerGenerator('gamepad_axis_scaled', function (block, generator) {
    const axisIdx = block.getFieldValue('AXIS');
    const scale = block.getFieldValue('SCALE') || '1.0';
    const code = `(self.gamepad.get_axis(${axisIdx}) * ${scale})`;
    return [code, getAtomicOrder()];
  });

  registerGenerator('robot_kinematics', function (block, generator) {
    const root = block.getRootBlock();
    if (!root || root.type !== 'event_macro') return '';
    const gen = generator || pyGen;
    const order = getAtomicOrder();

    const type = block.getFieldValue('TYPE');
    const mddName = block.getFieldValue('MDD');
    const tread = block.getFieldValue('L') || '300.0';

    const mLf = block.getFieldValue('M_LF');
    const mRf = block.getFieldValue('M_RF');
    const mLr = block.getFieldValue('M_LR');
    const mRr = block.getFieldValue('M_RR');

    const invLf = block.getFieldValue('INV_LF') === 'TRUE' ? '-1.0' : '1.0';
    const invRf = block.getFieldValue('INV_RF') === 'TRUE' ? '-1.0' : '1.0';
    const invLr = block.getFieldValue('INV_LR') === 'TRUE' ? '-1.0' : '1.0';
    const invRr = block.getFieldValue('INV_RR') === 'TRUE' ? '-1.0' : '1.0';

    const vx = gen.valueToCode(block, 'VX', order) || '0.0';
    const vy = gen.valueToCode(block, 'VY', order) || '0.0';
    const omega = gen.valueToCode(block, 'OMEGA', order) || '0.0';

    return `
# 運動学計算実行
def _calc_kinematics():
    import math
    vx_val = float(${vx}) / 1000.0
    vy_val = float(${vy}) / 1000.0
    omega_val = float(${omega})
    
    r_t = ${tread} / 2000.0
    
    def get_dia(m_name):
        if m_name == 'none': return 100.0
        for m in self.config.get('modules', []):
            if m.get('name') == "${mddName}":
                return m.get('parameters', {}).get(m_name, {}).get('diameter', 100.0)
        return 100.0
        
    dia_lf = get_dia("${mLf}")
    dia_rf = get_dia("${mRf}")
    dia_lr = get_dia("${mLr}")
    dia_rr = get_dia("${mRr}")
    
    k_lf = 1000.0 / (math.pi * dia_lf) if dia_lf > 0 else 1.0
    k_rf = 1000.0 / (math.pi * dia_rf) if dia_rf > 0 else 1.0
    k_lr = 1000.0 / (math.pi * dia_lr) if dia_lr > 0 else 1.0
    k_rr = 1000.0 / (math.pi * dia_rr) if dia_rr > 0 else 1.0
    
    target_speeds = [0.0, 0.0, 0.0, 0.0]
    
    if "${type}" == "3_OMNI":
        v1 = (vy_val + r_t * omega_val) * ${invLf}
        v2 = (-0.866025 * vx_val - 0.5 * vy_val + r_t * omega_val) * ${invRf}
        v3 = (0.866025 * vx_val - 0.5 * vy_val + r_t * omega_val) * ${invLr}
        
        for slot, val in [("${mLf}", v1 * k_lf), ("${mRf}", v2 * k_rf), ("${mLr}", v3 * k_lr)]:
            if slot != 'none':
                idx = int(slot[1]) - 1
                target_speeds[idx] = val
                
    elif "${type}" == "4_OMNI":
        v_lf = (-0.707107 * vx_val + 0.707107 * vy_val - r_t * omega_val) * ${invLf}
        v_rf = (0.707107 * vx_val + 0.707107 * vy_val + r_t * omega_val) * ${invRf}
        v_lr = (-0.707107 * vx_val - 0.707107 * vy_val + r_t * omega_val) * ${invLr}
        v_rr = (0.707107 * vx_val - 0.707107 * vy_val - r_t * omega_val) * ${invRr}
        
        for slot, val in [("${mLf}", v_lf * k_lf), ("${mRf}", v_rf * k_rf), ("${mLr}", v_lr * k_lr), ("${mRr}", v_rr * k_rr)]:
            if slot != 'none':
                idx = int(slot[1]) - 1
                target_speeds[idx] = val
                
    elif "${type}" == "4_MECANUM":
        v_lf = (vy_val - vx_val - r_t * omega_val) * ${invLf}
        v_rf = (vy_val + vx_val + r_t * omega_val) * ${invRf}
        v_lr = (vy_val + vx_val - r_t * omega_val) * ${invLr}
        v_rr = (vy_val - vx_val + r_t * omega_val) * ${invRr}
        
        for slot, val in [("${mLf}", v_lf * k_lf), ("${mRf}", v_rf * k_rf), ("${mLr}", v_lr * k_lr), ("${mRr}", v_rr * k_rr)]:
            if slot != 'none':
                idx = int(slot[1]) - 1
                target_speeds[idx] = val
                
    elif "${type}" == "2_DIFF":
        v_l = vy_val - r_t * omega_val
        v_r = vy_val + r_t * omega_val
        
        for slot, val in [("${mLf}", v_l * k_lf * ${invLf}), ("${mLr}", v_l * k_lr * ${invLr})]:
            if slot != 'none':
                idx = int(slot[1]) - 1
                target_speeds[idx] = val
        for slot, val in [("${mRf}", v_r * k_rf * ${invRf}), ("${mRr}", v_r * k_rr * ${invRr})]:
            if slot != 'none':
                idx = int(slot[1]) - 1
                target_speeds[idx] = val
                
    self.get_module("${mddName}").set_targets(target_speeds)

_calc_kinematics()
`;
  });

  // フルPythonコードに組み立てるヘルパー
  function generatePythonCode(blocklyCode) {
    // すべての行に対して一律で 12スペース（tryブロックのインデント）を動的に付与する
    const indentedCode = blocklyCode
      .split('\n')
      .map(line => {
        if (line.trim() === '') return '';
        return '            ' + line;
      })
      .join('\n');

    return `#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
Altair Module System - Blockly 自動生成プログラム
"""

import sys
import rclpy
import os
import time

_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.extend([_root, os.path.join(_root, "altair_core")])
from altair_core.base_behavior import AltairBehavior

class BlocklyBehavior(AltairBehavior):
    def on_init(self):
        self.get_logger().info("BlocklyマクロBehaviorが初期化されました。")
        self.executed = False

    def loop(self):
        if self.executed:
            return
        self.executed = True
        
        try:
            print("--- Blocklyマクロの実行を開始します ---")
${indentedCode}
            print("--- Blocklyマクロの実行が完了しました ---")
        except Exception as e:
            self.get_logger().error(f"マクロ実行中にエラーが発生しました: {str(e)}")
        finally:
            sys.exit(0)

def main(args=None):
    rclpy.init(args=args)
    behavior = BlocklyBehavior("blockly_behavior_node")
    behavior.run(rate_hz=500.0)

if __name__ == '__main__':
    main()
`;
  }

  // ツールボックスの定義 XML
  const toolboxXml = `
    <xml id="toolbox" style="display: none">
      <category name="イベント" colour="#f59e0b">
        <block type="event_macro"></block>
      </category>
      <category name="基本動作" colour="120">
        <block type="delay_wait">
          <value name="MS"><block type="math_number"><field name="NUM">500</field></block></value>
        </block>
        <block type="print_log">
          <value name="TEXT"><block type="text"><field name="TEXT">マクロを実行中...</field></block></value>
        </block>
      </category>
      <category name="条件分岐 (Logic)" colour="210">
        <block type="controls_if"></block>
        <block type="logic_compare"></block>
        <block type="logic_operation"></block>
        <block type="logic_negate"></block>
        <block type="logic_boolean"></block>
      </category>
      <category name="繰り返し (Loops)" colour="120">
        <block type="controls_repeat_ext">
          <value name="TIMES">
            <shadow type="math_number">
              <field name="NUM">10</field>
            </shadow>
          </value>
        </block>
        <block type="controls_whileUntil"></block>
      </category>
      <category name="計算・数値 (Math)" colour="230">
        <block type="math_number"></block>
        <block type="math_arithmetic"></block>
      </category>
      <category name="テキスト" colour="160">
        <block type="text"></block>
      </category>
      <category name="変数" custom="VARIABLE" colour="330"></category>
      <category name="コントローラー" colour="290">
        <block type="gamepad_button"></block>
        <block type="gamepad_axis"></block>
        <block type="gamepad_axis_scaled">
          <field name="SCALE">1000</field>
        </block>
      </category>
      <category name="MDDモータ" colour="230">
        <block type="mdd_move">
          <value name="M1"><block type="math_number"><field name="NUM">0</field></block></value>
          <value name="M2"><block type="math_number"><field name="NUM">0</field></block></value>
          <value name="M3"><block type="math_number"><field name="NUM">0</field></block></value>
          <value name="M4"><block type="math_number"><field name="NUM">0</field></block></value>
        </block>
        <block type="robot_kinematics">
          <field name="TYPE">4_MECANUM</field>
          <field name="L">300</field>
          <field name="M_LF">m1</field>
          <field name="M_RF">m2</field>
          <field name="M_LR">m3</field>
          <field name="M_RR">m4</field>
          <value name="VX">
            <block type="gamepad_axis_scaled">
              <field name="AXIS">0</field>
              <field name="SCALE">1000</field>
            </block>
          </value>
          <value name="VY">
            <block type="gamepad_axis_scaled">
              <field name="AXIS">1</field>
              <field name="SCALE">1000</field>
            </block>
          </value>
          <value name="OMEGA">
            <block type="gamepad_axis_scaled">
              <field name="AXIS">2</field>
              <field name="SCALE">2.0</field>
            </block>
          </value>
        </block>
      </category>
      <category name="MDDセンサー値" colour="80">
        <block type="mdd_sw_val"></block>
        <block type="mdd_enc_deg_val"></block>
        <block type="mdd_enc_rps_val"></block>
      </category>
      <category name="サーボ" colour="60">
        <block type="servo_move">
          <value name="S1"><block type="math_number"><field name="NUM">90</field></block></value>
          <value name="S2"><block type="math_number"><field name="NUM">90</field></block></value>
          <value name="S3"><block type="math_number"><field name="NUM">90</field></block></value>
          <value name="S4"><block type="math_number"><field name="NUM">90</field></block></value>
          <value name="S5"><block type="math_number"><field name="NUM">90</field></block></value>
          <value name="S6"><block type="math_number"><field name="NUM">90</field></block></value>
        </block>
      </category>
      <category name="電磁弁" colour="0">
        <block type="valve_control"></block>
      </category>
      <category name="RoboMaster" colour="160">
        <block type="robomas_move">
          <value name="TARGET"><block type="math_number"><field name="NUM">0</field></block></value>
        </block>
        <block type="robomas_reset_zero"></block>
        <block type="robomas_feedback_val"></block>
      </category>
    </xml>
  `;

  const blocklyDiv = document.getElementById('blocklyDiv');
  if (blocklyDiv && typeof Blockly !== 'undefined') {
    const toolboxDom = Blockly.utils.xml.textToDom(toolboxXml);
    blocklyWorkspace = Blockly.inject('blocklyDiv', {
      toolbox: toolboxDom,
      scrollbars: true,
      trashcan: true,
      grid: { spacing: 20, length: 3, colour: '#ccc', snap: true },
      zoom: { controls: true, wheel: true }
    });
  }

  // 既存コード互換のため参照名を維持
  const workspace = blocklyWorkspace;

  // サーバーから保存済みBlocklyワークスペースをロードして復元
  if (workspace && typeof Blockly !== 'undefined') {
    fetch("/api/behavior/get_blockly_workspace")
      .then(res => res.json())
      .then(data => {
        if (data.success && data.xml) {
          try {
            workspace.clear();
            const dom = Blockly.utils.xml.textToDom(data.xml);
            Blockly.Xml.domToWorkspace(dom, workspace);
            console.log("Blocklyワークスペースを正常に復元しました。");
          } catch (restoreErr) {
            console.error("Blocklyワークスペースの復元に失敗しました。デフォルトをロードします:", restoreErr);
            loadDefaultEntryBlock(workspace);
          }
        } else {
          loadDefaultEntryBlock(workspace);
        }
      })
      .catch(err => {
        console.error("Blocklyワークスペースのロードエラー:", err);
        loadDefaultEntryBlock(workspace);
      });
  }

  function loadDefaultEntryBlock(ws) {
    try {
      ws.clear();
      const defaultXml = '<xml xmlns="https://developers.google.com/blockly/xml"><block type="event_macro" id="initial_entry" x="30" y="30"></block></xml>';
      const dom = Blockly.utils.xml.textToDom(defaultXml);
      Blockly.Xml.domToWorkspace(dom, ws);
    } catch (e) {
      console.error("Defaultブロック配置失敗:", e);
    }
  }

  // リアルタイムにコードを生成＆プレビュー
  if (workspace) {
    workspace.addChangeListener(() => {
      try {
        const rawCode = Blockly.Python.workspaceToCode(workspace);
        const fullPython = generatePythonCode(rawCode);
        const codeArea = document.getElementById("blockly-code-area");
        if (codeArea) {
          codeArea.textContent = fullPython;
        }
      } catch (err) {
        const codeArea = document.getElementById("blockly-code-area");
        if (codeArea) {
          codeArea.textContent = "# コード自動生成エラー: " + err.message;
        }
      }
    });
  }

  // 単体「ブロックを保存」ボタンのイベント
  const btnSaveBlocklyXml = document.getElementById("btn-save-blockly-xml");
  if (btnSaveBlocklyXml) {
    btnSaveBlocklyXml.addEventListener("click", async () => {
      if (!workspace) {
        appendTerminalLog(el.behaviorTerminal, "[ERROR] Blocklyワークスペースが初期化されていません。", "error-msg");
        return;
      }

      const rawCode = Blockly.Python.workspaceToCode(workspace);
      const fullPython = generatePythonCode(rawCode);

      let xmlText = "";
      try {
        const dom = Blockly.Xml.workspaceToDom(workspace);
        xmlText = Blockly.Xml.domToText(dom);
      } catch (xmlErr) {
        console.error("XML変換エラー:", xmlErr);
        appendTerminalLog(el.behaviorTerminal, `[ERROR] ブロックXML変換に失敗しました: ${xmlErr.message}`, "error-msg");
        return;
      }

      appendTerminalLog(el.behaviorTerminal, "ブロックとコードをサーバーに保存中...");

      try {
        const saveRes = await fetch("/api/behavior/save_blockly", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: fullPython, xml: xmlText })
        });
        const saveData = await saveRes.json();

        if (saveData.success) {
          appendTerminalLog(el.behaviorTerminal, "[SUCCESS] ブロックの配置状態と自動生成コードを保存しました！", "system-msg");
        } else {
          appendTerminalLog(el.behaviorTerminal, `[ERROR] 保存失敗: ${saveData.message}`, "error-msg");
        }
      } catch (err) {
        appendTerminalLog(el.behaviorTerminal, `[ERROR] 保存API通信エラー: ${err.message}`, "error-msg");
      }
    });
  }

  // マクロ実行ボタンのイベント
  const btnRunBlockly = document.getElementById("btn-run-blockly");
  if (btnRunBlockly) {
    btnRunBlockly.addEventListener("click", async () => {
      if (!workspace) {
        appendTerminalLog(el.behaviorTerminal, "[ERROR] Blocklyワークスペースの初期化に失敗しています。ページを再読み込みしてください。", "error-msg");
        return;
      }
      const rawCode = Blockly.Python.workspaceToCode(workspace);
      const fullPython = generatePythonCode(rawCode);

      let xmlText = "";
      try {
        const dom = Blockly.Xml.workspaceToDom(workspace);
        xmlText = Blockly.Xml.domToText(dom);
      } catch (xmlErr) {
        console.error("XML変換エラー:", xmlErr);
      }

      appendTerminalLog(el.behaviorTerminal, "Blocklyコードを blockly_behavior.py として保存中...");

      try {
        const saveRes = await fetch("/api/behavior/save_blockly", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: fullPython, xml: xmlText })
        });
        const saveData = await saveRes.json();

        if (!saveData.success) {
          appendTerminalLog(el.behaviorTerminal, `[ERROR] コード保存失敗: ${saveData.message}`, "error-msg");
          return;
        }

        appendTerminalLog(el.behaviorTerminal, "Blocklyビジュアルマクロを起動中...");

        const runRes = await fetch("/api/behavior/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ behavior_name: "blockly_behavior.py" })
        });
        const runData = await runRes.json();

        if (runData.success) {
          appendTerminalLog(el.behaviorTerminal, "[SYSTEM] Blocklyマクロが正常に起動しました。", "system-msg");
          // 実行画面（Behaviorビュー）へ自動的に切り替える
          const targetItem = document.querySelector('.menu-item[data-target="view-behavior"]');
          if (targetItem) targetItem.click();
        } else {
          appendTerminalLog(el.behaviorTerminal, `[ERROR] 起動失敗: ${runData.message}`, "error-msg");
        }
      } catch (err) {
        appendTerminalLog(el.behaviorTerminal, `[ERROR] 通信エラー: ${err}`, "error-msg");
      }
    });
  }

  // マクロ停止ボタンのイベント
  const btnStopBlockly = document.getElementById("btn-stop-blockly");
  if (btnStopBlockly) {
    btnStopBlockly.addEventListener("click", async () => {
      appendTerminalLog(el.behaviorTerminal, "マクロ停止要求を送信...");
      try {
        const res = await fetch("/api/behavior/stop", { method: "POST" });
        const data = await res.json();
        if (data.success) {
          appendTerminalLog(el.behaviorTerminal, "[SYSTEM] マクロを停止しました。", "system-msg");
        } else {
          appendTerminalLog(el.behaviorTerminal, `[ERROR] 停止失敗: ${data.message}`, "error-msg");
        }
      } catch (err) {
        appendTerminalLog(el.behaviorTerminal, `[ERROR] 通信エラー: ${err}`, "error-msg");
      }
    });
  }

  // 保存ボタンのイベント
  const btnExportBlocklyCode = document.getElementById("btn-export-blockly-code");
  if (btnExportBlocklyCode) {
    btnExportBlocklyCode.addEventListener("click", () => {
      if (!workspace) {
        appendTerminalLog(el.behaviorTerminal, "[ERROR] Blocklyワークスペースが未初期化のため保存できません。", "error-msg");
        return;
      }
      const rawCode = Blockly.Python.workspaceToCode(workspace);
      const fullPython = generatePythonCode(rawCode);
      const blob = new Blob([fullPython], { type: "text/x-python" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "blockly_behavior.py";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });
  }

  // コードプレビュードロワーの開閉制御
  const btnToggleCode = document.getElementById("btn-toggle-code");
  const btnCloseDrawer = document.getElementById("btn-close-drawer");
  const codeDrawer = document.getElementById("blockly-code-drawer");

  if (btnToggleCode && codeDrawer) {
    btnToggleCode.addEventListener("click", () => {
      codeDrawer.classList.toggle("open");
    });
  }

  if (btnCloseDrawer && codeDrawer) {
    btnCloseDrawer.addEventListener("click", () => {
      codeDrawer.classList.remove("open");
    });
  }

  // =========================================================================
  // 20. シミュレータ (Simulator) 制御 ＆ 2Dミニマップ描画
  // =========================================================================
  const simTrail = [];
  const MAX_TRAIL_POINTS = 500;
  let lastSimPose = { x: 0, y: 0, theta_deg: 0, vx: 0, vy: 0, omega_deg: 0 };
  let activeLimitSwitches = {};

  function handleSimStateUpdate(data) {
    if (!data || !data.pose) return;

    lastSimPose = data.pose;

    // 数値バッジの更新
    const dispX = document.getElementById("sim-disp-x");
    const dispY = document.getElementById("sim-disp-y");
    const dispTheta = document.getElementById("sim-disp-theta");
    const dispV = document.getElementById("sim-disp-v");

    if (dispX) dispX.textContent = data.pose.x.toFixed(2);
    if (dispY) dispY.textContent = data.pose.y.toFixed(2);
    if (dispTheta) dispTheta.textContent = data.pose.theta_deg.toFixed(1);
    if (dispV) {
      const speed = Math.hypot(data.pose.vx, data.pose.vy);
      dispV.textContent = speed.toFixed(2);
    }

    // 軌跡ポイント追加 (0.02m以上変化があった場合)
    if (simTrail.length === 0) {
      simTrail.push({ x: data.pose.x, y: data.pose.y });
    } else {
      const last = simTrail[simTrail.length - 1];
      if (Math.hypot(data.pose.x - last.x, data.pose.y - last.y) > 0.02) {
        simTrail.push({ x: data.pose.x, y: data.pose.y });
        if (simTrail.length > MAX_TRAIL_POINTS) simTrail.shift();
      }
    }

    // 2D Canvas 描画
    drawSimCanvas(data.pose);

    // リミットスイッチUI更新
    if (data.mdds) {
      updateSimLimitsUI(data.mdds);
    }

    // 電磁弁UI更新
    if (data.solenoids) {
      updateSimSolenoidsUI(data.solenoids);
    }

    // サーボUI更新
    if (data.servos) {
      updateSimServosUI(data.servos);
    }
  }

  function drawSimCanvas(pose) {
    const canvas = document.getElementById("sim-canvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);

    // スケール: 6m × 6m の領域を width × height にマッピング (1m = w / 6 px)
    const fieldSize = 6.0;
    const scale = w / fieldSize;
    const originX = w / 2;
    const originY = h / 2;

    // 1. グリッド背景の描画
    ctx.strokeStyle = "rgba(255, 255, 255, 0.06)";
    ctx.lineWidth = 1;

    // 0.5m ごとの補助線
    for (let m = -3.0; m <= 3.0; m += 0.5) {
      const px = originX + m * scale;
      const py = originY - m * scale;
      // 垂直線
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, h);
      ctx.stroke();
      // 水平線
      ctx.beginPath();
      ctx.moveTo(0, py);
      ctx.lineTo(w, py);
      ctx.stroke();
    }

    // 中心軸 (X軸: 赤, Y軸: 緑)
    ctx.strokeStyle = "rgba(234, 67, 53, 0.4)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(originX, 0);
    ctx.lineTo(originX, h);
    ctx.stroke();

    ctx.strokeStyle = "rgba(52, 168, 83, 0.4)";
    ctx.beginPath();
    ctx.moveTo(0, originY);
    ctx.lineTo(w, originY);
    ctx.stroke();

    // 2. 走行軌跡 (Trail) の描画
    if (simTrail.length > 1) {
      ctx.strokeStyle = "rgba(66, 133, 244, 0.7)";
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      for (let i = 0; i < simTrail.length; i++) {
        // REP-103: ワールド座標 (X: 前, Y: 左) -> Canvas (px = originX - y * scale, py = originY - x * scale)
        const px = originX - simTrail[i].y * scale;
        const py = originY - simTrail[i].x * scale;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }

    // 3. ロボット本体の描画
    const robotPx = originX - pose.y * scale;
    const robotPy = originY - pose.x * scale;
    const robotHeadingRad = -(pose.theta_deg * Math.PI) / 180.0;

    ctx.save();
    ctx.translate(robotPx, robotPy);
    ctx.rotate(robotHeadingRad);

    const robotBodyW = 0.35 * scale; // 35cm幅
    const robotBodyL = 0.40 * scale; // 40cm長

    // シャシー本体
    ctx.fillStyle = "rgba(30, 144, 255, 0.85)";
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    if (ctx.roundRect) {
      ctx.roundRect(-robotBodyW / 2, -robotBodyL / 2, robotBodyW, robotBodyL, 6);
    } else {
      ctx.rect(-robotBodyW / 2, -robotBodyL / 2, robotBodyW, robotBodyL);
    }
    ctx.fill();
    ctx.stroke();

    // 車輪 (黒い車輪 4個)
    const wheelW = 0.06 * scale;
    const wheelL = 0.12 * scale;
    ctx.fillStyle = "#111318";
    ctx.strokeStyle = "#5f6368";
    ctx.lineWidth = 1;

    const wheels = [
      { x: -robotBodyW / 2, y: -robotBodyL / 2 + wheelL / 2 },
      { x: robotBodyW / 2 - wheelW, y: -robotBodyL / 2 + wheelL / 2 },
      { x: -robotBodyW / 2, y: robotBodyL / 2 - wheelL * 1.5 },
      { x: robotBodyW / 2 - wheelW, y: robotBodyL / 2 - wheelL * 1.5 },
    ];
    wheels.forEach((wh) => {
      ctx.fillRect(wh.x, wh.y, wheelW, wheelL);
      ctx.strokeRect(wh.x, wh.y, wheelW, wheelL);
    });

    // 進行方向の矢印 (Front: 上向き -Y方向)
    ctx.fillStyle = "#ea4335";
    ctx.beginPath();
    ctx.moveTo(0, -robotBodyL / 2 - 8);
    ctx.lineTo(8, -robotBodyL / 2 + 6);
    ctx.lineTo(-8, -robotBodyL / 2 + 6);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  }

  function updateSimLimitsUI(mdds) {
    const container = document.getElementById("sim-limits-container");
    if (!container) return;

    let html = "";
    mdds.forEach((mdd) => {
      activeLimitSwitches[mdd.name] = mdd.limits;
      html += `
        <div class="sim-mdd-limit-block">
          <div class="sim-mdd-limit-title">
            <span><strong>${mdd.name}</strong> (${mdd.base_id})</span>
            <span class="badge ${mdd.status === 1 ? 'badge-success' : 'badge-warning'}">
              ${mdd.status === 1 ? 'Running' : 'Setup待ち'}
            </span>
          </div>
          <div class="sim-sw-btn-group">
            ${[0, 1, 2, 3].map(idx => `
              <button class="sim-sw-btn ${mdd.limits[idx] ? 'active' : ''}" 
                      onclick="window.toggleSimLimitSwitch('${mdd.name}', ${idx}, ${!mdd.limits[idx]})">
                <span class="indicator-dot"></span>
                <span>SW${idx + 1}: ${mdd.limits[idx] ? 'ON' : 'OFF'}</span>
              </button>
            `).join('')}
          </div>
        </div>
      `;
    });
    container.innerHTML = html;
  }

  window.toggleSimLimitSwitch = async (mddName, switchIndex, nextState) => {
    try {
      await fetch("/api/sim/limit_switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mdd: mddName, index: switchIndex, state: nextState }),
      });
    } catch (err) {
      console.error("リミットSWトグル失敗:", err);
    }
  };

  function updateSimSolenoidsUI(solenoids) {
    const container = document.getElementById("sim-solenoids-container");
    if (!container) return;

    let html = "";
    solenoids.forEach((sol) => {
      html += `
        <div style="margin-bottom: 12px;">
          <div style="font-size: 13px; font-weight: 600; margin-bottom: 6px;">
            ${sol.name} (${sol.base_id})
          </div>
          <div class="sim-solenoids-grid">
            ${sol.valves.map((v, i) => `
              <div class="sim-valve-item ${v ? 'active' : ''}">
                <div class="valve-dot"></div>
                <span>CH${i + 1}</span>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    });
    container.innerHTML = html || '<div class="placeholder-text">電磁弁モジュールなし</div>';
  }

  function updateSimServosUI(servos) {
    const container = document.getElementById("sim-servos-container");
    if (!container) return;

    let html = "";
    servos.forEach((srv) => {
      html += `
        <div style="margin-bottom: 12px;">
          <div style="font-size: 13px; font-weight: 600; margin-bottom: 6px;">
            ${srv.name} (${srv.base_id})
          </div>
          <div class="sim-servos-grid">
            ${srv.angles.map((ang, i) => `
              <div class="sim-servo-row">
                <span class="sim-servo-label">CH${i + 1}:</span>
                <div class="sim-servo-bar-bg">
                  <div class="sim-servo-bar-fill" style="width: ${(ang / 180.0) * 100}%;"></div>
                </div>
                <span class="sim-servo-val">${ang}°</span>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    });
    container.innerHTML = html || '<div class="placeholder-text">サーボモジュールなし</div>';
  }

  // 位置リセット & 軌跡クリアボタンのリスナー
  const btnSimReset = document.getElementById("btn-sim-reset-pose");
  if (btnSimReset) {
    btnSimReset.addEventListener("click", async () => {
      try {
        await fetch("/api/sim/reset_pose", { method: "POST" });
        simTrail.length = 0;
        showNotification("仮想ロボット位置を (0, 0, 0) にリセットしました。", "success");
      } catch (err) {
        showNotification("位置リセットに失敗しました", "error");
      }
    });
  }

  const btnSimClearTrail = document.getElementById("btn-sim-clear-trail");
  if (btnSimClearTrail) {
    btnSimClearTrail.addEventListener("click", () => {
      simTrail.length = 0;
      drawSimCanvas(lastSimPose);
      showNotification("走行軌跡をクリアしました。", "info");
    });
  }
});
