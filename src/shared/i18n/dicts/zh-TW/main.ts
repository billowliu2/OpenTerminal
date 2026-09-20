/** 命名空間：main（主程序文案：系統匣、關閉詢問、更新器）。歸屬：主程序維護者。 */
const main: Record<string, string> = {
  'main.tray.showWindow': '顯示主視窗',
  'main.tray.closeAction': '關閉按鈕行為',
  'main.tray.askEveryTime': '每次詢問',
  'main.tray.minimizeToTray': '最小化到系統匣',
  'main.tray.exitDirectly': '直接結束',
  'main.tray.exit': '結束',
  'main.tray.balloonTitle': '已最小化到系統匣',
  'main.tray.balloonContent': '終端機連線仍在背景執行，點擊系統匣圖示即可還原視窗。',
  'main.tray.closeTitle': '關閉 OpenTerminal',
  'main.tray.closeMessage': '要最小化到系統匣，還是直接結束？',
  'main.tray.closeDetail': '最小化到系統匣時，終端機連線會繼續執行。',
  'main.tray.rememberChoice': '記住我的選擇，不再詢問',

  'main.updater.feedFailed': '國內來源: {gitea}；GitHub: {github}',

  'main.ssh.connectTimeout': '連線逾時 ({host}:{port})',
  'main.ssh.saveFingerprintFailed': '儲存主機指紋失敗: {detail}',
  'main.ssh.hostKeyRejected': '使用者拒絕了主機指紋',
  'main.ssh.connectFailed': '連線失敗 {host}:{port}: {detail}',
  'main.ssh.shellOpenFailed': '無法開啟 SSH shell ({host}:{port}): {detail}',
  'main.ssh.initFailed': 'SSH 連線初始化失敗 ({host}:{port}): {detail}',
  'main.ssh.readKeyFailed': '無法讀取私密金鑰檔案 {path}: {detail}',

  'main.sftp.sessionGone': 'SSH 連線不存在或已中斷',
  'main.sftp.deleteFailed': '刪除失敗: {detail}',
  'main.sftp.invalidMode': '權限值無效: {mode}',
  'main.sftp.invalidUidGid': 'uid/gid 無效',
  'main.sftp.commandTimeout': '命令執行逾時',
  'main.sftp.commandExitCode': '指令結束碼 {code}',
  'main.sftp.cancelled': '已取消',

  'main.zmodem.transferFailed': '傳輸失敗',
  'main.zmodem.transferTimeout': '傳輸逾時',
  'main.zmodem.sendFailed': '傳送失敗',
  'main.zmodem.uploadFailed': '上傳失敗',
  'main.zmodem.receiveFailed': '接收失敗',
  'main.zmodem.abnormal': 'ZMODEM 傳輸異常',
  'main.zmodem.cancelled': '已取消',
  'main.zmodem.offerTimedOut': '未選擇檔案，已取消',
  'main.zmodem.sessionInvalid': '連線已失效',
  'main.zmodem.sessionCreateFailed': '無法建立 ZMODEM 連線',
  'main.zmodem.noSaveDir': '未指定儲存目錄',
  'main.zmodem.noFiles': '未選擇檔案',

  'main.ipc.connectionMissing': '連線書籤不存在 ({id})',

  'main.sysinfo.sessionGone': 'SSH 工作階段不存在或已中斷',
  'main.sysinfo.execFailed': 'SSH exec 失敗',
  'main.sysinfo.pollTimeout': '監控命令回應逾時',
  'main.sysinfo.parseFailed': '解析失敗: {message}',
  'main.pty.serviceNotReady': 'SSH 工作階段服務尚未初始化',
  'main.pty.missingConnectionId': 'SSH 工作階段缺少 connectionId',
  'main.log.tuiOmitted': '全螢幕介面(TUI)輸出已省略'
}

export default main
