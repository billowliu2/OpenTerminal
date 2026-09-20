import common from './common'
import settings from './settings'
import workspace from './workspace'
import terminal from './terminal'
import ssh from './ssh'
import panels from './panels'
import main from './main'

/** 日本語の文言。名前空間ファイルは領域ごとに分担して保守します。詳細は
 *  src/shared/i18n/index.ts の担当表を参照。 */
export default {
  ...common,
  ...settings,
  ...workspace,
  ...terminal,
  ...ssh,
  ...panels,
  ...main
}
