/** 名前空間: ssh（SSH 接続管理、ホストキー、ファイルパネル、zmodem、システム監視）。担当: SSH。 */
const ssh: Record<string, string> = {
  // 認証方式 / シークレットの種類
  'ssh.auth.password': 'パスワード',
  'ssh.auth.privateKey': '秘密鍵',
  'ssh.auth.agent': 'Agent',
  'ssh.secret.passphrase': 'パスフレーズ',

  // 接続ダイアログ: 認証関連フィールド
  'ssh.fields.agentDesc':
    'ローカルの SSH Agent に読み込み済みの鍵で認証します。本アプリ内に鍵を保存する必要はありません。',
  'ssh.fields.askPasswordLabel': '接続時にパスワードを確認',
  'ssh.fields.askPasswordHint':
    'オンにすると毎回の接続でパスワード入力ダイアログを表示し、保存済みのパスワードを使いません',
  'ssh.fields.passwordPlaceholder': '編集時に空欄のままにすると保存済みのパスワードを保持します',
  'ssh.fields.keyPath': '秘密鍵ファイルのパス（このコンピューター上のパス、省略可）',
  'ssh.fields.keyContent': '秘密鍵の内容',
  'ssh.fields.keyContentPlaceholder':
    '秘密鍵の内容を貼り付けます。空欄の場合は上のパスを使用します（編集時に空欄のままにすると保存済みの秘密鍵を保持します）',
  'ssh.fields.askPassphraseLabel': '接続時にパスフレーズを確認',
  'ssh.fields.askPassphraseHint': 'オンにすると毎回の接続で秘密鍵のパスフレーズ入力を求めます',
  'ssh.fields.passphrase': '秘密鍵のパスフレーズ',
  'ssh.fields.passphrasePlaceholder':
    '編集時に空欄のままにすると保存済みのパスフレーズを保持します',

  // 接続ダイアログ
  'ssh.dialog.titleEdit': '接続を編集',
  'ssh.dialog.titleNew': '新規接続',
  'ssh.dialog.saveFailed': '保存に失敗しました。入力を確認して再試行してください',
  'ssh.dialog.name': '名前',
  'ssh.dialog.nameRequired': '接続名を入力してください',
  'ssh.dialog.namePlaceholder': '例：本番サーバー',
  'ssh.dialog.group': 'グループ',
  'ssh.dialog.groupPlaceholder':
    'グループを選択または入力してください。空欄の場合は「デフォルト」に入ります',
  'ssh.dialog.host': 'ホスト',
  'ssh.dialog.hostRequired': 'ホストアドレスを入力してください',
  'ssh.dialog.hostPlaceholder': '192.168.1.10 または example.com',
  'ssh.dialog.port': 'ポート',
  'ssh.dialog.portRange': 'ポートは 1〜65535 の範囲で指定してください',
  'ssh.dialog.username': 'ユーザー名',
  'ssh.dialog.usernameRequired': 'ユーザー名を入力してください',
  'ssh.dialog.authMethod': '認証方式',
  'ssh.dialog.savedSecret': '{kind}は保存済みです。空欄のままにすると現在の値を使用します',
  'ssh.dialog.keepalive': 'Keepalive 間隔（秒）',
  'ssh.dialog.keepaliveTooltip': '0 で keepalive を無効にします',
  'ssh.dialog.keepaliveMin': '負の値は指定できません',

  // 接続サイドバー
  'ssh.sidebar.defaultGroup': 'デフォルト',
  'ssh.sidebar.timeJustNow': 'たった今',
  'ssh.sidebar.timeMinutesAgo': '{n} 分前',
  'ssh.sidebar.timeHoursAgo': '{n} 時間前',
  'ssh.sidebar.timeDaysAgo': '{n} 日前',
  'ssh.sidebar.modeTerminal': 'ターミナルワークスペース',
  'ssh.sidebar.modeSsh': 'SSH ワークスペース',
  'ssh.sidebar.title': '接続',
  'ssh.sidebar.newConnection': '新規接続',
  'ssh.sidebar.sectionTerminals': 'ターミナル',
  'ssh.sidebar.noLocalTerminals': '開いているローカルターミナルはありません',
  'ssh.sidebar.local': 'ローカル',
  'ssh.sidebar.sectionServers': 'SSH サーバー',
  'ssh.sidebar.empty': '接続がありません。＋ をクリックして作成',
  'ssh.sidebar.loading': '読み込み中…',
  'ssh.sidebar.recent': '最近のセッション',
  'ssh.sidebar.dblClickConnect': '{host} にダブルクリックで接続',
  'ssh.sidebar.deleteTitle': 'この接続を削除しますか？',
  'ssh.sidebar.deleteDesc':
    '削除した接続は復元できません。保存済みの鍵データも同時に削除されます。',

  // ホストキーの確認
  'ssh.hostKey.changedTitle': 'ホストのフィンガープリントが変更されました！',
  'ssh.hostKey.unknownHost': '未知のホスト',
  'ssh.hostKey.accept': '承認して接続',
  'ssh.hostKey.reject': '拒否',
  'ssh.hostKey.mitmTitle': '中間者攻撃の可能性があります',
  'ssh.hostKey.mitmDesc':
    'リモートホストの鍵フィンガープリントが以前の記録と一致しません。ご自身でサーバー鍵を変更していない場合、誰かがこのホストになりすましている可能性があります。',
  'ssh.hostKey.firstConnect':
    'このホストへの初回接続です。フィンガープリントはまだ記録されていません。',
  'ssh.hostKey.target': 'ホスト：{target}',
  'ssh.hostKey.fingerprint': 'フィンガープリント：{fingerprint}',

  // SSH ワークスペース: ファイルパネル、ホストバッジ
  'ssh.bottomPanel.resize': 'ファイルパネルの高さを調整',
  'ssh.hostBadge.aria': 'SSH ホスト {label}',

  // ZMODEM
  'ssh.zmodem.done': 'ZMODEM 転送が完了しました',
  'ssh.zmodem.failed': 'ZMODEM 転送に失敗しました：{message}',
  'ssh.zmodem.unknownError': '不明なエラー',
  'ssh.zmodem.titleReceive': 'ローカルにダウンロード',
  'ssh.zmodem.titleSend': 'サーバーへアップロード',
  'ssh.zmodem.pickDir': '保存先フォルダを選択',
  'ssh.zmodem.pickFiles': 'ファイルを選択',
  'ssh.zmodem.receiveDesc':
    'sz のダウンロード要求を検出しました（リモートがファイルを送信中）。ローカルの保存先フォルダを選択してください。',
  'ssh.zmodem.sendDesc':
    'rz のアップロード要求を検出しました（リモートがファイルを受信中）。アップロードするファイルを選択してください。',

  // ファイルパネル（SFTP）
  'ssh.file.up': '親フォルダへ',
  'ssh.file.refresh': '更新',
  'ssh.file.uploadFile': 'ファイルをアップロード',
  'ssh.file.overwriteTitle': '既存のファイルを上書きしますか？',
  'ssh.file.overwriteDesc': '対象ディレクトリに同名のファイルが存在します。アップロードすると内容が上書きされます。',
  'ssh.file.downloadSelected': '選択項目をダウンロード',
  'ssh.file.permOwner': '権限 / 所有者',
  'ssh.file.open': '開く',
  'ssh.file.download': 'ダウンロード',
  'ssh.file.upload': 'アップロード…',
  'ssh.file.rename': '名前を変更',
  'ssh.file.new': '新規作成',
  'ssh.file.newFolder': '新しいフォルダ',
  'ssh.file.copyPath': 'パスをコピー',
  'ssh.file.copyPathFailed': 'パスのコピーに失敗しました',
  'ssh.file.pathCopied': 'パスをコピーしました',
  'ssh.file.permission': 'ファイル権限…',
  'ssh.file.deleteTitle': '削除しますか？',
  'ssh.file.loading': '読み込み中…',
  'ssh.file.empty': '空のフォルダ',
  'ssh.file.modeUnavailable': '権限を取得できません',
  'ssh.file.folderName': 'フォルダ名',
  'ssh.file.create': '作成',
  'ssh.file.renameTitle': '{name} の名前を変更',
  'ssh.file.permTitle': '権限 · {name}',
  'ssh.file.permApplied': '権限を適用しました',
  'ssh.file.octal': '8 進数',
  'ssh.file.octalPlaceholder': '例：755',
  'ssh.file.keepEmpty': '変更しない場合は空欄',
  'ssh.file.ownerHint': 'UID/GID を空欄にすると所有者を変更しません',
  'ssh.file.permRowOwner': '所有者',
  'ssh.file.permRowGroup': 'グループ',
  'ssh.file.permRowOther': 'その他',
  'ssh.file.permColRead': '読み取り',
  'ssh.file.permColWrite': '書き込み',
  'ssh.file.permColExec': '実行',

  // システム監視
  'ssh.monitor.collecting': '取得中…',
  'ssh.monitor.interrupted': '取得が中断されました：{error}',
  'ssh.monitor.mem': 'メモリ',
  'ssh.monitor.disks': 'ディスク',
  'ssh.monitor.net': 'ネットワーク',
  'ssh.monitor.cores': '{n} コア',
  'ssh.monitor.loadavg': '負荷 {value}',
  'ssh.monitor.uptime': '稼働時間',
  'ssh.monitor.uptimeSeconds': '{n}秒',
  'ssh.monitor.uptimeMinutes': '{n}分',
  'ssh.monitor.uptimeHours': '{h}時間{m}分',
  'ssh.monitor.uptimeDays': '{n}日'
}

export default ssh
