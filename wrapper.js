

import { AddressManager, generateMnemonic } from './src/Address/address'
import Etc from './src/Etc';
import api from './src/api';
import logger from './src/logger'
const address = new AddressManager();
const etc = new Etc(address);

async function run() {
  logger.info('Checking wallet...')
  let mnemonic = '';
  await address.init();
  const r = await address.mnemonicLoaded();
  if (!r) {
    mnemonic = generateMnemonic()
  } else {
    mnemonic = r.mnemonic;
  }
  logger.info('Loading wallet...')
  await address.load(mnemonic);
  api(etc);
  etc.start();

}
function save() {
  Etc.save();
}
export default { run, save };