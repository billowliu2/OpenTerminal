/** 名前空間: main（メインプロセスの文言: トレイ、終了確認、アップデータ）。担当: メインプロセス。 */
const main: Record<string, string> = {
  'main.tray.showWindow': 'メインウィンドウを表示',
  'main.tray.closeAction': '閉じるボタンの動作',
  'main.tray.askEveryTime': '毎回確認する',
  'main.tray.minimizeToTray': 'トレイに最小化',
  'main.tray.exitDirectly': '直接終了',
  'main.tray.exit': '終了',
  'main.tray.balloonTitle': 'トレイに最小化しました',
  'main.tray.balloonContent': 'ターミナルセッションはバックグラウンドで実行中です。トレイアイコンをクリックするとウィンドウを復元できます。',
  'main.tray.closeTitle': 'OpenTerminal を終了',
  'main.tray.closeMessage': 'トレイに最小化しますか、それとも終了しますか？',
  'main.tray.closeDetail': 'トレイに最小化すると、ターミナルセッションは実行を続けます。',
  'main.tray.rememberChoice': '選択を記憶して今後確認しない',

  'main.updater.feedFailed': '国内フィード: {gitea}；GitHub: {github}',

  'main.ssh.connectTimeout': '接続がタイムアウトしました ({host}:{port})',
  'main.ssh.saveFingerprintFailed': 'ホスト鍵のフィンガープリントを保存できませんでした: {detail}',
  'main.ssh.hostKeyRejected': 'ユーザーがホスト鍵を拒否しました',
  'main.ssh.connectFailed': '接続に失敗しました {host}:{port}: {detail}',
  'main.ssh.shellOpenFailed': 'SSH シェルを開けません ({host}:{port}): {detail}',
  'main.ssh.initFailed': 'SSH 接続の初期化に失敗しました ({host}:{port}): {detail}',
  'main.ssh.readKeyFailed': '秘密鍵ファイルを読み取れません {path}: {detail}',

  'main.sftp.sessionGone': 'SSH セッションが存在しないか、切断されています',
  'main.sftp.deleteFailed': '削除に失敗しました: {detail}',
  'main.sftp.invalidMode': '不正なパーミッション値: {mode}',
  'main.sftp.invalidUidGid': '不正な uid/gid',
  'main.sftp.commandExitCode': 'コマンドの終了コード {code}',
  'main.sftp.cancelled': 'キャンセルしました',

  'main.zmodem.transferFailed': '転送に失敗しました',
  'main.zmodem.transferTimeout': '転送がタイムアウトしました',
  'main.zmodem.sendFailed': '送信に失敗しました',
  'main.zmodem.uploadFailed': 'アップロードに失敗しました',
  'main.zmodem.receiveFailed': '受信に失敗しました',
  'main.zmodem.abnormal': 'ZMODEM 転送エラー',
  'main.zmodem.cancelled': 'キャンセルしました',
  'main.zmodem.offerTimedOut': 'ファイルが選択されなかったためキャンセルしました',
  'main.zmodem.sessionInvalid': 'セッションが無効になりました',
  'main.zmodem.sessionCreateFailed': 'ZMODEM セッションを確立できません',
  'main.zmodem.noSaveDir': '保存先ディレクトリが指定されていません',
  'main.zmodem.noFiles': 'ファイルが選択されていません',

  'main.ipc.connectionMissing': '接続ブックマークが見つかりません ({id})',

  'main.sysinfo.sessionGone': 'SSH セッションが存在しないか切断されています',
  'main.sysinfo.execFailed': 'SSH exec に失敗しました',
  'main.sysinfo.parseFailed': '解析に失敗しました: {message}',
  'main.pty.serviceNotReady': 'SSH セッションサービスが未初期化です',
  'main.pty.missingConnectionId': 'SSH セッションに connectionId がありません',
  'main.log.tuiOmitted': '全画面 (TUI) 出力を省略しました'
}

export default main
