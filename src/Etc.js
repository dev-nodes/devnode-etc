import Etc, { HttpProvider } from 'ethjs';
import * as EthereumTx from 'ethereumjs-tx';
import get from 'lodash/get';
import flatten from 'lodash/flatten';
import flatMap from 'lodash/flatMap';
import find from 'lodash/find';
import orderBy from 'lodash/orderBy';
import reduce from 'p-reduce';
import txCache from './Transactions/store';
import { getSettings, setSettings } from './store.js'
import notifier from './notify';
import logger from './logger';
import helpers from './utils';
import config from '../config/production';
import Big from 'big.js';
import { isBN } from 'bn.js';

const EtcTx = EthereumTx.Transaction;

export default class Ethclassic {
  static save() {
    txCache.save();
  }
  constructor(addressManager) {
    this.state = 'ready'
    this.initial = true;
    this.txCache = txCache;
    this.address = addressManager;
    this.txCache.load();
    this.id = 1;
    this.etcJs = new Etc(new HttpProvider(config.HOST))
    this.sweepTimer();
    this.updateBalances();
  }

  waitFor(ms) {
    return new Promise(resolve => {
      setTimeout(resolve, ms)
    })
  }
  async getInfo() {
    const r = await this.address.getMaster();
    const secret = getSettings('secret');
    const payload = {
      Secret: secret,
      WithdrawUrl: `http://${(await helpers.getPubIp()).trim()}:${config.PORT}/withdraw?key=${secret}`,
      WalletMasterAddress: r.address,
      WalletMasterPrivate: r.privateKey,
      WalletMnemonicSeed: r.mnemonic
    }
    return payload;
  }
  async updateBalances() {
    try {
      if (!this.initial) {
        await this.waitFor(75000);
      } else {
        await this.waitFor(10000);
        this.initial = false;
      }
      logger.info('Updating balances')
      this.state = 'updating';
      const res = await this.getAllAddress({ withBalance: false });
      for (const addr of res) {
        let { balance } = await this.getBalance(addr.address);
        balance = Etc.fromWei(balance,'ether') 
        await this.address.setBalance(addr.address, balance);
      }
      this.state = 'ready';
      await this.waitFor(75000);
      this.updateBalances();
    } catch (e) {
      console.error(e)
      logger.error('updateblance',e)
      this.state = 'ready';
      await this.waitFor(75000);
      this.updateBalances();
    }
  }
  async sweepTimer() {
    try {
      await this.waitFor(30000);
      const res = await this.getAllAddress({ withBalance: true });
      const tasks = []
      for (const addr of res) {
        if (addr.balance > 0.1) {
          logger.info('Sweeping', Big(addr.balance).minus(0.1), 'from', addr.address);
          tasks.push(this.transferToMaster(addr.address, true))
        }
      }
      await Promise.all(tasks);
      await this.waitFor(30000);
      this.sweepTimer()
    } catch (e) {
      logger.error('sweepTimer',e);
      await this.waitFor(30000);
      this.sweepTimer()
    }
  }
  async transferToMaster(from, sweep = false) {
    const { address } = await this.address.getMaster();
    const privateKey = await this.address.getPriv(from);
    let { balance } = await this.getBalance(from);
    balance = Etc.fromWei(balance,'ether')
    const amount = parseFloat(Big(balance));
    if (address == from) return false;
    if (sweep || amount > 0.0001) {
      logger.info(`Transferring`, amount, 'to Master address', address, 'from', from)
      const result = await this.sendTrx(address, Etc.toWei(amount), from, privateKey);
      await this.address.setBalance(from, parseFloat(Big(balance).minus(amount)))
      return result
    } else {
      logger.info('Not enough balance(balance-0.1) to transfer', amount);
      logger.info('Manually sweep the balance if you want to transfer');
      return false
    }
  }
  async isContract(address) {
    return (await this.etcJs.getCode(address,"latest")) === "0x";
  }
  toHex(bn) {
    if(!Etc.BN.isBN(bn)) {
      bn = new Etc.BN(String(bn))
    }
    return `0x${bn.toString("hex")}`;
  }
  async txBuilder(to, value, from) {
    let gasLimit = 21000;
    const isContract = await this.isContract(to);
    if(isContract) {
      gasLimit = 105000;
    }
    const txParams = {
      gasPrice: this.toHex(1000000000),
      gasLimit: this.toHex(gasLimit),
      to,
      from,
      value: this.toHex(value),
      data: "0x"
    }
    return new EtcTx(txParams);
  }
  async txSign(unsignedTx, privateKey) {
    privateKey = Buffer.from(privateKey, 'hex');
    const tx = unsignedTx.sign(privateKey);
    const serializedTx = tx.serialize();
    return serializedTx;
  }
  async sendTrx(to, amount, from, privateKey) {
    try {
      const unsignedTx = await this.txBuilder(to, amount, from);
      const signedTx = await this.txSign(unsignedTx, privateKey);
      const result = await this.etcJs.sendRawTransaction(signedTx);
      return {result};
    } catch (e) {
      logger.error('sendtrx',e)
    }
  }

  async send(to, amount) {
    try {
      const { privateKey, address } = await this.address.getMaster();
      const balance = parseFloat(Big(await this.getMasterBalance()).minus(amount));
      if (balance <= 0) {
        return [false]
      }
      amount = this.etcJs.toWei(amount,"ether");

      if (address === to) {
        return [false]
      }
      const r = await this.sendTrx(to, amount, address, privateKey);
      if (r && r.result) {
        await this.waitFor(3000);
        return [true, { transaction_id: r.result }];
      } else {
        return [false]
      }
    } catch (e) {
      logger.error('send',e);
      return [false]
    }
  }
  async verifyTransaction(txid) {
    try {
      await this.waitFor(5000);
      const r = await this.etcJs.getTransactionReceipt(txid);
      return [r.transactionHash === txid];
    } catch (e) {
      if (e == 'Transaction not found') {
        return [false, 'not_found']
      } else {
        return [false, e]
      }
    }
  }

  notify(from, to, txid, amount, id) {
    logger.info(`[${id}]Transaction found`, txid, amount, 'from', from)
    this.txCache.add(txid);
    const payload = {}
    payload.hash = txid;
    payload.amount = amount;
    payload.token = 'ETC';
    payload.from = from;
    payload.to = to;
    notifier(payload, id);
  }
  extractTxFields(tx) {
    const amountWei = tx.value
    const amountEtc = Etc.fromWei(amountWei, 'ether')
    const toAddress = tx.to;
    const fromAddress = tx.from;
    return {
      txid: tx.txID,
      amountEtc,
      toAddress,
      fromAddress,
    }
  }

  async processTx(txInfo, id, retry = 0) {
    if (this.state !== 'ready') {
      try{
        await this.waitFor(5000);
        return this.processTx(txInfo, id, retry)
      }catch(e) {
        console.error("processTx",e.message)
        return this.processTx(txInfo, id, retry)
      }
    }
    if (txInfo && !this.txCache.has(txInfo.txid)) {
      try {
        logger.info('Processing transaction...')
        const [success] = await this.verifyTransaction(txInfo.txid);
        if (success) {
          await this.waitFor(5000)
          const bal = await this.getBalance(txInfo.toAddress)
          await this.address.setBalance(txInfo.toAddress, Etc.fromWei(bal.balance,'ether'));
          this.notify(txInfo.fromAddress, txInfo.toAddress, txInfo.txid, txInfo.amountTrx, id)
        } else {
          retry++;
          if (retry <= 10) {
            logger.info(`[${id}]Txid not found, rechecking in 10 seconds`);
            await this.waitFor(10000)
            this.processTx(txInfo, id, retry)
          }
        }

      } catch (e) {
        logger.error('processTx',e)
        this.txCache.add(txInfo.txid);
      }
    }
  }
  checkAccountFormat(address) {
    return Etc.isAddress(address);
  }

 async getMasterBalance() {
    try {
      const { address } = await this.address.getMaster();
      const result = await this.getBalance(address);
      return Etc.fromWei(result.balance, 'ether');
    } catch (e) {
      logger.error('masterbalance',e)
      return 0;
    }
  }
  async getBalance(address) {

    const res = await this.etcJs.getBalance(address);
    if (!res) return { balance: 0 };

    return { address, balance: res}
  }
  async getNewAddress() {
    const res = await this.address.create();
    return res;
  }

  async getLatestBlockNumber() {
    const currentBlock = await this.etcJs.blockNumber()
    return currentBlock.toNumber()
  }
  async getAllAddress({ withBalance }) {
    try {
      const size = await this.address.lastIndex()
      let addresses = [];
      for (let i = 1; i <= size; i++) {
        const { address, balance } = await this.address.getAddress(i, withBalance)
        const pl = { address };
        if (withBalance) {
          if (balance) {
            pl.balance = balance
            addresses.push(pl)
          }
        } else {
          addresses.push(pl)
        }
      }
      return addresses;
    } catch (e) {
      logger.error('getalladdress',e)
    }
  }
  async getBlockRange(from, to) {
    const payload = [];
    const count = to - from;
    for(var i = 0; i <= count; i++) {
      const r = await this.etcJs.getBlockByNumber(new Etc.BN(from+i), true);
      payload.push(r.transactions);
    }
    return payload;
  }
  async start() {
    try {
      let block = getSettings('block');
      let latestBlock = await this.getLatestBlockNumber();
      let synced = true;
      if (!block) {
        logger.info('Starting at the latest block', latestBlock-10);
        block = latestBlock-10;
      }
      if (latestBlock > block && (latestBlock - block) >= 10) {
        latestBlock = block + Math.min((latestBlock - block), 100);
        synced = false
        logger.info('syncing', block, '-', latestBlock);
        let blockArr;
        try {
            blockArr = await this.getBlockRange(block+1, latestBlock);
        } catch(e) {
            logger.info('retrying to sync')
            return this.start();
        }
        setSettings('block', latestBlock);
        let transactions = flatten(blockArr);
        try{
        transactions = await reduce(transactions, async (result, value) => {
          value = this.extractTxFields(value);

          if (value && await this.address.verify(value.toAddress)) {
            result.push(value);
          }
          return result;
        }, [])
        }catch(e) {
          logger.error('reduce');
          setSettings('block', latestBlock - (latestBlock-block));
          return this.start();
        }
        logger.info("processing " + transactions.length,"transactions")
        for (const txInfo of transactions) {
          this.processTx(txInfo, this.id)
          this.id++;
        }
      }
      if (synced) {
        await this.waitFor(5000)
      }
      this.start();
    } catch (e) {
      this.start();
    }
  }
}
